import { describe, it, expect } from 'vitest';
import {
  BUSINESS_TIMEZONE,
  toBusinessDate,
  parseBusinessDate,
  businessDayRange,
  addDays,
  formatBusinessDateTime,
} from '@shareat/core/datetime';

describe('datetime — the UTC drift trap', () => {
  // PROJECT_BIBLE.md §12 landmine 7: server runtimes are UTC, so naive formatting puts
  // Philippine times 8 hours behind and lands transactions on the wrong business day.
  it('uses Manila, not the host timezone, to decide the business date', () => {
    // 17:00 UTC on Aug 22 is 01:00 on Aug 23 in Manila (UTC+8).
    const instant = new Date('2026-08-22T17:00:00.000Z');
    expect(toBusinessDate(instant)).toBe('2026-08-23');
    // The naive answer would have been the 22nd:
    expect(instant.toISOString().slice(0, 10)).toBe('2026-08-22');
  });

  it('handles the moment just before Manila midnight', () => {
    // 15:59 UTC = 23:59 Manila, same day.
    expect(toBusinessDate(new Date('2026-08-22T15:59:59.000Z'))).toBe('2026-08-22');
    // 16:00 UTC = 00:00 Manila, next day.
    expect(toBusinessDate(new Date('2026-08-22T16:00:00.000Z'))).toBe('2026-08-23');
  });

  it('rolls a month and a year correctly', () => {
    expect(toBusinessDate(new Date('2026-08-31T16:00:00.000Z'))).toBe('2026-09-01');
    expect(toBusinessDate(new Date('2026-12-31T16:00:00.000Z'))).toBe('2027-01-01');
  });

  it('pins the business timezone to Asia/Manila', () => {
    expect(BUSINESS_TIMEZONE).toBe('Asia/Manila');
  });
});

describe('datetime — business day range is half-open', () => {
  it('covers exactly 24 hours as [start, end)', () => {
    const { start, end } = businessDayRange(parseBusinessDate('2026-08-22'));
    expect(start.toISOString()).toBe('2026-08-21T16:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-22T16:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('makes consecutive days abut without overlap or gap', () => {
    const a = businessDayRange(parseBusinessDate('2026-08-22'));
    const b = businessDayRange(parseBusinessDate('2026-08-23'));
    expect(a.end.getTime()).toBe(b.start.getTime());
  });

  it('places an instant in exactly one day range', () => {
    const instant = new Date('2026-08-22T16:00:00.000Z'); // Manila midnight, Aug 23
    const day22 = businessDayRange(parseBusinessDate('2026-08-22'));
    const day23 = businessDayRange(parseBusinessDate('2026-08-23'));

    expect(instant >= day22.start && instant < day22.end).toBe(false);
    expect(instant >= day23.start && instant < day23.end).toBe(true);
  });
});

describe('datetime — parsing rejects rather than coerces', () => {
  it('accepts a well-formed date', () => {
    expect(parseBusinessDate('2026-08-22')).toBe('2026-08-22');
  });

  it('rejects anything else', () => {
    for (const bad of ['2026-8-22', '22-08-2026', '2026/08/22', '2026-13-01', '', 'today']) {
      expect(() => parseBusinessDate(bad)).toThrow();
    }
  });
});

describe('datetime — addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays(parseBusinessDate('2026-08-31'), 1)).toBe('2026-09-01');
    expect(addDays(parseBusinessDate('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(parseBusinessDate('2026-01-01'), -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addDays(parseBusinessDate('2028-02-28'), 1)).toBe('2028-02-29');
  });
});

describe('datetime — display formatting is timezone-pinned', () => {
  it('formats in business time regardless of host timezone', () => {
    const formatted = formatBusinessDateTime(new Date('2026-08-22T17:00:00.000Z'));
    // 01:00 on Aug 23 in Manila — the date must have rolled forward.
    expect(formatted).toContain('23');
  });
});
