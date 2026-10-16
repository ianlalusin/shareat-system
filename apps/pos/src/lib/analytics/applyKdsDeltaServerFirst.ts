'use client';

import { auth } from '@/lib/firebase/client';

export type KdsActor = { profileId?: string | null; name?: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Apply a KDS analytics delta server-first for one or more tickets, with
 * transient-failure retry. The server recomputes from each ticket doc
 * (marker-based, idempotent). It is retried a few times to ride out transient
 * blips. If it ultimately fails, `clientFallback` is attempted best-effort — but
 * since analytics writes are locked to the server, that fallback is usually a
 * no-op, so its error is swallowed. The ticket markers lagging behind their
 * targets remain the signal that the delta is still pending (recoverable via the
 * admin backfill tool). Non-fatal: the status change is already committed.
 */
export async function applyKdsDeltaServerFirst(
  storeId: string,
  sessionId: string,
  ticketIds: string[],
  actor: KdsActor | undefined,
  clientFallback: () => Promise<void>,
): Promise<{ appliedViaServer: boolean }> {
  let appliedViaServer = false;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !appliedViaServer; attempt++) {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) break;
      const res = await fetch('/api/analytics/kds-delta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ storeId, sessionId, ticketIds, actor: actor ?? null }),
      });
      if (res.ok) {
        appliedViaServer = true;
        break;
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.warn(`[KDS analytics] non-retryable ${res.status}; leaving ticket markers pending.`);
        break;
      }
      console.warn(`[KDS analytics] attempt ${attempt}/${MAX_ATTEMPTS} -> ${res.status}, retrying`);
    } catch (serverErr) {
      console.warn(`[KDS analytics] attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying:`, serverErr);
    }
    if (!appliedViaServer && attempt < MAX_ATTEMPTS) await sleep(300 * attempt);
  }

  if (!appliedViaServer) {
    try {
      await clientFallback();
    } catch (fallbackErr) {
      console.warn('[KDS analytics] client fallback unavailable (rules lock); ticket markers left pending.', fallbackErr);
    }
  }
  return { appliedViaServer };
}
