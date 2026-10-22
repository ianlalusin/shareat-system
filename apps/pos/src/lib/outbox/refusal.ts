/**
 * T-425 S1 - a Firestore refusal that retrying can never fix (a permission or validation error) versus a transient failure.
 * A refused offline write is marked `rejected` in the ledger (manager list, never replayed); anything else is only a failed attempt.
 */
import { patchEvent, type LedgerEvent } from '@/lib/outbox/ledger';

export const REFUSAL_CODES = ['permission-denied', 'invalid-argument', 'failed-precondition'];

export const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '');
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const isServerRefusal = (e: unknown): boolean => REFUSAL_CODES.includes(codeOf(e));

/** For the `onError` of a local-first batch: a definite server refusal makes the ledger row `rejected`. Never throws. */
export async function rejectIfRefused(ev: Pick<LedgerEvent, 'deviceId' | 'terminalSeq'>, err: unknown): Promise<void> {
  if (!isServerRefusal(err)) return;
  try {
    await patchEvent(ev.deviceId, ev.terminalSeq, { status: 'rejected', lastError: messageOf(err) });
  } catch (e) {
    console.error('[outbox] could not mark a refused sale as rejected', e);
  }
}
