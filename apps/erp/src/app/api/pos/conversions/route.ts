import { recordConversion } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * T-534 S2 - record a Convert (GCash cash-in / cash-out). The paired tablet AND a person session are both required; the store is the pairing's, never a request value.
 * Capability `record_sale` at the store, NO PIN (T-427 ruling, as v1): the domain judges it. Online only (no outbox kind).
 * Body `{ requestId, fromTenderId, toTenderId, amount, note? }`: From is the money that leaves, To the money that comes in. 200 `{ ok, wrote, id }` (`wrote:false` on a
 * replay of the same requestId); 409 with a refusal sentence; 401 for no session / no tablet; 403 for a person without `record_sale`.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('conversions', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to record a Convert.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the Convert as application/json.');
    let body: { requestId?: unknown; fromTenderId?: unknown; toTenderId?: unknown; amount?: unknown; note?: unknown };
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    if (typeof body?.requestId !== 'string' || typeof body.fromTenderId !== 'string' || typeof body.toTenderId !== 'string') return fail(400, 'Pick the two payment methods and send the request id.');
    if (typeof body.amount !== 'string' && typeof body.amount !== 'number') return fail(400, 'Type the amount.');
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return fail(400, 'The note must be text.');
    const { actor } = session;
    const out = await withOrgPrincipal(actor.orgId, (tx) =>
      recordConversion(tx, actor, {
        storeId: pairing.storeId, pairingId: pairing.pairingId, requestId: body.requestId as string, fromTenderId: body.fromTenderId as string,
        toTenderId: body.toTenderId as string, amount: String(body.amount), note: (body.note as string | null | undefined) ?? null,
      }),
    );
    return json(200, { ok: true, ...out });
  });
}
