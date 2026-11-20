import { recordRefund } from '@shareat/domain';
import { currentSession } from '@/lib/session';
import { fail, guarded, json, POS_UNPAIRED, readCappedText, tabletPairing } from '@/lib/pos-api';
import { withOrgPrincipal } from '@/app/expenses/lib';

export const dynamic = 'force-dynamic';

/**
 * T-534 S4 - refund (part of) a paid receipt, the way it was paid. The paired tablet AND a person session are both required; the store is the pairing's, never a request value.
 * `record_sale` at the store, plus a manager's PIN unless the signed-in person already holds `approve_pos_correction`: the domain judges both. Online only (no outbox kind).
 * Body `{ requestId, receiptId, lines: [{ receiptLineId, qty }], payments: [{ paymentId, tenderId?, amount, referenceNo? }], reason, pin? }`.
 * 200 `{ ok, wrote, id, refundNo, total, slip }` (`wrote:false` on a replay of the same requestId, the slip is the same); 409 with a refusal sentence (over the quantity, over a payment,
 * no reference); 401 for no session / no tablet / a wrong PIN; 403 for a person without `record_sale`.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded('refunds', async () => {
    const session = await currentSession();
    if (!session) return fail(401, 'Sign in to refund a receipt.');
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== session.actor.orgId) return fail(401, POS_UNPAIRED);
    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'Send the refund as application/json.');
    let body: { requestId?: unknown; receiptId?: unknown; lines?: unknown; payments?: unknown; reason?: unknown; pin?: unknown };
    try {
      body = JSON.parse(await readCappedText(req));
    } catch (err) {
      if (err instanceof SyntaxError) return fail(400, 'The request body is not valid JSON.');
      throw err;
    }
    if (typeof body?.requestId !== 'string' || typeof body.receiptId !== 'string') return fail(400, 'Pick the receipt and send the request id.');
    if (!Array.isArray(body.lines) || !body.lines.every((l) => l && typeof l.receiptLineId === 'string' && typeof l.qty === 'number')) return fail(400, 'Pick the items and how many of each.');
    if (!Array.isArray(body.payments) || !body.payments.every((p) => p && typeof p.paymentId === 'string' && (typeof p.amount === 'string' || typeof p.amount === 'number') && (p.referenceNo === undefined || p.referenceNo === null || typeof p.referenceNo === 'string') && (p.tenderId === undefined || typeof p.tenderId === 'string'))) {
      return fail(400, 'Say how the money goes back.');
    }
    if (typeof body.reason !== 'string') return fail(400, 'Give a reason.');
    if (body.pin !== undefined && body.pin !== null && typeof body.pin !== 'string') return fail(400, 'The PIN must be text.');
    const { actor } = session;
    const lines = (body.lines as { receiptLineId: string; qty: number }[]).map((l) => ({ receiptLineId: l.receiptLineId, qty: l.qty }));
    const payments = (body.payments as { paymentId: string; tenderId?: string; amount: string | number; referenceNo?: string | null }[]).map((p) => ({ paymentId: p.paymentId, ...(p.tenderId ? { tenderId: p.tenderId } : {}), amount: String(p.amount), referenceNo: p.referenceNo ?? null }));
    const out = await withOrgPrincipal(actor.orgId, (tx) =>
      recordRefund(tx, actor, {
        storeId: pairing.storeId, pairingId: pairing.pairingId, requestId: body.requestId as string, receiptId: body.receiptId as string, lines, payments, reason: body.reason as string,
        ...(typeof body.pin === 'string' && body.pin !== '' ? { approval: { pin: body.pin } } : {}),
      }),
    );
    return json(200, { ok: true, ...out });
  });
}
