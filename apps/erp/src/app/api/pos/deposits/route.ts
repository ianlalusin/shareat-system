import { closeReservation, keepDeposit, refundDeposit, voidDeposit } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * T-628 - the manager's money actions on a reservation deposit: void, refund, keep, and close a reservation (a close with money held carries the refund-or-keep choice).
 * ONLINE ONLY: there is no outbox kind for any of them. The paired tablet AND a person session are both required; the store is the pairing's, never a request value.
 * `record_sale` at the store, plus a manager's PIN unless the signed-in person already holds `approve_pos_correction` there: the domain judges both (`postSaleApprover`).
 * Body `{ action: 'void' | 'refund' | 'keep' | 'close', reservationId, depositId (the event's own device-made id), reason, voidsDepositId?, amount?, tenderId?, referenceNo?,
 *         resolution?: { choice: 'refund' | 'keep', eventId, reason, tenderId?, referenceNo? }, pin? }`.
 * 200 `{ ok, wrote, id? }` (`wrote:false` on a replay); 409 with a refusal sentence; 401 for no session / no tablet / a wrong PIN; 403 for a person without `record_sale`.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('deposits', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to settle a deposit.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the request as application/json.');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readCappedText(req)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const action = text(body?.action);
    const reservationId = text(body?.reservationId);
    if (!action || !['void', 'refund', 'keep', 'close'].includes(action)) return fail(400, 'Say what to do with the deposit.');
    if (!reservationId) return fail(400, 'Pick the reservation.');
    if (body.pin !== undefined && body.pin !== null && typeof body.pin !== 'string') return fail(400, 'The PIN must be text.');
    const pin = typeof body.pin === 'string' && body.pin !== '' ? { approval: { pin: body.pin } } : {};
    const { actor } = session;
    const at = { storeId: pairing.storeId, pairingId: pairing.pairingId, reservationId };
    const out = await withOrgPrincipal(actor.orgId, async (tx) => {
      if (action === 'close') {
        const r = body.resolution as Record<string, unknown> | undefined;
        const resolution =
          r && typeof r === 'object' && (r.choice === 'refund' || r.choice === 'keep') && typeof r.eventId === 'string' && typeof r.reason === 'string'
            ? { choice: r.choice as 'refund' | 'keep', eventId: r.eventId, reason: r.reason, ...(typeof r.tenderId === 'string' ? { tenderId: r.tenderId } : {}), ...(typeof r.referenceNo === 'string' ? { referenceNo: r.referenceNo } : {}) }
            : undefined;
        return closeReservation(tx, actor, { ...at, ...(resolution ? { resolution } : {}), ...pin });
      }
      const depositId = text(body.depositId);
      const reason = text(body.reason);
      if (!depositId || reason === undefined) throw Object.assign(new Error('bad'), { status: 400 });
      if (action === 'void') return voidDeposit(tx, actor, { ...at, depositId, reason, voidsDepositId: text(body.voidsDepositId) ?? '', ...pin });
      if (action === 'refund') {
        return refundDeposit(tx, actor, { ...at, depositId, reason, amount: String(body.amount ?? ''), tenderId: text(body.tenderId) ?? '', referenceNo: text(body.referenceNo) ?? null, ...pin });
      }
      return keepDeposit(tx, actor, { ...at, depositId, reason, amount: String(body.amount ?? ''), ...pin });
    }).catch((err: unknown) => {
      if ((err as { status?: number })?.status === 400) return null;
      throw err;
    });
    if (out === null) return fail(400, 'Send the deposit id and a reason.');
    return json(200, { ok: true, ...out });
  });
}
