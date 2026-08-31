import { describe, expect, it } from 'vitest';
import {
  derivePeriods,
  lastDayOfMonth,
  payoutDateFor,
  periodForDate,
  tilesTheMonth,
  type PeriodConfig,
} from './periods';

/**
 * T-189c. ⭐ v1 states the tiling invariant in a comment and relies on it in three other places
 * without ever testing it. These are the tests it never had.
 */
const semi = (day = 15): PeriodConfig => ({
  payrollPeriodType: 'semi_monthly',
  semiMonthlyCutoffDay: day,
});
const monthly: PeriodConfig = { payrollPeriodType: 'monthly', semiMonthlyCutoffDay: 15 };
const weekly: PeriodConfig = { payrollPeriodType: 'weekly', semiMonthlyCutoffDay: 15 };

describe('semi-monthly — the default', () => {
  it('cuts at the configured day, and the second period runs to month end', () => {
    const p = derivePeriods(semi(15), 2026, 8);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ start: '2026-08-01', end: '2026-08-15' });
    expect(p[1]).toMatchObject({ start: '2026-08-16', end: '2026-08-31' });
  });

  it('⭐ a different cutoff moves BOTH boundaries — the second still ends at month end', () => {
    const p = derivePeriods(semi(10), 2026, 8);
    expect(p[0]!.end).toBe('2026-08-10');
    expect(p[1]!.start).toBe('2026-08-11');
    expect(p[1]!.end).toBe('2026-08-31');
  });

  it('⚠️ handles a SHORT month — the second period is not empty', () => {
    const p = derivePeriods(semi(15), 2026, 2);
    expect(p[1]).toMatchObject({ start: '2026-02-16', end: '2026-02-28' });
  });

  it('⭐ and a LEAP February', () => {
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(derivePeriods(semi(15), 2028, 2)[1]!.end).toBe('2028-02-29');
  });

  it('⛔ clamps a cutoff that would invert or empty the second period', () => {
    // The CHECK stops 28+ being STORED; this stops it producing nonsense if it arrives another way.
    const p = derivePeriods(semi(31), 2026, 2);
    expect(p[0]!.end).toBe('2026-02-27');
    expect(p[1]).toMatchObject({ start: '2026-02-28', end: '2026-02-28' });
    expect(tilesTheMonth(p, 2026, 2)).toBe(true);
  });
});

describe('monthly and weekly', () => {
  it('monthly is one period, the whole month', () => {
    const p = derivePeriods(monthly, 2026, 8);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ start: '2026-08-01', end: '2026-08-31' });
  });

  it('⚠️ weekly windows are 7 days and the LAST one is short — periods never cross a month', () => {
    const p = derivePeriods(weekly, 2026, 8); // 31 days
    expect(p).toHaveLength(5);
    expect(p[0]).toMatchObject({ start: '2026-08-01', end: '2026-08-07' });
    expect(p[4]).toMatchObject({ start: '2026-08-29', end: '2026-08-31' }); // 3 days, not 7
  });

  it('a 28-day February is exactly four weekly windows', () => {
    const p = derivePeriods(weekly, 2026, 2);
    expect(p).toHaveLength(4);
    expect(p[3]).toMatchObject({ start: '2026-02-22', end: '2026-02-28' });
  });
});

describe('⭐ the tiling invariant v1 asserts and never checks', () => {
  it('every mode tiles every month of a leap year with no gap and no overlap', () => {
    for (const cfg of [monthly, weekly, semi(15), semi(1), semi(27)]) {
      for (const year of [2026, 2028]) {
        for (let month = 1; month <= 12; month++) {
          const p = derivePeriods(cfg, year, month);
          expect(
            tilesTheMonth(p, year, month),
            `${cfg.payrollPeriodType}/${cfg.semiMonthlyCutoffDay} ${year}-${month}`,
          ).toBe(true);
        }
      }
    }
  });

  it('⛔ and the checker is not vacuous — it rejects a gap and an overlap', () => {
    const gap = [
      { start: '2026-08-01', end: '2026-08-14', label: 'a' },
      { start: '2026-08-16', end: '2026-08-31', label: 'b' },
    ];
    const overlap = [
      { start: '2026-08-01', end: '2026-08-16', label: 'a' },
      { start: '2026-08-16', end: '2026-08-31', label: 'b' },
    ];
    const short = [{ start: '2026-08-01', end: '2026-08-30', label: 'a' }];
    expect(tilesTheMonth(gap, 2026, 8)).toBe(false);
    expect(tilesTheMonth(overlap, 2026, 8)).toBe(false);
    expect(tilesTheMonth(short, 2026, 8)).toBe(false);
    expect(tilesTheMonth([], 2026, 8)).toBe(false);
  });
});

describe('which period a date falls in', () => {
  it('finds the containing period on both sides of the cutoff', () => {
    expect(periodForDate(semi(15), '2026-08-15')!.start).toBe('2026-08-01');
    expect(periodForDate(semi(15), '2026-08-16')!.start).toBe('2026-08-16');
  });

  it('the month end belongs to the last period', () => {
    expect(periodForDate(semi(15), '2026-08-31')!.end).toBe('2026-08-31');
  });

  it('returns null for a malformed date rather than guessing', () => {
    expect(periodForDate(semi(15), 'not-a-date')).toBeNull();
    expect(periodForDate(semi(15), '2026-13-01')).toBeNull();
  });
});

const lag = (days: number) => ({ payoutMode: 'lag' as const, payoutLagDays: days, payoutDays: [] });
const onDays = (...days: number[]) => ({
  payoutMode: 'fixed_days' as const,
  payoutLagDays: 0,
  payoutDays: days,
});

describe('the payout date — lag mode', () => {
  it('is the period end plus the store lag', () => {
    const p = derivePeriods(semi(15), 2026, 8)[0]!;
    expect(payoutDateFor(p, lag(0))).toBe('2026-08-15');
    expect(payoutDateFor(p, lag(5))).toBe('2026-08-20');
  });

  it('⚠️ crosses a month boundary when the lag pushes it there', () => {
    const p = derivePeriods(semi(15), 2026, 8)[1]!; // ends 08-31
    expect(payoutDateFor(p, lag(5))).toBe('2026-09-05');
  });

  it('a negative lag is treated as none, never as paying early', () => {
    const p = derivePeriods(semi(15), 2026, 8)[0]!;
    expect(payoutDateFor(p, lag(-3))).toBe('2026-08-15');
  });
});

describe('⭐ the payout date — FIXED DAYS, which a lag cannot express', () => {
  const p = derivePeriods(semi(15), 2026, 8);

  it('pays each period on its own configured day', () => {
    // The classic Philippine arrangement: 1-15 paid on the 25th, 16-31 paid on the 10th.
    expect(payoutDateFor(p[0]!, onDays(25, 10), 0)).toBe('2026-08-25');
    expect(payoutDateFor(p[1]!, onDays(25, 10), 1)).toBe('2026-09-10'); // ⭐ NEXT month
  });

  it('⚠️ this is why a lag cannot do it — the gap differs every month', () => {
    const sept = derivePeriods(semi(15), 2026, 9);
    expect(payoutDateFor(sept[1]!, onDays(25, 10), 1)).toBe('2026-10-10');
  });

  it('⚠️ a day of 31 CLAMPS to the month end rather than being refused', () => {
    const feb = derivePeriods(semi(15), 2026, 2);
    expect(payoutDateFor(feb[1]!, onDays(31), 1)).toBe('2026-02-28');
  });

  it('⭐ fewer entries than periods is legal — the LAST one applies to the rest', () => {
    const weeks = derivePeriods(weekly, 2026, 8);
    expect(payoutDateFor(weeks[4]!, onDays(5), 4)).toBe('2026-09-05');
  });

  it('falls back to the lag when fixed_days is chosen but empty', () => {
    // ⚠️ The CHECK stops that being STORED; this is what the pure function does regardless.
    expect(
      payoutDateFor(p[0]!, { payoutMode: 'fixed_days', payoutLagDays: 2, payoutDays: [] }),
    ).toBe('2026-08-17');
  });
});
