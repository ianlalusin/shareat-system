import { describe, expect, it } from 'vitest';
import { MIN_OPEN_MINUTES, minutesSinceCutoff, verdictFor } from './sweep';

/**
 * T-199 — the sweep's decision, pure. `docs/tasks/199-missed-clock-out-sweep.md`.
 *
 * ⭐ Kept pure for the same reason v1's `auto-clock-out.ts` is: the sweep and its tests share ONE
 * answer, and a wall-clock rule tested only through a database is tested through the clock too.
 */
const CLEARS_AT_2AM = { autoClockOutHour: 2, maxShiftHours: 16 };
const NEVER_CLEARS = { autoClockOutHour: null, maxShiftHours: 16 };

describe('T-199 — the cut-off hour', () => {
  it('closes a day that was open when the cut-off passed', () => {
    // Open 9 hours; the cut-off went by 3 hours ago, so it passed while this day was open.
    const v = verdictFor({ anchorMinute: 17 * 60, openMinutes: 9 * 60 }, CLEARS_AT_2AM, 180);
    expect(v).toEqual({ close: true, why: 'cutoff_hour' });
  });

  it('leaves a day the cut-off has not come round for since it opened', () => {
    // Open 30 minutes; the cut-off was 3 hours ago, i.e. BEFORE this day began.
    const v = verdictFor({ anchorMinute: 5 * 60, openMinutes: 30 }, CLEARS_AT_2AM, 180);
    expect(v).toEqual({ close: false, why: 'not_due' });
  });

  it('⛔ MIN_OPEN_MINUTES — a shift that has just begun is never killed', () => {
    /**
     * v1's reason, and it is a money argument: *"a store whose cutoff hour sits near a real shift
     * start would kill a shift that had just begun — and with `halfDayOnMissingTap` on, pay it
     * half a day for five minutes of work."*
     */
    const justStarted = { anchorMinute: 2 * 60, openMinutes: 5 };
    expect(verdictFor(justStarted, CLEARS_AT_2AM, 5).close).toBe(false);
    expect(verdictFor(justStarted, CLEARS_AT_2AM, 5)).toEqual({ close: false, why: 'too_fresh' });
  });

  it('the guard is exactly an hour, and an hour is enough', () => {
    // ⚠️ `sinceCutoff` must be SMALLER than `openMinutes`, or the cut-off passed before this day
    // began and the day is `not_due` regardless of the guard. (The first draft of this test used
    // 600 and failed on that — correctly.)
    const at59 = { anchorMinute: 60, openMinutes: MIN_OPEN_MINUTES - 1 };
    const at60 = { anchorMinute: 60, openMinutes: MIN_OPEN_MINUTES };
    expect(verdictFor(at59, CLEARS_AT_2AM, 30)).toEqual({ close: false, why: 'too_fresh' });
    expect(verdictFor(at60, CLEARS_AT_2AM, 30)).toEqual({ close: true, why: 'cutoff_hour' });
  });

  it('a store with no cut-off hour never auto-clears on the clock', () => {
    const v = verdictFor({ anchorMinute: 60, openMinutes: 10 * 60 }, NEVER_CLEARS, null);
    expect(v).toEqual({ close: false, why: 'never_clears' });
  });
});

describe('T-199 — the max-shift backstop', () => {
  it('⭐ fires even at a store that never auto-clears', () => {
    const v = verdictFor({ anchorMinute: 60, openMinutes: 17 * 60 }, NEVER_CLEARS, null);
    expect(v).toEqual({ close: true, why: 'max_shift' });
  });

  it('⚠️ and OUTRANKS the cut-off, so the two rules cannot disagree about one day', () => {
    // ⛔ Both rules produce the same RECORD; what matters is that one day gets one verdict.
    const v = verdictFor({ anchorMinute: 60, openMinutes: 20 * 60 }, CLEARS_AT_2AM, 10);
    expect(v).toEqual({ close: true, why: 'max_shift' });
  });

  it('does not fire below the cap', () => {
    expect(verdictFor({ anchorMinute: 60, openMinutes: 15 * 60 }, NEVER_CLEARS, null).close).toBe(false);
  });
});

describe('T-199 — the cut-off is measured in MANILA, never the server timezone', () => {
  /**
   * ⚠️ A production host running UTC is eight hours behind Manila. Evaluating a wall-clock cut-off
   * in UTC would fire it at the wrong time of day every single night — the same trap T-198's
   * migration avoids by pinning `(now() at time zone 'Asia/Manila')`.
   */
  const at = (iso: string) => Date.parse(iso);

  it('03:00 Manila is one hour past a 02:00 cut-off', () => {
    // 03:00 Manila == 19:00 UTC the previous day.
    expect(minutesSinceCutoff(2, at('2026-08-30T19:00:00Z'))).toBe(60);
  });

  it('01:00 Manila is twenty-three hours past it, not minus one', () => {
    expect(minutesSinceCutoff(2, at('2026-08-30T17:00:00Z'))).toBe(23 * 60);
  });

  it('null in, null out — a store that never clears has no cut-off to measure', () => {
    expect(minutesSinceCutoff(null, Date.now())).toBeNull();
  });
});
