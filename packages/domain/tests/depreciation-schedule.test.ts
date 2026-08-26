import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { buildSchedule, periodDue, periodsThrough, expectedAccumulated } from '../src/fixed-assets/schedule';

/**
 * The depreciation arithmetic, proven without a database.
 *
 * ⭐ **These are the cases where depreciation goes quietly wrong**: an asset that never quite
 * reaches salvage, one that overshoots it, and a schedule that loses centavos to rounding and
 * leaves a register a few pesos off forever — the kind of error nobody ever finds time to chase.
 */

const base = {
  acquiredOn: '2026-01-15',
  cost: money('120000'),
  salvageValue: money('0'),
  usefulLifeYears: 5,
  interval: 'monthly' as const,
};

const sum = (xs: { amount: unknown }[]) => xs.reduce((a, x) => a + Number(x.amount), 0);

describe('the schedule covers exactly the depreciable amount', () => {
  it('60 monthly periods over 5 years, summing to cost − salvage', () => {
    const s = buildSchedule(base);
    expect(s.length).toBe(60);
    expect(sum(s)).toBe(120000);
    expect(Number(s[59]!.accumulatedAfter)).toBe(120000);
  });

  it('salvage is respected — it depreciates cost MINUS salvage, never the whole cost', () => {
    const s = buildSchedule({ ...base, cost: money('100000'), salvageValue: money('10000') });
    expect(sum(s)).toBe(90000);
    // ⭐ Book value at the end is exactly salvage. Depreciating below it would be inventing a loss.
    expect(100000 - Number(s[s.length - 1]!.accumulatedAfter)).toBe(10000);
  });

  it('⭐ an amount that does NOT divide evenly still sums exactly — the remainder goes to the last period', () => {
    // ₱10,000 over 3 years monthly = 36 periods of 277.777… A naive split loses centavos forever.
    const s = buildSchedule({ ...base, cost: money('10000'), usefulLifeYears: 3 });
    expect(s.length).toBe(36);
    expect(sum(s)).toBeCloseTo(10000, 2);

    const amounts = new Set(s.map((p) => String(p.amount)));
    // Exactly two distinct amounts: the even instalment, and the last one carrying the remainder.
    expect(amounts.size).toBe(2);
    expect(Number(s[0]!.amount)).toBe(277.77);
    expect(Number(s[35]!.amount)).toBeGreaterThan(277.77);
  });

  it('every earlier period is identical — that is what "straight line" means to a reader', () => {
    const s = buildSchedule({ ...base, cost: money('10000'), usefulLifeYears: 3 });
    const allButLast = new Set(s.slice(0, -1).map((p) => String(p.amount)));
    expect(allButLast.size).toBe(1);
  });
});

describe('intervals', () => {
  it('quarterly gives 4 periods a year, and each entry dates at the END of its quarter', () => {
    const s = buildSchedule({ ...base, acquiredOn: '2026-01-01', usefulLifeYears: 1, interval: 'quarterly' });
    expect(s.length).toBe(4);
    expect(s.map((p) => p.period)).toEqual(['2026-03', '2026-06', '2026-09', '2026-12']);
    // ⚠️ A charge must land INSIDE the period it describes, or it lands in the wrong month's books.
    expect(s[0]!.entryDate).toBe('2026-03-31');
    expect(s[3]!.entryDate).toBe('2026-12-31');
  });

  it('annually gives one period a year, each ending in the same month', () => {
    // ⚠️ My first expectation here was 2026-12 / 2027-11 / 2028-10 — I stepped the END month
    // forward by 11 each time instead of stepping the START by 12. The code was right and the
    // test was wrong, which is the more useful way round for a test to fail.
    const s = buildSchedule({ ...base, acquiredOn: '2026-01-01', usefulLifeYears: 3, interval: 'annually' });
    expect(s.length).toBe(3);
    expect(s.map((p) => p.period)).toEqual(['2026-12', '2027-12', '2028-12']);
    expect(s.map((p) => p.entryDate)).toEqual(['2026-12-31', '2027-12-31', '2028-12-31']);
  });

  it('an annual asset acquired mid-year ends its periods mid-year too', () => {
    const s = buildSchedule({ ...base, acquiredOn: '2026-07-01', usefulLifeYears: 2, interval: 'annually' });
    expect(s.map((p) => p.period)).toEqual(['2027-06', '2028-06']);
  });

  it('monthly entry dates handle February and leap years without a lookup table', () => {
    const s = buildSchedule({ ...base, acquiredOn: '2027-02-10', usefulLifeYears: 1 });
    expect(s[0]!.entryDate).toBe('2027-02-28');
    const leap = buildSchedule({ ...base, acquiredOn: '2028-02-10', usefulLifeYears: 1 });
    expect(leap[0]!.entryDate).toBe('2028-02-29');
  });
});

describe('periodDue — null, never a zero charge', () => {
  it('returns the charge for a period the asset owes', () => {
    const due = periodDue(base, '2026-03');
    expect(due).not.toBeNull();
    expect(Number(due!.amount)).toBe(2000);
  });

  it('⚠️ returns NULL before acquisition and after the life ends — not a zero', () => {
    // A zero entry would say "nothing happened" in the ledger, and would hide exactly the signal
    // the OIL finding depends on: an active asset with NO depreciation posted for a closed period.
    expect(periodDue(base, '2025-12')).toBeNull();
    expect(periodDue(base, '2031-06')).toBeNull();
  });

  it('a quarterly asset owes nothing in the months between its quarters', () => {
    const q = { ...base, acquiredOn: '2026-01-01', interval: 'quarterly' as const };
    expect(periodDue(q, '2026-03')).not.toBeNull();
    expect(periodDue(q, '2026-04')).toBeNull();
  });

  it('a fully-depreciated asset owes nothing more, ever', () => {
    const s = buildSchedule(base);
    expect(periodDue(base, s[59]!.period)).not.toBeNull();
    expect(periodDue(base, '2031-01')).toBeNull();
  });
});

describe('⭐ catch-up — the DEF-044 answer', () => {
  it('periodsThrough returns every period owed so far, so a missed run is just running it again', () => {
    // v1's scheduler stopped for two months and nobody noticed. With an idempotent posting per
    // period, catching up is not a repair script — it is the same call, and the already-posted
    // periods no-op.
    const through = periodsThrough(base, '2026-05');
    expect(through.map((p) => p.period)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
  });

  it('expectedAccumulated is what the LEDGER should show — the figure to compare against', () => {
    // Never stored. This is the expectation; the ledger sum is the fact. A gap between them is
    // the finding.
    expect(Number(expectedAccumulated(base, '2026-05'))).toBe(10000);
    expect(Number(expectedAccumulated(base, '2025-12'))).toBe(0);
  });
});

describe('degenerate inputs produce nothing rather than nonsense', () => {
  it('salvage equal to cost depreciates nothing', () => {
    expect(buildSchedule({ ...base, cost: money('5000'), salvageValue: money('5000') })).toEqual([]);
  });

  it('a zero or negative life produces no schedule', () => {
    expect(buildSchedule({ ...base, usefulLifeYears: 0 })).toEqual([]);
    expect(buildSchedule({ ...base, usefulLifeYears: -1 })).toEqual([]);
  });
});

describe('the per-category lives produce sane schedules (bible row 139)', () => {
  it.each([
    ['building', 20, 240],
    ['machinery', 10, 120],
    ['equipment', 7, 84],
    ['furniture_and_fixture', 5, 60],
    ['vehicles', 5, 60],
    ['smallwares', 3, 36],
  ])('%s at %i years is %i monthly periods', (_cat, years, expected) => {
    expect(buildSchedule({ ...base, usefulLifeYears: years as number }).length).toBe(expected);
  });
});
