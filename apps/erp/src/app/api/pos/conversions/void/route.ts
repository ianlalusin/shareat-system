import { voidConversion } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * T-534 S2 - void a Convert that is not yet in a Z. The paired tablet AND a person session are required. `record_sale` at the store, and the domain lets only the person
 * who recorded it, or a holder of `approve_pos_correction`, void. Body `{ conversionId, reason? }`. 200 `{ ok, wrote }` (`wrote:false` when it was already voided);
 * 409 with a refusal sentence (after the Z, not yours to void). Online only.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('conversions-void', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to void a Convert.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the request as application/json.');
    let body: { conversionId?: unknown; reason?: unknown };
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    if (typeof body?.conversionId !== 'string') return fail(400, 'Say which Convert to void.');
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') return fail(400, 'The reason must be text.');
    const { actor } = session;
    const out = await withOrgPrincipal(actor.orgId, (tx) =>
      voidConversion(tx, actor, { storeId: pairing.storeId, pairingId: pairing.pairingId, conversionId: body.conversionId as string, reason: (body.reason as string | null | undefined) ?? null }),
    );
    return json(200, { ok: true, ...out });
  });
}
