'use client';

import { auth } from '@/lib/firebase/client';

export type ReceiptDeltaOp = 'payment' | 'refund' | 'void' | 'edit' | 'voidcash-reverse';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Apply a receipt analytics delta server-first, with transient-failure retry.
 *
 * The authoritative path is the server endpoint (server clock, recomputes from
 * the receipt doc, idempotent). It is retried a few times to ride out transient
 * blips (cold start / brief network). If it ultimately fails, `clientFallback`
 * is attempted best-effort — but since analytics writes are locked to the server
 * (rules), that fallback is now usually a no-op, so its error is swallowed. The
 * receipt's pending flag (analyticsApplied:false / analyticsReversed:false) means
 * the reconcile cron (/api/cron/reconcile-analytics) will apply it regardless, so
 * nothing is permanently dropped and the caller never sees a spurious error.
 */
export async function applyReceiptDeltaServerFirst(
  storeId: string,
  receiptId: string,
  op: ReceiptDeltaOp,
  clientFallback: () => Promise<void>,
  extra?: Record<string, unknown>,
): Promise<{ appliedViaServer: boolean }> {
  let appliedViaServer = false;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !appliedViaServer; attempt++) {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) break; // not authed; reconcile cron will catch receipt ops
      const res = await fetch('/api/analytics/apply-delta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ storeId, receiptId, op, ...(extra || {}) }),
      });
      if (res.ok) {
        appliedViaServer = true;
        const j = await res.json().catch(() => null);
        console.log(`[Analytics] ${op} applied server-side for`, receiptId, j?.skipped ? '(already applied)' : '');
        break;
      }
      // 4xx (except 429) won't change on retry — stop and leave it to the cron.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.warn(`[Analytics] ${op} non-retryable ${res.status}; leaving pending for reconcile cron.`);
        break;
      }
      console.warn(`[Analytics] ${op} attempt ${attempt}/${MAX_ATTEMPTS} -> ${res.status}, retrying`);
    } catch (serverErr) {
      console.warn(`[Analytics] ${op} attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying:`, serverErr);
    }
    if (!appliedViaServer && attempt < MAX_ATTEMPTS) await sleep(300 * attempt);
  }

  if (!appliedViaServer) {
    // Best-effort only; a no-op once analytics is locked to the server. The
    // reconcile cron is the durable backstop.
    try {
      await clientFallback();
    } catch (fallbackErr) {
      console.warn(`[Analytics] ${op} client fallback unavailable (rules lock); left pending for reconcile cron.`, fallbackErr);
    }
  }
  return { appliedViaServer };
}
