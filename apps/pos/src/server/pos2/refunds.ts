import 'server-only';
/**
 * T-424 S6 - POST /api/pos2/refunds. docs/tasks/424-pos-v2-server-approvals.md Ruling 6, Acceptance 5 and 6.
 *
 * One Admin-SDK transaction: re-read the parent (final, not a refund), COUNT the refunds it already has (never the client-writable counters on
 * the parent), refuse any line above what is left, price each unit as its share of what the customer actually PAID (`allocate` over line
 * nets, the last unit of a line takes the remainder, so all refunds of a receipt can never exceed its total: DEF-590), write the refund in
 * v1's shape (positive-qty clones, negative `total`, `isRefund`, `parentReceiptId`, NO `analytics.mop`) plus `refundTender` (DEF-588),
 * `refundTotalCentavos` and `approvedByPersonId`, bump the parent's counters as v1 does, and apply the refund's analytics in the SAME
 * transaction. Always a manager PIN. Cash only until the ERP day feed reads `refundTender` (T-375).
 *
 * Idempotent on `receiptNumber`: a retry of the same request (the body hash leaves out the PIN) returns the same refund and pays nothing twice.
 */
import { storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { netQtyOf, paidShares, unitsRefundCentavos } from '@/lib/money/refundShare';
import { formatTerminalReceiptNumber } from '@/lib/terminal/counter';
import { requireManagerApproval } from './approval';
import { Refusal, bodyHash, fail, guarded, isNonBlank, jsonResponse } from './http';
import { authenticate } from './identity';
import { applyAnalyticsDeltaServer } from './analytics/apply-delta-core';
import type { Pos2Deps } from './types';

export const CASH_ONLY_MESSAGE = 'E-wallet refunds come later; refund in cash for now.';

interface RefundLineAsk {
  lineId: string;
  qty: number;
}

function parseLines(raw: unknown): RefundLineAsk[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const out: RefundLineAsk[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const { lineId, qty } = item as Record<string, unknown>;
    if (!isNonBlank(lineId) || typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty < 1) return null;
    if (seen.has(lineId)) return null;
    seen.add(lineId);
    out.push({ lineId, qty });
  }
  return out;
}

const netQty = (l: any): number => netQtyOf(l ?? {});

export async function handleRefund(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const b = caller.body;
    const storeId = caller.storeId;

    const parentId = b.parentReceiptId;
    const lines = parseLines(b.lines);
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    const terminalNo = b.terminalNo;
    const terminalSeq = b.terminalSeq;
    if (!isNonBlank(parentId) || parentId.includes('/')) return fail(400, 'Choose the receipt to refund.');
    if (!lines) return fail(400, 'Choose at least one item to refund, with a whole quantity of 1 or more.');
    if (!isNonBlank(b.tenderMethodId) || b.tenderMethodId.includes('/')) return fail(400, 'Choose how the refund is paid.');
    if (!reason) return fail(400, 'Say why this is being refunded.');
    if (typeof terminalNo !== 'number' || !Number.isInteger(terminalNo) || terminalNo < 1 || terminalNo > 99) return fail(400, 'This tablet has no terminal number yet. Set it up in Settings.');
    if (typeof terminalSeq !== 'number' || !Number.isInteger(terminalSeq) || terminalSeq < 1 || terminalSeq > 999_999) return fail(400, 'The refund receipt number is not valid.');
    if (!isNonBlank(b.receiptNumber)) return fail(400, 'The refund receipt number is missing.');
    const receiptNumber = b.receiptNumber.trim();
    const tenderMethodId = b.tenderMethodId;

    // The "same request" fingerprint: everything but the PIN and the device id (a manager retyping the PIN must not turn a safe retry into a refusal).
    const requestHash = await bodyHash({
      storeId, parentReceiptId: parentId, lines: [...lines].sort((x, y) => x.lineId.localeCompare(y.lineId)), tenderMethodId, reason, terminalNo, terminalSeq, receiptNumber,
    });

    const db = deps.db;
    const nowMs = deps.nowMs();
    const FV = db.FieldValue;
    const receiptsPath = `stores/${storeId}/receipts`;

    // A retry of a request that already succeeded (a timed-out tablet) returns the same refund WITHOUT asking for the PIN again and without
    // opening a transaction: nothing is written, nothing is paid twice. The transaction below re-checks it, so a racing pair still resolves.
    const replay = await findReplay(db, receiptsPath, storeId, receiptNumber, parentId, requestHash);
    if (replay) return jsonResponse(200, { ok: true, replayed: true, ...replay });

    const approval = await requireManagerApproval(deps, { storeId, deviceId: b.deviceId, pin: b.pin, terminalNo });
    if (!approval.ok) return approval.response;

    const result = await db.runTransaction(async (tx) => {
      // ---- reads (all before any write) ----
      const parentRef = db.doc(`${receiptsPath}/${parentId}`);
      const [parentSnap, storeSnap, tenderSnap, numberSnap] = [
        await tx.get(parentRef),
        await tx.get(db.doc(`stores/${storeId}`)),
        await tx.get(db.doc(`stores/${storeId}/storeModesOfPayment/${tenderMethodId}`)),
        await tx.get(db.doc(`stores/${storeId}/receiptNumbers/${receiptNumber}`)),
      ];
      if (!parentSnap.exists) throw new Refusal(404, 'That receipt was not found.');
      const parent = parentSnap.data() as Record<string, any>;
      if (parent.status !== 'final' || parent.isRefund === true) throw new Refusal(409, 'Only a paid sale can be refunded.');
      if (parent.storeId && parent.storeId !== storeId) throw new Refusal(409, 'That receipt belongs to another store.');

      // The receipt number: replay of the same request, or refused.
      if (numberSnap.exists) {
        const prev = (numberSnap.data() ?? {}) as Record<string, any>;
        const prevRefundSnap = prev.receiptId ? await tx.get(db.doc(`${receiptsPath}/${prev.receiptId}`)) : null;
        const prevRefund = prevRefundSnap?.exists ? (prevRefundSnap.data() as Record<string, any>) : null;
        if (prevRefund && prevRefund.isRefund === true && prevRefund.parentReceiptId === parentId && prevRefund.requestHash === requestHash) {
          return { replayed: true as const, refundReceiptId: String(prev.receiptId), refundTotalCentavos: Number(prevRefund.refundTotalCentavos ?? 0), receiptNumber };
        }
        throw new Refusal(409, 'That receipt number is already used by another receipt.');
      }
      const sameNumber = await tx.get(db.collection(receiptsPath).where('receiptNumber', '==', receiptNumber).limit(1));
      if (sameNumber.docs.length > 0) throw new Refusal(409, 'That receipt number is already used by another receipt.');

      const storeCode = storeSnap.exists ? String((storeSnap.data() as any)?.code ?? '') : '';
      let expectedNumber: string;
      try {
        expectedNumber = formatTerminalReceiptNumber(storeCode, terminalNo, terminalSeq);
      } catch {
        throw new Refusal(409, 'This store has no code, so a receipt number cannot be made. Set the store code first.');
      }
      if (receiptNumber !== expectedNumber) throw new Refusal(400, 'The refund receipt number does not match this tablet and store.');

      // Cash only (the ERP derives every refund as cash until it reads refundTender).
      if (!tenderSnap.exists) throw new Refusal(409, 'That payment method is not available.');
      const tender = tenderSnap.data() as Record<string, any>;
      if (tender.isActive === false || tender.isArchived === true) throw new Refusal(409, 'That payment method is not available.');
      if (tender.type !== 'cash') throw new Refusal(409, CASH_ONLY_MESSAGE);

      // COUNT the refunds that already exist for this parent (never the client-writable counters on the parent).
      const existing = await tx.get(db.collection(receiptsPath).where('parentReceiptId', '==', parentId));
      const refunded = new Map<string, number>();
      for (const d of existing.docs) {
        const r = d.data() as Record<string, any>;
        if (r.isRefund !== true || r.status === 'voided') continue;
        for (const l of Array.isArray(r.lines) ? r.lines : []) refunded.set(String(l.id), (refunded.get(String(l.id)) ?? 0) + netQty(l));
      }

      // ---- the maths: each unit is its share of what was PAID ----
      const parentLines: any[] = Array.isArray(parent.lines) ? parent.lines : [];
      const shares = paidShares(parentLines, parent.total);
      if (!shares) throw new Refusal(409, 'Nothing on that receipt can be refunded.');

      let refundC = 0;
      const clones: Record<string, any>[] = [];
      for (const ask of lines) {
        const i = parentLines.findIndex((l) => String(l.id) === ask.lineId);
        if (i < 0) throw new Refusal(409, 'One of those items is not on the receipt.');
        const line = parentLines[i];
        const q = netQty(line);
        const already = refunded.get(ask.lineId) ?? 0;
        if (ask.qty > q - already) throw new Refusal(409, `Only ${Math.max(0, q - already)} of ${String(line.itemName ?? 'this item')} can still be refunded.`);
        refundC += unitsRefundCentavos(parentLines, shares, i, already, ask.qty);
        clones.push({ ...line, qtyOrdered: ask.qty, freeQty: 0, voidedQty: 0 });
      }
      if (refundC <= 0) throw new Refusal(409, 'Those items add up to nothing to refund.');
      // Money cap besides the unit counts: every refund of one receipt together may never exceed what the customer paid.
      let refundedSoFarC = 0;
      for (const d of existing.docs) {
        const r = d.data() as Record<string, any>;
        if (r.isRefund === true && r.status !== 'voided') refundedSoFarC += storedPesosToCentavos(Math.abs(Number(r.total ?? 0)));
      }
      if (refundedSoFarC + refundC > storedPesosToCentavos(parent.total)) {
        throw new Refusal(409, 'Refunding this would pay back more than the customer paid for this receipt.');
      }
      const refundPesos = toWirePesos(refundC);

      // ---- writes ----
      // Deterministic from the receipt number: the number is unique per tablet series (the numbers doc is CREATED, never set), so a retry maps to
      // the same document and two refunds can never share an id. (`deps.newId` is not used for a refund.)
      const refundId = `rf-${receiptNumber}`;
      const refundRef = db.doc(`${receiptsPath}/${refundId}`);
      const refundDoc = stripUndefined({
        id: refundId,
        receiptId: refundId,
        parentReceiptId: parentId,
        isRefund: true,
        storeId,
        sessionId: parent.sessionId,
        createdByUid: caller.uid,
        createdByUsername: caller.username ?? caller.name,
        sessionMode: parent.sessionMode,
        tableId: parent.tableId,
        tableNumber: parent.tableNumber,
        customerName: parent.customerName,
        customerTin: parent.customerTin,
        customerAddress: parent.customerAddress,
        lines: clones,
        total: -refundPesos,
        totalPaid: -refundPesos,
        change: 0,
        status: 'final',
        receiptSeq: terminalSeq,
        receiptNumber,
        receiptNoFormatUsed: 'TERMINAL',
        terminalNo,
        terminalSeq,
        deviceId: typeof b.deviceId === 'string' ? b.deviceId.toLowerCase() : undefined,
        editReason: reason,
        refundTender: { methodId: tenderMethodId, methodName: String(tender.name ?? '') },
        refundTotalCentavos: refundC,
        approvedByPersonId: approval.approverPersonId,
        requestHash,
        analyticsApplied: true,
        analyticsAppliedAt: FV.serverTimestamp(),
        createdAt: FV.serverTimestamp(),
        createdAtClientMs: nowMs,
      });
      tx.create(refundRef, refundDoc);
      // Optimistic-concurrency slot: two refunds of one receipt that both counted the same number of earlier refunds both CREATE the same
      // slot, so the second commit fails (answered 409) even where a transactional query read cannot see a refund committed meanwhile.
      tx.create(db.doc(`stores/${storeId}/pos2Slots/refund__${parentId}__${existing.docs.length + 1}`), { kind: 'refund', receiptId: parentId, refundId, createdAt: FV.serverTimestamp() });
      tx.create(db.doc(`stores/${storeId}/receiptNumbers/${receiptNumber}`), { receiptId: refundId, terminalNo, terminalSeq, createdAt: FV.serverTimestamp() });

      const parentUpdate: Record<string, unknown> = { totalRefunded: FV.increment(refundPesos), refundCount: FV.increment(1) };
      for (const ask of lines) parentUpdate[`refundedQtys.${ask.lineId}`] = FV.increment(ask.qty);
      tx.update(parentRef, parentUpdate);

      // The refund's analytics, in the same transaction (server clock; the tablet no longer calls v1's apply-delta for refunds).
      applyAnalyticsDeltaServer(db, storeId, null, { ...refundDoc, createdAt: new Date(nowMs) } as any, tx, new Date(nowMs));

      return { replayed: false as const, refundReceiptId: refundId, refundTotalCentavos: refundC, receiptNumber };
    });

    return jsonResponse(200, { ok: true, ...result });
  });
}

async function findReplay(
  db: Pos2Deps['db'],
  receiptsPath: string,
  storeId: string,
  receiptNumber: string,
  parentId: string,
  requestHash: string,
): Promise<{ refundReceiptId: string; refundTotalCentavos: number; receiptNumber: string } | null> {
  const numberSnap = await db.doc(`stores/${storeId}/receiptNumbers/${receiptNumber}`).get();
  if (!numberSnap.exists) return null;
  const prevId = (numberSnap.data() as Record<string, any> | undefined)?.receiptId;
  if (!prevId) return null;
  const refundSnap = await db.doc(`${receiptsPath}/${prevId}`).get();
  const refund = refundSnap.exists ? (refundSnap.data() as Record<string, any>) : null;
  if (!refund || refund.isRefund !== true || refund.parentReceiptId !== parentId || refund.requestHash !== requestHash) return null;
  return { refundReceiptId: String(prevId), refundTotalCentavos: Number(refund.refundTotalCentavos ?? 0), receiptNumber };
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
