import 'server-only';
/**
 * T-424 S7 - POST /api/pos2/tender-corrections. docs/tasks/424-pos-v2-server-approvals.md Ruling 7, Acceptance 6 and 7.
 *
 * A correction MOVES money between payment methods on the RECEIPT's day. It writes ONE `paymentConversions/{requestId}` document in v1's
 * exact shape (plus receiptId, reference, requestedBy, approvedByPersonId, source 'pos2-correction') and moves `payments.byMethod` on the
 * receipt's day / month / year / preset docs exactly as v1's applyPaymentConversionServer. `totalGross` and `txCount` are untouched and the
 * receipt document is NEVER written (row 272).
 *
 * Refused unless: the receipt is final and not a refund; `amount` (integer centavos, > 0) fits within what the receipt took in `fromMethod`
 * net of this receipt's active corrections (read in the same transaction, so stacked corrections can never drive a method negative);
 * `toMethod` is an active store method with a different name; a reference when the method needs one; an ERP till shift is open for the store
 * and opened no later than the sale's own clock (A5.1, row 319). Idempotent on `requestId` (a different body on the same id is refused).
 */
import { storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { getDayIdFromTimestamp, getDayStartMs } from '@/lib/analytics/daily';
import { requireManagerApproval } from './approval';
import { Refusal, bodyHash, fail, guarded, isNonBlank, isUuid, jsonResponse } from './http';
import { authenticate } from './identity';
import { writeByMethodDelta } from './payment-conversion';
import type { Pos2Deps } from './types';

export const NO_OPEN_SHIFT = 'Shift closed: refund and ring again. A tender can only be corrected while the till shift is open.';
export const SHIFT_AFTER_SALE = 'Shift closed: refund and ring again. This sale was rung before the current till shift opened.';

const norm = (s: string) => s.trim().toLowerCase();

export async function handleTenderCorrection(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const b = caller.body;
    const storeId = caller.storeId;

    const receiptId = b.receiptId;
    const amount = b.amount;
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    const reference = typeof b.reference === 'string' ? b.reference.trim() : '';
    if (!isNonBlank(receiptId) || receiptId.includes('/')) return fail(400, 'Choose the receipt to correct.');
    if (!isNonBlank(b.fromMethod) || !isNonBlank(b.toMethod)) return fail(400, 'Choose the method the money is moving from and to.');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return fail(400, 'The amount must be a whole number of centavos, more than zero.');
    if (!isUuid(b.requestId)) return fail(400, 'The request id is missing. Try again.');
    if (!reason) return fail(400, 'Say why the tender is being corrected.');
    const fromMethod = b.fromMethod.trim();
    const toMethod = b.toMethod.trim();
    const requestId = b.requestId.toLowerCase();
    if (norm(fromMethod) === norm(toMethod)) return fail(409, 'The money has to move to a different payment method.');

    const requestHash = await bodyHash({ storeId, receiptId, fromMethod, toMethod, amount, reference, reason });

    const db = deps.db;
    const nowMs = deps.nowMs();
    const FV = db.FieldValue;
    const conversionsPath = `stores/${storeId}/paymentConversions`;

    // A retry of a request that already succeeded returns the first document WITHOUT asking for the PIN again and without a transaction.
    const prevSnap = await db.doc(`${conversionsPath}/${requestId}`).get();
    if (prevSnap.exists) {
      const prev = prevSnap.data() as Record<string, any>;
      if (prev.requestHash === requestHash && prev.source === 'pos2-correction') return jsonResponse(200, { ok: true, conversionId: requestId, replayed: true });
      return fail(409, 'That request id was already used for a different correction.');
    }

    // The till shift: no open shift => no correction (A5.1). Checked before the PIN so a closed till never costs a PIN attempt.
    const shift = await deps.openTillShift(storeId);
    if (!shift) return fail(409, NO_OPEN_SHIFT);

    const approval = await requireManagerApproval(deps, { storeId, deviceId: b.deviceId, pin: b.pin });
    if (!approval.ok) return approval.response;

    const result = await db.runTransaction(async (tx) => {
      // ---- reads ----
      const conversionRef = db.doc(`${conversionsPath}/${requestId}`);
      const receiptRef = db.doc(`stores/${storeId}/receipts/${receiptId}`);
      const receiptSnap = await tx.get(receiptRef);
      const existingSnap = await tx.get(conversionRef);
      if (existingSnap.exists) {
        const prev = existingSnap.data() as Record<string, any>;
        if (prev.requestHash === requestHash && prev.source === 'pos2-correction') return { replayed: true as const };
        throw new Refusal(409, 'That request id was already used for a different correction.');
      }
      if (!receiptSnap.exists) throw new Refusal(404, 'That receipt was not found.');
      const receipt = receiptSnap.data() as Record<string, any>;
      if (receipt.status !== 'final' || receipt.isRefund === true) throw new Refusal(409, 'Only a paid sale can have its tender corrected.');

      const soldAtMs = Number(receipt.createdAtClientMs);
      if (!Number.isFinite(soldAtMs)) throw new Refusal(409, 'That receipt has no sale time, so it cannot be corrected.');
      if (shift.openedAtMs > soldAtMs) throw new Refusal(409, SHIFT_AFTER_SALE);

      const methodsSnap = await tx.get(db.collection(`stores/${storeId}/storeModesOfPayment`).limit(200));
      const priorSnap = await tx.get(db.collection(conversionsPath).where('receiptId', '==', receiptId));

      // ---- checks ----
      const toDoc = methodsSnap.docs.map((d: any) => d.data() as Record<string, any>).find((m: Record<string, any>) => norm(String(m.name ?? '')) === norm(toMethod));
      if (!toDoc || toDoc.isActive === false || toDoc.isArchived === true) throw new Refusal(409, 'That payment method is not available.');
      if (toDoc.hasRef === true && !reference) throw new Refusal(409, `${String(toDoc.name)} needs a reference number.`);

      const mop = ((receipt.analytics as Record<string, any> | undefined)?.mop ?? {}) as Record<string, unknown>;
      const mopKey = Object.keys(mop).find((k) => k === fromMethod) ?? Object.keys(mop).find((k) => norm(k) === norm(fromMethod));
      let available = mopKey ? storedPesosToCentavos(mop[mopKey]) : 0;
      for (const d of priorSnap.docs) {
        const c = d.data() as Record<string, any>;
        if (c.status !== 'active' || c.source !== 'pos2-correction') continue;
        const cents = storedPesosToCentavos(c.amount);
        if (norm(String(c.fromMethod)) === norm(fromMethod)) available -= cents;
        if (norm(String(c.toMethod)) === norm(fromMethod)) available += cents;
      }
      if (available <= 0) throw new Refusal(409, `This receipt has no ${fromMethod} payment left to move.`);
      if (amount > available) throw new Refusal(409, `Only ${(available / 100).toFixed(2)} of ${fromMethod} is left on this receipt to move.`);

      // ---- writes ----
      const dayId = getDayIdFromTimestamp(soldAtMs);
      const dayStartMs = getDayStartMs(soldAtMs);
      const pesos = toWirePesos(amount);
      const fromName = mopKey ?? fromMethod;
      // Optimistic-concurrency slot (see refunds.ts): two corrections of one receipt that counted the same earlier ones create the same slot,
      // so the second commit fails (409) and no method can be driven negative by a race.
      tx.create(db.doc(`stores/${storeId}/pos2Slots/correction__${receiptId}__${priorSnap.docs.length + 1}`), { kind: 'correction', receiptId, conversionId: requestId, createdAt: FV.serverTimestamp() });
      tx.create(conversionRef, {
        storeId,
        dayId,
        dayStartMs,
        amount: pesos,
        fromMethod: fromName,
        toMethod: String(toDoc.name),
        note: reason,
        reason,
        status: 'active',
        createdBy: { uid: caller.uid, name: caller.name, role: caller.role || null },
        createdAt: FV.serverTimestamp(),
        createdAtClientMs: nowMs,
        voidedAt: null,
        voidedBy: null,
        receiptId,
        reference: reference || null,
        requestedBy: { uid: caller.uid, name: caller.name },
        approvedByPersonId: approval.approverPersonId,
        source: 'pos2-correction',
        requestHash,
      });
      writeByMethodDelta(tx, db, storeId, dayId, dayStartMs, fromName, String(toDoc.name), pesos, 1, new Date(nowMs));
      return { replayed: false as const };
    });

    return jsonResponse(200, { ok: true, conversionId: requestId, replayed: result.replayed });
  });
}
