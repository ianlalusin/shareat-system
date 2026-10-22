/**
 * T-425 slice T - the offline period and the 4-hour X-slip timer (Ruling 7 ✎R). Acceptance 13.
 *
 * CONTRACT for the builder (S5) - file `apps/pos/src/lib/outbox/offlinePeriod.ts`. A pure state machine plus persistence in the shared
 * database's `meta` store (key 'offlinePeriod'; never localStorage). Exports exactly:
 *   OFFLINE_SLIP_INTERVAL_MS = 4 * 3600_000        ONLINE_TO_END_MS = 10 * 60_000
 *   interface OfflinePeriodState { periodStartMs: number | null; onlineSinceMs: number | null; slipsPrinted: number }
 *   EMPTY_OFFLINE_PERIOD: OfflinePeriodState = { periodStartMs: null, onlineSinceMs: null, slipsPrinted: 0 }
 *   advanceOfflinePeriod(state, obs: { nowMs: number; online: boolean; unsentCount: number }):
 *        { state: OfflinePeriodState; slipsDue: number[]; ended: { startMs: number; endMs: number } | null }
 *     - an OFFLINE reading with no period starts one (periodStartMs = nowMs). An offline reading clears onlineSinceMs.
 *     - an ONLINE reading inside a period sets onlineSinceMs (first online reading of the stretch). The period ENDS (state back to EMPTY, `ended`
 *       = {startMs, endMs: nowMs}) only when nowMs - onlineSinceMs >= ONLINE_TO_END_MS AND unsentCount === 0. Brief reconnects never end it.
 *     - slipsDue = the numbers k with slipsPrinted < k <= floor((nowMs - periodStartMs) / OFFLINE_SLIP_INTERVAL_MS) (k = 1 is the 4:00 slip, 2 the 8:00).
 *       `advanceOfflinePeriod` itself never changes slipsPrinted (a crash before printing must not lose a slip).
 *   markSlipsPrinted(state, upTo: number): OfflinePeriodState      - slipsPrinted = max(slipsPrinted, upTo)
 *   loadOfflinePeriod(): Promise<OfflinePeriodState>               - EMPTY_OFFLINE_PERIOD when nothing is stored
 *   saveOfflinePeriod(state): Promise<void>                        - resolves after the IndexedDB transaction completed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb } from '@/test-helpers/fakeIdb';
import * as op from '@/lib/outbox/offlinePeriod';

const H = 3_600_000;
const M = 60_000;
const T0 = 1_800_000_000_000;

beforeEach(() => { vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 0 })); });
afterEach(() => { vi.unstubAllGlobals(); });

const step = (s: op.OfflinePeriodState, at: number, online: boolean, unsent = 0) => op.advanceOfflinePeriod(s, { nowMs: T0 + at, online, unsentCount: unsent });

describe('offline period', () => {
  it('constants', () => {
    expect(op.OFFLINE_SLIP_INTERVAL_MS).toBe(4 * H);
    expect(op.ONLINE_TO_END_MS).toBe(10 * M);
    expect(op.EMPTY_OFFLINE_PERIOD).toEqual({ periodStartMs: null, onlineSinceMs: null, slipsPrinted: 0 });
  });

  it('an online reading with no period does nothing; the first offline reading starts the period', () => {
    expect(step(op.EMPTY_OFFLINE_PERIOD, 0, true).state).toEqual(op.EMPTY_OFFLINE_PERIOD);
    const r = step(op.EMPTY_OFFLINE_PERIOD, 5 * M, false);
    expect(r.state.periodStartMs).toBe(T0 + 5 * M);
    expect(r.slipsDue).toEqual([]);
    expect(r.ended).toBeNull();
  });

  it('Acceptance 13: a slip is due at 4:00 and again at 8:00 of offline-period time (and not before)', () => {
    let s = step(op.EMPTY_OFFLINE_PERIOD, 0, false).state;
    expect(step(s, 4 * H - 1, false).slipsDue).toEqual([]);
    const at4 = step(s, 4 * H, false);
    expect(at4.slipsDue).toEqual([1]);
    s = op.markSlipsPrinted(at4.state, 1);
    expect(step(s, 4 * H + 30 * M, false).slipsDue).toEqual([]);
    expect(step(s, 8 * H - 1, false).slipsDue).toEqual([]);
    expect(step(s, 8 * H, false).slipsDue).toEqual([2]);
  });

  it('an unprinted slip is still due on the next reading, and a long gap makes every missed slip due (4:00 and 8:00 after a 9-hour silence)', () => {
    const s = step(op.EMPTY_OFFLINE_PERIOD, 0, false).state;
    expect(step(s, 4 * H, false).slipsDue).toEqual([1]);
    expect(step(s, 4 * H + 20 * M, false).slipsDue).toEqual([1]); // advance did not consume it
    expect(step(s, 9 * H, false).slipsDue).toEqual([1, 2]);
    expect(op.markSlipsPrinted(op.markSlipsPrinted(s, 2), 1).slipsPrinted).toBe(2);
  });

  it('Acceptance 13: a 2-minute reconnect in between does not reset the period or the 4-hour clock', () => {
    let s = step(op.EMPTY_OFFLINE_PERIOD, 0, false).state;
    const first = op.markSlipsPrinted(step(s, 4 * H, false).state, 1);
    s = step(first, 5 * H, true).state;
    s = step(s, 5 * H + 2 * M, true).state;
    s = step(s, 5 * H + 2 * M + 1000, false).state;           // down again
    expect(s.periodStartMs).toBe(T0);
    expect(s.onlineSinceMs).toBeNull();
    expect(s.slipsPrinted).toBe(1);
    expect(step(s, 8 * H, false).slipsDue).toEqual([2]);      // still 8:00 from the ORIGINAL start
  });

  it('the period ends only after 10 continuous online minutes AND no unsent rows', () => {
    let s = step(op.EMPTY_OFFLINE_PERIOD, 0, false).state;
    s = step(s, 1 * H, true, 3).state;
    expect(s.onlineSinceMs).toBe(T0 + H);
    expect(step(s, 1 * H + 9 * M, true, 0).ended).toBeNull();                   // not yet 10 minutes
    const stillUnsent = step(s, 1 * H + 30 * M, true, 2);
    expect(stillUnsent.ended).toBeNull();                                         // 30 minutes online but rows unsent
    expect(stillUnsent.state.periodStartMs).toBe(T0);
    const done = step(s, 1 * H + 10 * M, true, 0);
    expect(done.ended).toEqual({ startMs: T0, endMs: T0 + H + 10 * M });
    expect(done.state).toEqual(op.EMPTY_OFFLINE_PERIOD);
  });

  it('going offline mid-way resets the 10-minute online stretch', () => {
    let s = step(op.EMPTY_OFFLINE_PERIOD, 0, false).state;
    s = step(s, H, true).state;
    s = step(s, H + 8 * M, true).state;
    s = step(s, H + 9 * M, false).state;
    s = step(s, H + 10 * M, true).state;                       // a new stretch starts here
    expect(step(s, H + 19 * M, true).ended).toBeNull();
    expect(step(s, H + 20 * M, true).ended).not.toBeNull();
  });

  it('a new offline reading after an ended period starts a NEW period with slipsPrinted back at 0', () => {
    let s = step(op.EMPTY_OFFLINE_PERIOD, 0, false).state;
    s = op.markSlipsPrinted(s, 3);
    s = step(s, H, true).state;
    s = step(s, H + 10 * M, true).state; // ended
    expect(s).toEqual(op.EMPTY_OFFLINE_PERIOD);
    const again = step(s, 20 * H, false).state;
    expect(again).toEqual({ periodStartMs: T0 + 20 * H, onlineSinceMs: null, slipsPrinted: 0 });
  });

  it('Acceptance 13: the state survives a restart (IndexedDB), including the slips already printed', async () => {
    expect(await op.loadOfflinePeriod()).toEqual(op.EMPTY_OFFLINE_PERIOD);
    let s = step(op.EMPTY_OFFLINE_PERIOD, 0, false).state;
    s = op.markSlipsPrinted(step(s, 4 * H, false).state, 1);
    await op.saveOfflinePeriod(s);
    const restarted = await op.loadOfflinePeriod();           // a fresh load = a restarted app
    expect(restarted).toEqual(s);
    expect(step(restarted, 4 * H + M, false).slipsDue).toEqual([]);   // slip 1 is NOT printed twice
    expect(step(restarted, 8 * H, false).slipsDue).toEqual([2]);
  });

  it('never touches localStorage', async () => {
    const ls = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', ls);
    await op.saveOfflinePeriod(step(op.EMPTY_OFFLINE_PERIOD, 0, false).state);
    await op.loadOfflinePeriod();
    expect(ls.setItem).not.toHaveBeenCalled();
    expect(ls.getItem).not.toHaveBeenCalled();
  });
});
