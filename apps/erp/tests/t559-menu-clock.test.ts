/**
 * T-559 R3 / R4 (TESTER, written before the code) - the shell's menu clock. docs/tasks/559-pos-offline-daypart-switch.md R3.
 * One timer wakes at the earliest of the next daypart boundary (from the menu's own `hours`) and the cached `nextChangeAt`, ticks, and re-arms.
 * It also ticks and re-arms when the page becomes visible again and when the tablet comes back online. No network, no React: the hook is a thin wrapper.
 * ASSUMED API (apps/erp/src/app/pos/_shell/menu-clock.ts):
 *   msUntilRecompute(hours | undefined, nextChangeAt: string | null, nowMs): number | null    never 0 or negative
 *   startClock({ hours, nextChangeAt, onTick, now?, doc?, win? }): () => void              stop()
 * Every instant is Asia/Manila (UTC+8), Sunday 2026-11-01. Fake timers only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msUntilRecompute, startClock } from '@/app/pos/_shell/menu-clock';
import { DAYPARTED_MENU, manila } from './helpers/t559-menu';

const hours = DAYPARTED_MENU.hours!;
const ms = (d: Date) => d.getTime();

describe('msUntilRecompute', () => {
  it('the next window boundary from the menu hours: 16:59:30 -> 30 s', () => {
    expect(msUntilRecompute(hours, null, ms(manila('16:59')) + 30_000)).toBe(30_000);
  });
  it('exactly on a boundary the NEXT one is awaited (strictly after now): 17:00 -> 08:00 next day', () => {
    expect(msUntilRecompute(hours, null, ms(manila('17:00')))).toBe(15 * 3_600_000);
  });
  it('the earlier of the hours boundary and the cached nextChangeAt, whichever it is', () => {
    const at = ms(manila('12:00'));
    expect(msUntilRecompute(hours, new Date(at + 60_000).toISOString(), at)).toBe(60_000);
    expect(msUntilRecompute(hours, new Date(at + 9 * 3_600_000).toISOString(), at)).toBe(5 * 3_600_000); // the 17:00 boundary is sooner
  });
  it('only a positive delay arms: a past or equal nextChangeAt, garbage, or nothing ahead gives null; a past nextChangeAt does not hide the boundary', () => {
    const at = ms(manila('12:00'));
    expect(msUntilRecompute(undefined, new Date(at).toISOString(), at)).toBeNull();
    expect(msUntilRecompute(undefined, new Date(at - 1000).toISOString(), at)).toBeNull();
    expect(msUntilRecompute(undefined, 'not-a-date', at)).toBeNull();
    expect(msUntilRecompute(undefined, null, at)).toBeNull();
    expect(msUntilRecompute(hours, new Date(at - 1000).toISOString(), at)).toBe(5 * 3_600_000);
  });
  it('a menu with no dayparts still wakes at nextChangeAt (a scheduled price change)', () => {
    const at = ms(manila('12:00'));
    expect(msUntilRecompute(undefined, new Date(at + 90_000).toISOString(), at)).toBe(90_000);
  });
});

describe('startClock (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const fakeTarget = <V extends Record<string, unknown>>(extra: V) => {
    const handlers = new Map<string, Set<() => void>>();
    return {
      ...extra,
      addEventListener: vi.fn((type: string, fn: () => void) => void (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(fn)),
      removeEventListener: vi.fn((type: string, fn: () => void) => void handlers.get(type)?.delete(fn)),
      fire: (type: string) => [...(handlers.get(type) ?? [])].forEach((f) => f()),
      count: (type: string) => handlers.get(type)?.size ?? 0,
    };
  };

  it('ticks at the boundary (17:00), not before, then re-arms for the next one (08:00)', () => {
    vi.setSystemTime(manila('16:59'));
    const onTick = vi.fn();
    startClock({ hours, nextChangeAt: null, onTick, doc: null, win: null });
    vi.advanceTimersByTime(59_000);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15 * 3_600_000);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('re-arms on resume: a tablet that slept past 17:00 ticks the moment the page is visible again, then waits for 08:00, not for a boundary already gone', () => {
    vi.setSystemTime(manila('16:00'));
    const doc = fakeTarget({ visibilityState: 'hidden' as 'hidden' | 'visible' });
    const onTick = vi.fn();
    startClock({ hours, nextChangeAt: null, onTick, doc, win: null });
    vi.setSystemTime(manila('17:30')); // asleep: the 17:00 timer never ran
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(onTick, 'hidden: no tick').not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    expect(onTick).toHaveBeenCalledTimes(1);
    onTick.mockClear();
    vi.advanceTimersByTime(14 * 3_600_000); // 17:30 + 14 h = 07:30 next day: before 08:00
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30 * 60_000 + 1000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('re-arms on `online`: it ticks, and the wait is worked out again from the clock as it is now', () => {
    vi.setSystemTime(manila('12:00'));
    const win = fakeTarget({});
    const onTick = vi.fn();
    startClock({ hours, nextChangeAt: null, onTick, doc: null, win });
    expect(win.count('online')).toBe(1);
    vi.setSystemTime(manila('16:59'));
    win.fire('online');
    expect(onTick).toHaveBeenCalledTimes(1);
    onTick.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(onTick, 'one tick for the 17:00 boundary after re-arming at 16:59').toHaveBeenCalledTimes(1);
  });

  it('the cached nextChangeAt wakes it too, even with no dayparts', () => {
    vi.setSystemTime(manila('12:00'));
    const onTick = vi.fn();
    startClock({ hours: undefined, nextChangeAt: new Date(ms(manila('12:00')) + 90_000).toISOString(), onTick, doc: null, win: null });
    vi.advanceTimersByTime(89_000);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the timer and removes both listeners', () => {
    vi.setSystemTime(manila('16:59'));
    const doc = fakeTarget({ visibilityState: 'visible' as const });
    const win = fakeTarget({});
    const onTick = vi.fn();
    const stop = startClock({ hours, nextChangeAt: null, onTick, doc, win });
    stop();
    vi.advanceTimersByTime(3_600_000);
    doc.fire('visibilitychange');
    win.fire('online');
    expect(onTick).not.toHaveBeenCalled();
    expect(doc.count('visibilitychange') + win.count('online')).toBe(0);
  });

  it('nothing ahead arms nothing', () => {
    vi.setSystemTime(manila('12:00'));
    const onTick = vi.fn();
    startClock({ hours: undefined, nextChangeAt: null, onTick, doc: null, win: null });
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(onTick).not.toHaveBeenCalled();
  });
});
