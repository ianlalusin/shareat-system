import { describe, expect, it } from 'vitest';
import {
  clampToMonth,
  firstDueDate,
  isAnchorValid,
  nextDueDate,
  RECURRENCE_INTERVALS,
} from './recurrence';

/**
 * T-216 — the recurrence arithmetic, ported from v1 (`recurring-expense/recurrence.ts`), which is
 * correct. These are v1's own cases plus the ones its tests do not cover.
 *
 * ⚠️ **The whole file is timezone-pinned by construction** rather than by a `TZ=` in the runner:
 * every function takes and returns `YYYY-MM-DD` and does its arithmetic in UTC. That is the point
 * of the port — v1's version is right only because local-midnight parsing and local formatting
 * cancel out, which stops being true the day something runs somewhere else.
 */
describe('anchors — what a template may be anchored on', () => {
  it('monthly-family accepts 1–31 and refuses 0 and 32', () => {
    expect(isAnchorValid('monthly', 1)).toBe(true);
    expect(isAnchorValid('monthly', 31)).toBe(true);
    expect(isAnchorValid('quarterly', 31)).toBe(true);
    expect(isAnchorValid('monthly', 0)).toBe(false);
    expect(isAnchorValid('monthly', 32)).toBe(false);
  });

  it('weekly-family accepts 0–6 and refuses 7', () => {
    expect(isAnchorValid('weekly', 0)).toBe(true);
    expect(isAnchorValid('bi_weekly', 6)).toBe(true);
    expect(isAnchorValid('weekly', 7)).toBe(false);
    expect(isAnchorValid('weekly', -1)).toBe(false);
  });

  it('⚠️ 29, 30 and 31 are valid even though no month has all three — they CLAMP', () => {
    // Refusing them would make "the last day of the month" unexpressible, which is one of the
    // commonest real anchors there is.
    for (const day of [29, 30, 31]) expect(isAnchorValid('monthly', day)).toBe(true);
    expect(isAnchorValid('monthly', 1.5)).toBe(false);
  });
});

describe('clamping — a 31st anchor in a short month', () => {
  it('lands on the last day, in every short month', () => {
    expect(clampToMonth(2026, 1, 31)).toBe('2026-02-28');
    expect(clampToMonth(2026, 3, 31)).toBe('2026-04-30');
    expect(clampToMonth(2026, 8, 31)).toBe('2026-09-30');
    expect(clampToMonth(2026, 0, 31)).toBe('2026-01-31');
  });

  it('⭐ a LEAP February clamps to the 29th, not the 28th', () => {
    expect(clampToMonth(2028, 1, 31)).toBe('2028-02-29');
    expect(clampToMonth(2028, 1, 30)).toBe('2028-02-29');
    expect(clampToMonth(2028, 1, 28)).toBe('2028-02-28');
    // 2100 is not a leap year — the century rule, which a naive %4 gets wrong.
    expect(clampToMonth(2100, 1, 31)).toBe('2100-02-28');
  });
});

describe('nextDueDate — strictly after, always', () => {
  it('never returns the date it was given, for any interval', () => {
    // A function that could return `from` would draft the same expense every day for ever.
    for (const interval of RECURRENCE_INTERVALS) {
      const anchor = interval === 'weekly' || interval === 'bi_weekly' ? 3 : 15;
      expect(nextDueDate('2026-09-15', interval, anchor) > '2026-09-15').toBe(true);
    }
  });

  it('monthly, quarterly and annually step by 1, 3 and 12 months', () => {
    expect(nextDueDate('2026-09-15', 'monthly', 15)).toBe('2026-10-15');
    expect(nextDueDate('2026-09-15', 'quarterly', 15)).toBe('2026-12-15');
    expect(nextDueDate('2026-09-15', 'annually', 15)).toBe('2027-09-15');
  });

  it('⭐ a 31st anchor keeps its anchor across a short month — it does NOT stick at 28', () => {
    // This is the case that makes clamping worth having: January → February clamps, and
    // February → March must go back to the 31st rather than staying on the 28th for ever.
    const feb = nextDueDate('2026-01-31', 'monthly', 31);
    expect(feb).toBe('2026-02-28');
    expect(nextDueDate(feb, 'monthly', 31)).toBe('2026-03-31');
  });

  it('crosses a year boundary', () => {
    expect(nextDueDate('2026-12-15', 'monthly', 15)).toBe('2027-01-15');
    expect(nextDueDate('2026-11-30', 'quarterly', 30)).toBe('2027-02-28');
  });

  it('weekly and fortnightly land on the anchor WEEKDAY', () => {
    // 2026-09-15 is a Tuesday; anchor 3 is Wednesday.
    expect(new Date('2026-09-15T00:00:00Z').getUTCDay()).toBe(2);
    expect(nextDueDate('2026-09-15', 'weekly', 2)).toBe('2026-09-22');
    expect(nextDueDate('2026-09-15', 'bi_weekly', 2)).toBe('2026-09-29');
    // A different weekday steps first, then aligns forward.
    expect(nextDueDate('2026-09-15', 'weekly', 5)).toBe('2026-09-25');
  });

  it('⚠️ a fortnightly template anchored on its own weekday still MOVES', () => {
    // Aligning before stepping would return the same date and the template would stand still.
    const a = nextDueDate('2026-09-01', 'bi_weekly', 2);
    expect(a).toBe('2026-09-15');
    expect(nextDueDate(a, 'bi_weekly', 2)).toBe('2026-09-29');
  });
});

describe('firstDueDate — a template created today', () => {
  it('⚠️ is due THIS month when the anchor has not passed', () => {
    // Getting this wrong makes every new template a month late, silently.
    expect(firstDueDate('2026-09-03', 'monthly', 15)).toBe('2026-09-15');
  });

  it('is due today when the anchor IS today', () => {
    expect(firstDueDate('2026-09-15', 'monthly', 15)).toBe('2026-09-15');
  });

  it('rolls to next month when the anchor has passed', () => {
    expect(firstDueDate('2026-09-20', 'monthly', 15)).toBe('2026-10-15');
  });

  it('clamps in a short month', () => {
    expect(firstDueDate('2026-02-01', 'monthly', 31)).toBe('2026-02-28');
  });

  it('weekly finds the next matching weekday, including today', () => {
    expect(firstDueDate('2026-09-15', 'weekly', 2)).toBe('2026-09-15'); // Tuesday
    expect(firstDueDate('2026-09-15', 'weekly', 4)).toBe('2026-09-17'); // Thursday
  });
});
