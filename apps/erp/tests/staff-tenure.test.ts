import { describe, expect, it } from 'vitest';

/**
 * T-387 S7 - the tenure line on a staff card. Module under test: `apps/erp/src/app/staff/tenure.ts`,
 * `formatTenure(startedOn: 'YYYY-MM-DD', today: 'YYYY-MM-DD'): string`.
 * Rules pinned: whole CALENDAR months once at least one has passed (day-of-month compared); under a month, whole weeks
 * from 7 days, whole days under 7; a year or more is "N yr" plus " M mo" when months remain; same day is "today";
 * a start date in the future is "not started".
 */
import { formatTenure } from '../src/app/staff/tenure';

const T = '2026-10-11';

describe('formatTenure', () => {
  it.each([
    ['2026-10-11', 'today'],
    ['2026-10-10', '1 d'],
    ['2026-10-05', '6 d'],
    ['2026-10-04', '1 wk'],
    ['2026-09-27', '2 wk'],
    ['2026-09-13', '4 wk'],
    ['2026-09-11', '1 mo'],
    ['2026-07-11', '3 mo'],
    ['2026-07-12', '2 mo'],
    ['2025-11-11', '11 mo'],
    ['2025-10-11', '1 yr'],
    ['2025-08-11', '1 yr 2 mo'],
    ['2024-10-11', '2 yr'],
    ['2024-04-11', '2 yr 6 mo'],
    ['2026-10-12', 'not started'],
  ])('%s -> %s', (startedOn, expected) => {
    expect(formatTenure(startedOn, T)).toBe(expected);
  });
});
