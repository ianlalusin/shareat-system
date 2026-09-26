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
  startsOn: '2026-01-15',
  cost: money('120000'),
  salvageValue: money('0'),
  usefulLifeMonths: 60,
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
    const s = buildSchedule({ ...base, cost: money('10000'), usefulLifeMonths: 36 });
    expect(s.length).toBe(36);
    expect(sum(s)).toBeCloseTo(10000, 2);

    const amounts = new Set(s.map((p) => String(p.amount)));
    // Exactly two distinct amounts: the even instalment, and the last one carrying the remainder.
    expect(amounts.size).toBe(2);
    expect(Number(s[0]!.amount)).toBe(277.77);
    expect(Number(s[35]!.amount)).toBeGreaterThan(277.77);
  });

  it('every earlier period is identical — that is what "straight line" means to a reader', () => {
    const s = buildSchedule({ ...base, cost: money('10000'), usefulLifeMonths: 36 });
    const allButLast = new Set(s.slice(0, -1).map((p) => String(p.amount)));
    expect(allButLast.size).toBe(1);
  });
});

describe('intervals', () => {
  it('quarterly gives 4 periods a year, and each entry dates at the END of its quarter', () => {
    const s = buildSchedule({ ...base, startsOn: '2026-01-01', usefulLifeMonths: 12, interval: 'quarterly' });
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
    const s = buildSchedule({ ...base, startsOn: '2026-01-01', usefulLifeMonths: 36, interval: 'annually' });
    expect(s.length).toBe(3);
    expect(s.map((p) => p.period)).toEqual(['2026-12', '2027-12', '2028-12']);
    expect(s.map((p) => p.entryDate)).toEqual(['2026-12-31', '2027-12-31', '2028-12-31']);
  });

  it('an annual asset acquired mid-year ends its periods mid-year too', () => {
    const s = buildSchedule({ ...base, startsOn: '2026-07-01', usefulLifeMonths: 24, interval: 'annually' });
    expect(s.map((p) => p.period)).toEqual(['2027-06', '2028-06']);
  });

  it('monthly entry dates handle February and leap years without a lookup table', () => {
    const s = buildSchedule({ ...base, startsOn: '2027-02-10', usefulLifeMonths: 12 });
    expect(s[0]!.entryDate).toBe('2027-02-28');
    const leap = buildSchedule({ ...base, startsOn: '2028-02-10', usefulLifeMonths: 12 });
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
    const q = { ...base, startsOn: '2026-01-01', interval: 'quarterly' as const };
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
    expect(buildSchedule({ ...base, usefulLifeMonths: 0 })).toEqual([]);
    expect(buildSchedule({ ...base, usefulLifeMonths: -12 })).toEqual([]);
  });
});

describe('lives are MONTHS now, and the default is 24 (bible row 140)', () => {
  it('the default life of 24 months is 24 monthly periods', () => {
    expect(buildSchedule({ ...base, usefulLifeMonths: 24 }).length).toBe(24);
  });

  // Row 139's per-category YEARS are superseded by row 140, but the arithmetic they exercised is
  // still worth pinning — expressed in the unit the column now carries.
  it.each([
    ['building', 240],
    ['machinery', 120],
    ['equipment', 84],
    ['furniture_and_fixture', 60],
    ['vehicles', 60],
    ['smallwares', 36],
  ])('%s at %i months is that many monthly periods', (_cat, months) => {
    expect(buildSchedule({ ...base, usefulLifeMonths: months as number }).length).toBe(months);
  });

  it('a life that is not a whole number of years is now expressible at all', () => {
    // The point of row 140. v1 stored years, so 30 months became 2.5 and any consumer reading it
    // as an integer silently lost six months.
    const s30 = buildSchedule({ ...base, usefulLifeMonths: 30 });
    expect(s30.length).toBe(30);
    expect(sum(s30)).toBe(120000);
  });
});

describe('semi-annual (bible row 140)', () => {
  it('charges twice a year, on the last day of each half', () => {
    const s = buildSchedule({
      ...base,
      startsOn: '2026-01-01',
      usefulLifeMonths: 24,
      interval: 'semiannual',
    });
    expect(s.length).toBe(4);
    expect(s.map((p) => p.entryDate)).toEqual(['2026-06-30', '2026-12-31', '2027-06-30', '2027-12-31']);
    expect(sum(s)).toBe(120000);
  });

  it('sits between quarterly and annual, and all four agree on the total', () => {
    const of = (interval: 'monthly' | 'quarterly' | 'semiannual' | 'annually') =>
      buildSchedule({ ...base, startsOn: '2026-01-01', usefulLifeMonths: 24, interval });
    expect([of('monthly').length, of('quarterly').length, of('semiannual').length, of('annually').length])
      .toEqual([24, 8, 4, 2]);
    // ⭐ The interval changes how often it charges, never how much it charges in total.
    for (const i of ['monthly', 'quarterly', 'semiannual', 'annually'] as const) {
      expect(sum(of(i))).toBe(120000);
    }
  });
});

describe('a life that does not divide evenly by its interval', () => {
  it('CEILS to a stub final period rather than stopping short of the life', () => {
    // 25 months charged quarterly is 8 1/3 periods. Rounding down would stop depreciating at
    // month 24 and leave value on the books that the life says is gone.
    const s = buildSchedule({ ...base, usefulLifeMonths: 25, interval: 'quarterly' });
    expect(s.length).toBe(9);
    expect(sum(s)).toBe(120000);
  });
});
