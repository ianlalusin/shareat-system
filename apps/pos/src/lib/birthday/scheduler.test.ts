/**
 * T-455 S6b (TESTER) - the tablet's birthday scheduler: plays an ACCEPTED request at its time, with a Stop countdown, surviving offline and reload.
 * docs/tasks/455-customer-lobby.md S6b row + "S6a rulings" 6, 7 (play is not time-gated by the server, so the TABLET holds the clock).
 * Numbered ASSUMPTIONS A1..A10 are in player.test.ts's header (same slice); this file leans on A6 (storage), A7 (30 min), A8 (countdown), A9 (mark played).
 *
 * RED FOR THE RIGHT REASON: `@/lib/birthday/scheduler` does not exist ("Failed to resolve import").
 * CONTRACT THE BUILDER MATCHES
 *   createBirthdayScheduler(deps): Scheduler
 *     deps = { storage: { getItem(k): string | null; setItem(k, v): void; removeItem(k): void }   // injected; the key `pos2.birthdaySchedule.<storeId>` is the builder's own
 *              playSong(): Promise<void>                        // wraps playBirthdayLoop
 *              markPlayed(requestId: string): Promise<void>     // POST birthday/play; rejects when offline
 *              storeId: string; countdownSeconds?: number (default 10) }       clock = Date.now (tests fake it)
 *   Scheduler: accept({ requestId, scheduledAt: epoch ms }): void   persists + arms
 *              restore(): void                                     re-reads storage on app start / reload and arms (applies the 30 min rule)
 *              stop(requestId): void                               countdown Stop: nothing plays, item forgotten
 *              flushPlayed(): Promise<void>                        retries queued markPlayed calls (never throws)
 *              state(): { countdown: { requestId; secondsLeft } | null; pending: string[] }   pending = accepted, not yet played, not stopped
 *   Timing: at scheduledAt the countdown starts (secondsLeft = countdownSeconds), ticks each second; at 0 playSong() runs ONCE, then markPlayed.
 * MUTANTS: M1 plays at accept time / early; M2 countdown ignored; M3 Stop does not cancel; M4 offline markPlayed failure blocks or throws the song;
 *   M5 queue not retried / retried twice; M6 reload loses the schedule; M7 reload plays a stale (>30 min) request; M8 plays twice; M9 a past (Now) time never plays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBirthdayScheduler } from './scheduler';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const REQ = '019e4444-4444-7444-8444-444444444444';
const REQ2 = '019e5555-5555-7555-8555-555555555555';

function mem() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
function build(over: { storage?: ReturnType<typeof mem>; markPlayed?: (id: string) => Promise<void> } = {}) {
  const storage = over.storage ?? mem();
  const marks: string[] = [];
  const playSong = vi.fn(async () => undefined);
  const markPlayed = vi.fn(over.markPlayed ?? (async (id: string) => { marks.push(id); }));
  const s = createBirthdayScheduler({ storage, playSong, markPlayed, storeId: 'S1' });
  return { s, storage, playSong, markPlayed, marks };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

describe('plays at the time, not before', () => {
  it('nothing plays before scheduledAt; the countdown starts at the time; the song plays only after the countdown [M1, M2]', async () => {
    const t = build();
    t.s.accept({ requestId: REQ, scheduledAt: T0 + 5 * MIN });
    await vi.advanceTimersByTimeAsync(5 * MIN - 1000);
    expect(t.playSong).not.toHaveBeenCalled();
    expect(t.s.state().countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.s.state().countdown).toEqual({ requestId: REQ, secondsLeft: 10 });
    await vi.advanceTimersByTimeAsync(9000);
    expect(t.playSong).not.toHaveBeenCalled();
    expect(t.s.state().countdown?.secondsLeft).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.playSong).toHaveBeenCalledTimes(1);
    expect(t.marks).toEqual([REQ]);
    expect(t.s.state().countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(t.playSong).toHaveBeenCalledTimes(1); // never twice [M8]
  });

  it('a time already past ("Now") counts down at once and plays [M9]', async () => {
    const t = build();
    t.s.accept({ requestId: REQ, scheduledAt: T0 - 1000 });
    expect(t.s.state().countdown?.requestId).toBe(REQ);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.playSong).toHaveBeenCalledTimes(1);
  });
});

describe('countdown Stop cancels [M3]', () => {
  it('Stop during the countdown: the song never plays, nothing is marked played, the item is forgotten and a reload does not revive it', async () => {
    const t = build();
    t.s.accept({ requestId: REQ, scheduledAt: T0 + MIN });
    await vi.advanceTimersByTimeAsync(MIN + 4000);
    t.s.stop(REQ);
    expect(t.s.state().countdown).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.playSong).not.toHaveBeenCalled();
    expect(t.markPlayed).not.toHaveBeenCalled();
    const again = build({ storage: t.storage });
    again.s.restore();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(again.playSong).not.toHaveBeenCalled();
  });
});

describe('offline [M4, M5]', () => {
  it('a request accepted while online still plays when the tablet is offline; the mark-played is queued and sent once when back', async () => {
    let online = false;
    const sent: string[] = [];
    const t = build({ markPlayed: async (id) => { if (!online) throw new Error('offline'); sent.push(id); } });
    t.s.accept({ requestId: REQ, scheduledAt: T0 + MIN });
    await vi.advanceTimersByTimeAsync(MIN + 10_000);
    expect(t.playSong).toHaveBeenCalledTimes(1); // the failure of markPlayed did not stop or throw the song
    await t.s.flushPlayed(); // still offline: stays queued, no throw
    expect(sent).toEqual([]);
    online = true;
    await t.s.flushPlayed();
    await t.s.flushPlayed();
    expect(sent).toEqual([REQ]); // once, not twice
  });
});

describe('reload and the 30 minute rule [M6, M7]', () => {
  it('an app reopened before the time still plays at the time', async () => {
    const t = build();
    t.s.accept({ requestId: REQ, scheduledAt: T0 + 10 * MIN });
    await vi.advanceTimersByTimeAsync(3 * MIN);
    const r = build({ storage: t.storage });
    r.s.restore();
    expect(r.s.state().pending).toEqual([REQ]);
    await vi.advanceTimersByTimeAsync(7 * MIN + 10_000);
    expect(r.playSong).toHaveBeenCalledTimes(1);
  });

  it('an app reopened more than 30 minutes after the time does NOT play it, and forgets it', async () => {
    const t = build();
    t.s.accept({ requestId: REQ, scheduledAt: T0 + MIN });
    vi.setSystemTime(T0 + MIN + 30 * MIN + 1000);
    const r = build({ storage: t.storage });
    r.s.restore();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.playSong).not.toHaveBeenCalled();
    expect(r.s.state().pending).toEqual([]);
    expect([...t.storage.m.values()].join('')).not.toContain(REQ);
  });

  it('reopened 29 minutes after the time: still counts down and plays; a second item keeps its own time', async () => {
    const t = build();
    t.s.accept({ requestId: REQ, scheduledAt: T0 + MIN });
    t.s.accept({ requestId: REQ2, scheduledAt: T0 + 60 * MIN });
    vi.setSystemTime(T0 + MIN + 29 * MIN);
    const r = build({ storage: t.storage });
    r.s.restore();
    expect(r.s.state().countdown?.requestId).toBe(REQ);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.playSong).toHaveBeenCalledTimes(1);
    expect(r.s.state().pending).toEqual([REQ2]);
  });

  it('unreadable or missing storage restores to nothing and does not throw', () => {
    const bad = { getItem: () => { throw new Error('no storage'); }, setItem: () => { throw new Error('no storage'); }, removeItem: () => undefined };
    const s = createBirthdayScheduler({ storage: bad, playSong: async () => undefined, markPlayed: async () => undefined, storeId: 'S1' });
    expect(() => s.restore()).not.toThrow();
    expect(s.state().pending).toEqual([]);
    expect(() => s.accept({ requestId: REQ, scheduledAt: T0 + MIN })).not.toThrow();
  });
});
