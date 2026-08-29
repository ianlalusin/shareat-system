import { describe, expect, it } from 'vitest';
import { toBusinessDate } from '@shareat/core/datetime';
import {
  SHIFT_DAY_START_HOUR,
  addShiftDays,
  parseShiftDay,
  shiftDayOffsetMsForHour,
  shiftDayRange,
  toShiftDay,
} from './shift-day';

/**
 * T-155 Part A. `docs/tasks/155-shift-day-and-attendance-config.md`.
 *
 * ⚠️ **These must not depend on the machine's timezone.** Bible §12 landmine 7 — a server runtime is
 * UTC while the business is Manila, and project memory records the mirror failure: a date test that
 * passes locally because the developer is in Manila and fails in CI. Every instant below is written
 * as an explicit UTC offset (`+08:00`), never as a bare local string, so the assertions hold from
 * any `TZ`.
 */

const HOUR = 3_600_000;

describe('T-155 A — the shift day runs 05:00 to 05:00 Manila', () => {
  it('starts at 05:00, and says so', () => {
    expect(SHIFT_DAY_START_HOUR).toBe(5);
  });

  /**
   * ⭐ Invariant 1, and the whole reason this module is separate from `packages/core/datetime`.
   * The two calendars are asserted TOGETHER because the divergence IS the rule — a test that only
   * checked the shift day would pass just as well if someone quietly aliased it to the business day.
   */
  it('a 01:30 closing punch belongs to the PREVIOUS shift day and the CURRENT business day', () => {
    const punch = new Date('2026-03-10T01:30:00+08:00');
    expect(toShiftDay(punch)).toBe('2026-03-09');
    expect(toBusinessDate(punch)).toBe('2026-03-10');
  });

  it('04:59:59 is still the previous shift day', () => {
    expect(toShiftDay(new Date('2026-03-10T04:59:59+08:00'))).toBe('2026-03-09');
  });

  it('05:00:00 exactly starts the new shift day — the boundary is inclusive at the start', () => {
    expect(toShiftDay(new Date('2026-03-10T05:00:00+08:00'))).toBe('2026-03-10');
  });

  it('23:59 is the same shift day it looks like', () => {
    expect(toShiftDay(new Date('2026-03-10T23:59:00+08:00'))).toBe('2026-03-10');
  });

  it('crosses a month boundary correctly', () => {
    expect(toShiftDay(new Date('2026-04-01T02:00:00+08:00'))).toBe('2026-03-31');
  });

  it('crosses a year boundary correctly', () => {
    expect(toShiftDay(new Date('2027-01-01T03:00:00+08:00'))).toBe('2026-12-31');
  });
});

describe('T-155 A — shiftDayRange is half-open and 24 hours wide', () => {
  it('runs 05:00 Manila to 05:00 Manila, i.e. 21:00Z to 21:00Z', () => {
    const { start, end } = shiftDayRange(parseShiftDay('2026-03-10'));
    expect(start.toISOString()).toBe('2026-03-09T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-10T21:00:00.000Z');
  });

  it('the range contains exactly the instants that map to that shift day', () => {
    const day = parseShiftDay('2026-03-10');
    const { start, end } = shiftDayRange(day);
    expect(toShiftDay(start)).toBe(day);
    expect(toShiftDay(new Date(end.getTime() - 1))).toBe(day);
    // Half-open: the end instant belongs to the NEXT day, never counted twice.
    expect(toShiftDay(end)).toBe('2026-03-11');
  });

  it('consecutive ranges abut with no gap and no overlap', () => {
    const a = shiftDayRange(parseShiftDay('2026-03-10'));
    const b = shiftDayRange(parseShiftDay('2026-03-11'));
    expect(a.end.getTime()).toBe(b.start.getTime());
  });
});

describe('T-155 A — shiftDayOffsetMsForHour orders hours WITHIN a shift day', () => {
  /**
   * ⭐ The subtle one, ported with v1's reasoning (`shift-day.ts:44-50`): a store whose shifts begin
   * at 18:00 and run past midnight depends on 01:00 sorting AFTER 18:00 within one shift day, even
   * though 1 < 18 as a number. Naive hour comparison gets this backwards, and the failure looks like
   * "the anchor picked the wrong shift" rather than like a sorting bug.
   */
  it('05:00 is 0, 18:00 is 13h, 01:00 is 20h', () => {
    expect(shiftDayOffsetMsForHour(5)).toBe(0);
    expect(shiftDayOffsetMsForHour(18)).toBe(13 * HOUR);
    expect(shiftDayOffsetMsForHour(1)).toBe(20 * HOUR);
  });

  it('01:00 comes AFTER 18:00 within one shift day', () => {
    expect(shiftDayOffsetMsForHour(1)).toBeGreaterThan(shiftDayOffsetMsForHour(18));
  });

  it('every hour 0-23 maps into [0, 24h) exactly once — no gaps, no collisions', () => {
    const offsets = Array.from({ length: 24 }, (_, h) => shiftDayOffsetMsForHour(h));
    expect(new Set(offsets).size).toBe(24);
    for (const o of offsets) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(24 * HOUR);
    }
  });
});

describe('T-155 A — parsing and arithmetic', () => {
  it('rejects a malformed day rather than coercing it', () => {
    expect(() => parseShiftDay('10-03-2026')).toThrow();
    expect(() => parseShiftDay('2026-13-01')).toThrow();
    expect(() => parseShiftDay('')).toThrow();
  });

  it('addShiftDays crosses a month boundary', () => {
    expect(addShiftDays(parseShiftDay('2026-03-31'), 1)).toBe('2026-04-01');
    expect(addShiftDays(parseShiftDay('2026-03-01'), -1)).toBe('2026-02-28');
  });
});

describe('T-155 A — a full overnight shift lands on ONE day', () => {
  it('an 18:00 clock-in and a 02:00 clock-out share a shift day, in order', () => {
    const inAt = new Date('2026-03-10T18:00:00+08:00');
    const outAt = new Date('2026-03-11T02:00:00+08:00');
    expect(toShiftDay(inAt)).toBe('2026-03-10');
    expect(toShiftDay(outAt)).toBe('2026-03-10');
    expect(outAt.getTime()).toBeGreaterThan(inAt.getTime());

    // ...and the two calendars disagree about the clock-out, which is the point.
    expect(toBusinessDate(outAt)).toBe('2026-03-11');
  });
});
