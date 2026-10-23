/**
 * T-425 S5 - the OFFLINE PERIOD and the 4-hour X-slip clock (Ruling 7). A pure state machine plus persistence in the shared tablet database's
 * `meta` store (key 'offlinePeriod'; never localStorage), so a restart neither loses the period start nor reprints a slip.
 *
 * A period STARTS at the first offline reading and ENDS only when the tablet has been online for 10 continuous minutes AND has no unsent rows:
 * a brief reconnect never ends it and never resets the 4-hour clock. A slip is due at every 4 hours of period time (4:00, 8:00 ...).
 * `advanceOfflinePeriod` never changes `slipsPrinted`: a crash before the slip printed must not lose it; the caller calls `markSlipsPrinted`.
 */
import { STORE_META, inTerminalTransaction } from '@/lib/terminal/db';

export const OFFLINE_SLIP_INTERVAL_MS = 4 * 3600_000;
export const ONLINE_TO_END_MS = 10 * 60_000;
const META_KEY = 'offlinePeriod';

export interface OfflinePeriodState {
  periodStartMs: number | null;
  onlineSinceMs: number | null;
  slipsPrinted: number;
}

export const EMPTY_OFFLINE_PERIOD: OfflinePeriodState = { periodStartMs: null, onlineSinceMs: null, slipsPrinted: 0 };

export interface PeriodObservation {
  nowMs: number;
  online: boolean;
  unsentCount: number;
}

export interface PeriodStep {
  state: OfflinePeriodState;
  /** The slip numbers (1 = the 4:00 slip, 2 = 8:00 ...) that are due and not yet printed. Computed before an ending, so none is lost. */
  slipsDue: number[];
  ended: { startMs: number; endMs: number } | null;
}

export function advanceOfflinePeriod(state: OfflinePeriodState, obs: PeriodObservation): PeriodStep {
  const { nowMs, online, unsentCount } = obs;
  let next: OfflinePeriodState = state;

  if (!online) {
    next = state.periodStartMs === null
      ? { periodStartMs: nowMs, onlineSinceMs: null, slipsPrinted: 0 }
      : { ...state, onlineSinceMs: null };
  } else if (state.periodStartMs !== null) {
    next = { ...state, onlineSinceMs: state.onlineSinceMs ?? nowMs };
  }

  const start = next.periodStartMs;
  const slipsDue: number[] = [];
  if (start !== null) {
    const upTo = Math.floor((nowMs - start) / OFFLINE_SLIP_INTERVAL_MS);
    for (let k = next.slipsPrinted + 1; k <= upTo; k++) slipsDue.push(k);
  }

  if (online && start !== null && next.onlineSinceMs !== null && nowMs - next.onlineSinceMs >= ONLINE_TO_END_MS && unsentCount === 0) {
    return { state: { ...EMPTY_OFFLINE_PERIOD }, slipsDue, ended: { startMs: start, endMs: nowMs } };
  }
  return { state: next, slipsDue, ended: null };
}

export function markSlipsPrinted(state: OfflinePeriodState, upTo: number): OfflinePeriodState {
  return { ...state, slipsPrinted: Math.max(state.slipsPrinted, upTo) };
}

export async function loadOfflinePeriod(): Promise<OfflinePeriodState> {
  const row = await inTerminalTransaction<OfflinePeriodState | undefined>(STORE_META, 'readonly', (tx, done, fail) => {
    const req = tx.objectStore(STORE_META).get(META_KEY);
    req.onsuccess = () => done(req.result as OfflinePeriodState | undefined);
    req.onerror = () => fail(req.error ?? new Error('Could not read the offline period.'));
  });
  return row ? { ...EMPTY_OFFLINE_PERIOD, ...row } : { ...EMPTY_OFFLINE_PERIOD };
}

export function saveOfflinePeriod(state: OfflinePeriodState): Promise<void> {
  return inTerminalTransaction<void>(STORE_META, 'readwrite', (tx, done) => {
    tx.objectStore(STORE_META).put({ ...state }, META_KEY);
    done(undefined);
  });
}
