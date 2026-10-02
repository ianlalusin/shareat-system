import { describe, expect, it } from 'vitest';
import * as periods from '../src/payroll/periods';
import type { PayoutConfig, PeriodConfig } from '../src/payroll/periods';

/**
 * T-370 S3b (Amendment A3; Ian, 2026-10-01; DEF-553 payout half) — R10: in `fixed_days` mode, when the chosen day is 30,
 * the period ends on the 31st and starts on or before the 30th, the payday is the 30th of the period's OWN month
 * (otherwise the existing "on or after the end" loop runs unchanged). `docs/tasks/370-owner-cap-dates.md`, tests B1–B8.
 *
 * ⛔ TESTER. Pure unit, no database. Today `payoutDateFor` rolls a day-30 payday of a 31-day month to the NEXT month's
 * 30th (Jan 16–31 and Feb 16–28 both pay Feb 28). B1, B3, B4 (payday half), B7 and B8 are red on that; B2, B5 and B6 are
 * controls that must stay green (they pin what R10 must NOT change). The period itself never changes: `derivePeriods` is
 * untouched and the 31st stays in the second half.
 */
const semi = (cutoff: number): PeriodConfig => ({ payrollPeriodType: 'semi_monthly', semiMonthlyCutoffDay: cutoff });
const monthly: PeriodConfig = { payrollPeriodType: 'monthly', semiMonthlyCutoffDay: 15 };
const weekly: PeriodConfig = { payrollPeriodType: 'weekly', semiMonthlyCutoffDay: 15 };
const fixed = (days: number[]): PayoutConfig => ({ payoutMode: 'fixed_days', payoutLagDays: 0, payoutDays: days });
const lag0: PayoutConfig = { payoutMode: 'lag', payoutLagDays: 0, payoutDays: [] };

/** One month's paydays, in period order. */
const paydays = (p: PeriodConfig, o: PayoutConfig, y: number, m: number): string[] =>
  periods.derivePeriods(p, y, m).map((period, i) => periods.payoutDateFor(period, o, i));
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

describe('B1 — semi-monthly [15,30] pays inside its own month', () => {
  it('2026: Jan [01-15, 01-30], Feb [02-15, 02-28], Mar [03-15, 03-30], Apr [04-15, 04-30]', () => {
    const c = fixed([15, 30]);
    expect(paydays(semi(15), c, 2026, 1)).toEqual(['2026-01-15', '2026-01-30']);
    expect(paydays(semi(15), c, 2026, 2)).toEqual(['2026-02-15', '2026-02-28']);
    expect(paydays(semi(15), c, 2026, 3)).toEqual(['2026-03-15', '2026-03-30']);
    expect(paydays(semi(15), c, 2026, 4)).toEqual(['2026-04-15', '2026-04-30']);
  });
});

describe('B2 (control) — a leap February pays on the 29th', () => {
  it('2028: Feb [02-15, 02-29]', () => {
    expect(paydays(semi(15), fixed([15, 30]), 2028, 2)).toEqual(['2028-02-15', '2028-02-29']);
  });
});

describe('B3 — twelve months of [15,30]: 24 distinct paydays, no gap over 16 days', () => {
  it('every period has its own payday, and the largest gap between consecutive paydays is exactly 16', () => {
    const c = fixed([15, 30]);
    const all: string[] = [];
    for (let m = 1; m <= 12; m++) all.push(...paydays(semi(15), c, 2026, m));
    expect(new Set(all).size, 'two periods share a payday').toBe(24);
    const sorted = [...all].sort();
    const gaps = sorted.slice(1).map((d, i) => days(sorted[i]!, d));
    expect(Math.max(...gaps)).toBe(16);
    for (const g of gaps) expect(g).toBeLessThanOrEqual(16);
  });
});

describe('B4 — the 31st stays in the second half; only the payday moves', () => {
  it('January: the second period is 01-16..01-31, its payday is 01-30, and every month still tiles', () => {
    const jan = periods.derivePeriods(semi(15), 2026, 1);
    expect(jan.map((p) => [p.start, p.end])).toEqual([['2026-01-01', '2026-01-15'], ['2026-01-16', '2026-01-31']]);
    expect(periods.payoutDateFor(jan[1]!, fixed([15, 30]), 1), 'the payday rolled to next month').toBe('2026-01-30');
    for (let m = 1; m <= 12; m++) expect(periods.tilesTheMonth(periods.derivePeriods(semi(15), 2026, m), 2026, m), `month ${m}`).toBe(true);
  });
});

describe('B5 (controls) — what R10 must NOT change', () => {
  it('[10,25]: August second period (day 25, before the 31st) still rolls to 09-25 — the spec table wrote 09-10, but index 1 of [10,25] is 25', () => {
    expect(paydays(semi(15), fixed([10, 25]), 2026, 8)[1]).toBe('2026-09-25');
  });
  it('monthly fixed([10]): January pays 02-10', () => {
    expect(paydays(monthly, fixed([10]), 2026, 1)).toEqual(['2026-02-10']);
  });
  it('[15,31]: January second pays 01-31 and February 02-28 (31 clamps to month end = period end)', () => {
    const c = fixed([15, 31]);
    expect(paydays(semi(15), c, 2026, 1)[1]).toBe('2026-01-31');
    expect(paydays(semi(15), c, 2026, 2)[1]).toBe('2026-02-28');
  });
  it('[15,29]: January second still rolls to 02-28 — 29 is not generalised (only day 30, only by one day)', () => {
    expect(paydays(semi(15), fixed([15, 29]), 2026, 1)[1]).toBe('2026-02-28');
  });
  it('[15,30]: April second (ends on the 30th) pays 04-30 before and after', () => {
    expect(paydays(semi(15), fixed([15, 30]), 2026, 4)[1]).toBe('2026-04-30');
  });
  it('lag 0: January second pays 01-31 (lag mode is untouched)', () => {
    expect(paydays(semi(15), lag0, 2026, 1)[1]).toBe('2026-01-31');
  });
});

describe('B6 (control) — never before the period STARTS', () => {
  it('pure semi(30) 2026-01 (periods 1–30 and 31–31) with fixed([15,30]): the second payday is 02-28, not 01-30', () => {
    const p = periods.derivePeriods(semi(30), 2026, 1);
    expect(p.map((x) => [x.start, x.end]), 'fixture: the clamped cutoff gives a 31–31 second period').toEqual([['2026-01-01', '2026-01-30'], ['2026-01-31', '2026-01-31']]);
    expect(periods.payoutDateFor(p[1]!, fixed([15, 30]), 1)).toBe('2026-02-28');
  });
});

describe('B7 — the key is the day, not the period type: monthly [30]', () => {
  it('Jan 01-30, Feb 02-28, Mar 03-30; twelve months give twelve distinct paydays', () => {
    const c = fixed([30]);
    expect(paydays(monthly, c, 2026, 1)).toEqual(['2026-01-30']);
    expect(paydays(monthly, c, 2026, 2)).toEqual(['2026-02-28']);
    expect(paydays(monthly, c, 2026, 3)).toEqual(['2026-03-30']);
    const all: string[] = [];
    for (let m = 1; m <= 12; m++) all.push(...paydays(monthly, c, 2026, m));
    expect(new Set(all).size, 'two months share a payday').toBe(12);
    expect(all).toContain(iso(2026, 12, 30));
  });
});

describe('B8 — weekly [5,5,5,5,30]: the last window 29–31 pays on the 30th', () => {
  it('August 2026, window index 4 (29–31) => 08-30', () => {
    const p = periods.derivePeriods(weekly, 2026, 8);
    expect(p[4]).toMatchObject({ start: '2026-08-29', end: '2026-08-31' });
    expect(periods.payoutDateFor(p[4]!, fixed([5, 5, 5, 5, 30]), 4)).toBe('2026-08-30');
  });
});
