/** One immutable cash-log submission, retained across a reload or lost response. No offline posting queue. */
import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase/client';
import type { CashHandover } from '@/lib/types';

type Payload = Omit<CashHandover, 'id' | 'createdAt'>;
export interface HandoverAttempt { id: string; storeId: string; payload: Payload }
const UNCERTAIN = 'Could not confirm this handover. Retry this same handover before logging another.';
class Conflict extends Error {
  constructor() { super('This handover was already saved with different details. Check History before continuing.'); }
}
function valid(value: unknown, storeId: string, uid: string): value is HandoverAttempt {
  const a = value as HandoverAttempt | null;
  const p = a?.payload;
  return Boolean(a && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.id)
    && a.storeId === storeId && storeId && !storeId.includes('/') && p && p.createdByUid === uid && uid
    && Number.isSafeInteger(p.periodStartMs) && Number.isSafeInteger(p.periodEndMs) && p.periodStartMs >= 0
    && p.periodEndMs >= p.periodStartMs && p.createdAtClientMs === p.periodEndMs
    && typeof p.shiftDayId === 'string' && typeof p.outgoingCashierName === 'string' && p.outgoingCashierName.trim()
    && typeof p.incomingCashierName === 'string' && p.incomingCashierName.trim() && Array.isArray(p.deductions)
    && [p.startingCash, p.cashSales, p.convertNet ?? 0, p.manualCashAdjustment ?? 0,
      p.deductionsTotal, p.expectedCash, p.countedCash, p.variance].every(n => typeof n === 'number' && Number.isFinite(n)));
}
export function readHandoverAttempt(storage: Pick<Storage, 'getItem'>, key: string, storeId: string, uid: string): HandoverAttempt | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let attempt: unknown;
  try { attempt = JSON.parse(raw); } catch { throw new Error('The saved handover could not be read. Ask a manager to check History before continuing.'); }
  if (!valid(attempt, storeId, uid)) throw new Error('The saved handover could not be read. Ask a manager to check History before continuing.');
  return attempt;
}
export function saveHandoverAttempt(storage: Pick<Storage, 'setItem'>, key: string, attempt: HandoverAttempt): void {
  storage.setItem(key, JSON.stringify(attempt));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function matches(saved: Record<string, unknown>, payload: Payload): boolean {
  return Object.entries(payload).every(([key, value]) => canonical(saved[key]) === canonical(value));
}
export async function commitHandover(attempt: HandoverAttempt): Promise<void> {
  if (!valid(attempt, attempt.storeId, attempt.payload.createdByUid ?? '')) throw new Error('Review this handover before saving.');
  const ref = doc(db, 'stores', attempt.storeId, 'cashHandovers', attempt.id);
  try {
    await runTransaction(db, async tx => {
      const saved = await tx.get(ref);
      if (saved.exists()) {
        if (!matches(saved.data(), attempt.payload)) throw new Conflict();
        return;
      }
      tx.set(ref, { ...attempt.payload, createdAt: serverTimestamp() });
    });
  } catch (error) {
    if (error instanceof Conflict) throw error;
    // A rejected promise does not prove rollback. Confirm the original id without writing again.
    try {
      const saved = await getDocFromServer(ref);
      if (saved.exists() && matches(saved.data(), attempt.payload)) return;
    } catch { /* Preserve the same attempt until the server can confirm it. */ }
    throw new Error(UNCERTAIN);
  }
}
