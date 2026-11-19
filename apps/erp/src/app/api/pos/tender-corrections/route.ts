import { recordTenderCorrection } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * T-534 S3 - fix a wrong payment method on a receipt that is not yet in a Z. The paired tablet AND a person session are both required; the store is the pairing's, never a
 * request value. `record_sale` at the store, plus a manager's PIN unless the signed-in person already holds `approve_pos_correction`: the domain judges both. Online only
 * (no outbox kind). Body `{ requestId, receiptId, paymentId, toTenderId, amount, referenceNo?, reason, pin? }`. 200 `{ ok, wrote, id }` (`wrote:false` on a replay of the
 * same requestId); 409 with a refusal sentence (after the Z, over the amount, no reference); 401 for no session / no tablet / a wrong PIN; 403 for a person without `record_sale`.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('tender-corrections', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to correct a payment method.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the correction as application/json.');
    let body: { requestId?: unknown; receiptId?: unknown; paymentId?: unknown; toTenderId?: unknown; amount?: unknown; referenceNo?: unknown; reason?: unknown; pin?: unknown };
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    if (typeof body?.requestId !== 'string' || typeof body.receiptId !== 'string' || typeof body.paymentId !== 'string' || typeof body.toTenderId !== 'string') {
      return fail(400, 'Pick the receipt, the payment and the new payment method, and send the request id.');
    }
    if (typeof body.amount !== 'string' && typeof body.amount !== 'number') return fail(400, 'Type the amount.');
    if (typeof body.reason !== 'string') return fail(400, 'Give a reason.');
    if (body.referenceNo !== undefined && body.referenceNo !== null && typeof body.referenceNo !== 'string') return fail(400, 'The reference number must be text.');
    if (body.pin !== undefined && body.pin !== null && typeof body.pin !== 'string') return fail(400, 'The PIN must be text.');
    const { actor } = session;
    const out = await withOrgPrincipal(actor.orgId, (tx) =>
      recordTenderCorrection(tx, actor, {
        storeId: pairing.storeId, pairingId: pairing.pairingId, requestId: body.requestId as string, receiptId: body.receiptId as string, paymentId: body.paymentId as string,
        toTenderId: body.toTenderId as string, amount: String(body.amount), referenceNo: (body.referenceNo as string | null | undefined) ?? null, reason: body.reason as string,
        ...(typeof body.pin === 'string' && body.pin !== '' ? { approval: { pin: body.pin } } : {}),
      }),
    );
    return json(200, { ok: true, ...out });
  });
}
