import 'server-only';
/**
 * T-424 S10 - POST /api/pos2/analytics/apply-delta, a PORT of POS v1's route (src/app/api/analytics/apply-delta/route.ts @ e26d0c1).
 * docs/tasks/424-pos-v2-server-approvals.md Ruling 10a, Acceptance 12.
 *
 * The test Firebase project has no v1 server or reconcile cron, so the v2 server applies the analytics delta itself. It recomputes the delta
 * from the receipt document (never trusts client totals) and applies it idempotently with the same flags as v1:
 *   "payment" / "refund": null -> receipt, idempotent on `analyticsApplied`, sets it.
 *   "void": receipt -> null (its ORIGINAL pre-void contribution), idempotent on `analyticsReversed`, gated on `analyticsApplied`.
 * Other ops answer 501 with v1's sentence. NOT ported (documented in V1-COPY.md): v1's popular-items counter and daily session timeline rows.
 * The preset windows use the SERVER clock (`deps.nowMs()`), as v1 used the server's `new Date()`.
 * Used by the APK only when it was built with NEXT_PUBLIC_POS2_ANALYTICS=1; production builds keep calling v1's endpoint.
 */
import { requireRole } from './roles';
import { Refusal, fail, guarded, isNonBlank, jsonResponse } from './http';
import { authenticate } from './identity';
import { applyAnalyticsDeltaServer } from './analytics/apply-delta-core';
import type { Pos2Deps } from './types';

const SUPPORTED_OPS = new Set(['payment', 'refund', 'void']);

export async function handleApplyDelta(req: Request, deps: Pos2Deps): Promise<Response> {
  return guarded(async () => {
    const auth = await authenticate(req, deps);
    if (!auth.ok) return auth.response;
    const { caller } = auth;
    const denied = requireRole(caller, ['admin', 'manager', 'cashier']);
    if (denied) return denied;

    const receiptId = caller.body.receiptId;
    const op = String(caller.body.op ?? '');
    if (!isNonBlank(receiptId) || receiptId.includes('/') || !op) return fail(400, 'Missing storeId, receiptId, or op.');
    if (!SUPPORTED_OPS.has(op)) return jsonResponse(501, { ok: false, error: `op '${op}' not yet supported server-side.`, op });

    const db = deps.db;
    const storeId = caller.storeId;
    const FV = db.FieldValue;
    const receiptRef = db.doc(`stores/${storeId}/receipts/${receiptId}`);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(receiptRef);
      if (!snap.exists) throw new Refusal(404, 'Receipt not found.');
      const receipt = { id: receiptRef.id, ...(snap.data() as Record<string, any>) } as any;
      const now = new Date(deps.nowMs());

      if (op === 'void') {
        if (receipt.analyticsReversed === true) return { skipped: true as const };
        if (receipt.analyticsApplied !== true) {
          tx.update(receiptRef, { analyticsReversed: true, analyticsReversedAt: FV.serverTimestamp() });
          return { skipped: true as const };
        }
        // The contribution functions return zero for a voided receipt, so neutralize the flag to rebuild the ORIGINAL contribution.
        const asOriginal = { ...receipt, isVoided: false, status: receipt.status === 'voided' ? 'final' : receipt.status };
        // Cash collected on the receipt that was NOT refunded when it was voided stays in the drawer: accumulated on the day doc for the ERP.
        const retained = Number(receipt.voidCashRetained || 0);
        applyAnalyticsDeltaServer(db, storeId, asOriginal, null, tx, now, retained > 0 ? { 'payments.voidCashRetainedTotal': retained } : undefined);
        tx.update(receiptRef, { analyticsReversed: true, analyticsReversedAt: FV.serverTimestamp() });
        return { skipped: false as const };
      }

      // "payment" | "refund": apply null -> receipt.
      if (receipt.analyticsApplied === true) return { skipped: true as const };
      applyAnalyticsDeltaServer(db, storeId, null, receipt, tx, now);
      tx.update(receiptRef, { analyticsApplied: true, analyticsAppliedAt: FV.serverTimestamp() });
      return { skipped: false as const };
    });

    return jsonResponse(200, { ok: true, applied: !result.skipped, skipped: result.skipped, op });
  });
}
