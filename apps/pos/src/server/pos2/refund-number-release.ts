import 'server-only';
/**
 * T-474 (DEF-756) - POST /api/pos2/refund-numbers/release. docs/tasks/474-pos-refund-final-outcome-and-z-fixes.md Finding 5.
 *
 * A tablet may call a reserved refund number "unused" only after the server has CLOSED it: the document stores/{s}/receiptNumbers/{number} is
 * created here with `released: true` in one transaction. The refund transaction (refunds.ts) reads that same document and `tx.create`s it, so a
 * refund can never commit with a closed number, and a release can never close a number a refund already used (it answers `used`). Moves no money,
 * so no PIN. Idempotent.
 */
import { formatTerminalReceiptNumber } from '@/lib/terminal/counter';
import { Refusal, fail, guarded, isNonBlank, isUuid, jsonResponse } from './http';
import { DEVICE_ID_MISSING } from './approval';
import { authenticate } from './identity';
import { requireRole } from './roles';
import type { Pos2Deps } from './types';

const ROLES = ['admin', 'manager', 'cashier'] as const;
/** T-477: how far above the terminal's highest existing receipt number a release may reach (the same size as claim.ts RELEASE_GAP). */
const RELEASE_WINDOW = 1000;

export async function handleRefundNumberRelease(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const denied = requireRole(caller, ROLES);
    if (denied) return denied;
    const b = caller.body;
    const storeId = caller.storeId;
    const { terminalNo, terminalSeq } = b;
    if (typeof terminalNo !== 'number' || !Number.isInteger(terminalNo) || terminalNo < 1 || terminalNo > 99) return fail(400, 'This tablet has no terminal number yet. Set it up in Settings.');
    if (typeof terminalSeq !== 'number' || !Number.isInteger(terminalSeq) || terminalSeq < 1 || terminalSeq > 999_999) return fail(400, 'The refund receipt number is not valid.');
    if (!isNonBlank(b.receiptNumber)) return fail(400, 'The refund receipt number is missing.');
    const receiptNumber = b.receiptNumber.trim();
    if (receiptNumber.includes('/')) return fail(400, 'The refund receipt number is not valid.');
    // T-477 (DEF-771): only the tablet registered for this terminal may close its numbers. The link comes from ERP, never from Firestore claim docs.
    if (!isUuid(b.deviceId)) return fail(400, DEVICE_ID_MISSING);
    const registered = await deps.resolveTerminalNo({ posStoreId: storeId, deviceId: b.deviceId });
    if (registered === null || registered !== terminalNo) return fail(403, 'This tablet is not registered for that terminal.');

    const db = deps.db;
    const FV = db.FieldValue;
    const result = await db.runTransaction(async (tx: any) => {
      const storeSnap = await tx.get(db.doc(`stores/${storeId}`));
      const storeCode = storeSnap.exists ? String((storeSnap.data() as any)?.code ?? '') : '';
      let expected: string;
      try {
        expected = formatTerminalReceiptNumber(storeCode, terminalNo, terminalSeq);
      } catch {
        throw new Refusal(409, 'This store has no code, so a receipt number cannot be made. Set the store code first.');
      }
      if (receiptNumber !== expected) throw new Refusal(400, 'The refund receipt number does not match this tablet and store.');

      const ref = db.doc(`stores/${storeId}/receiptNumbers/${receiptNumber}`);
      const snap = await tx.get(ref);
      if (snap.exists) {
        const prev = (snap.data() ?? {}) as Record<string, any>;
        const seq = Number(prev.terminalSeq);
        if (prev.released === true) return { state: 'released' as const, terminalSeq: seq };
        return { state: 'used' as const, terminalSeq: seq, receiptId: typeof prev.receiptId === 'string' ? prev.receiptId : null };
      }
      // T-477: a release may only reach RELEASE_WINDOW above this terminal's highest existing number (tombstones count), so a far-ahead
      // number cannot push the next claim past MAX_TERMINAL_SEQ. Reads stay before the write.
      const prefix = `${storeCode}-${String(terminalNo).padStart(2, '0')}-`;
      const top = await tx.get(
        db.collection(`stores/${storeId}/receiptNumbers`)
          .where(db.FieldPath.documentId(), '>=', `${prefix}000000`)
          .where(db.FieldPath.documentId(), '<=', `${prefix}999999`)
          .orderBy(db.FieldPath.documentId(), 'desc')
          .limit(1),
      );
      const highest = top.docs.length > 0 ? Number(String(top.docs[0].id).slice(prefix.length)) || 0 : 0;
      if (terminalSeq > highest + RELEASE_WINDOW) throw new Refusal(409, "That number is too far ahead of this terminal's receipts; a manager must check it.");
      tx.create(ref, {
        released: true, kind: 'refund-number-released', terminalNo, terminalSeq,
        releasedBy: { uid: caller.uid, role: caller.role }, createdAt: FV.serverTimestamp(),
      });
      return { state: 'released' as const, terminalSeq };
    });
    return jsonResponse(200, { ok: true, ...result });
  });
}
