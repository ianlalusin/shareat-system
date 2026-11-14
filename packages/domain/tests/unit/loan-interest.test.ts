import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import {
  accruedInterest,
  dailyRate,
  scheduledInstalment,
  splitPayment,
} from '../../src/loans/interest';

/**
 * T-126 §4 — the split v1 leaves to whoever types it.
 *
 * ⭐ The cases here are drawn from the two real Grab loans the ERPNext migration measured, because
 * they are the shape this business actually borrows in: straight-line, quoted monthly, repaid by
 * whatever the day's net allows.
 */
describe('dailyRate', () => {
  it('⚠️ a month is 30 days and a year is 365 — not interchangeable', () => {
    // v1 wrote this down after being bitten: the same "2" means twelve-and-a-bit times more when
    // it is monthly than when it is annual, and nothing on the number says which it is.
    expect(dailyRate(2, 'month')).toBeCloseTo(0.02 / 30, 10);
    expect(dailyRate(2, 'year')).toBeCloseTo(0.02 / 365, 10);
    expect(dailyRate(2, 'day')).toBeCloseTo(0.02, 10);
    expect(dailyRate(2, 'month') / dailyRate(2, 'year')).toBeCloseTo(365 / 30, 6);
  });
});

describe('accruedInterest', () => {
  const base = {
    ratePercent: '2',
    ratePeriod: 'month' as const,
    principal: money('200000.00'),
  };

  it("⭐ STRAIGHT charges the ORIGINAL principal — paying early does not reduce it", () => {
    // Grab's Loan A: ₱200,000 at 2%/month straight. Half repaid, and the interest is unchanged —
    // which is exactly why the total cost of a straight loan is fixed the day it is signed.
    const halfway = accruedInterest({
      ...base,
      method: 'straight',
      outstanding: money('100000.00'),
      since: '2026-05-11',
      until: '2026-05-12',
    });
    const untouched = accruedInterest({
      ...base,
      method: 'straight',
      outstanding: money('200000.00'),
      since: '2026-05-11',
      until: '2026-05-12',
    });
    expect(halfway).toBe(untouched);
    // 200,000 × 0.02/30 × 1 day
    expect(halfway).toBe('133.33');
  });

  it('⭐ AMORTIZING charges the OUTSTANDING balance — so repaying early costs less', () => {
    const full = accruedInterest({
      ...base,
      method: 'amortizing',
      outstanding: money('200000.00'),
      since: '2026-05-11',
      until: '2026-05-12',
    });
    const half = accruedInterest({
      ...base,
      method: 'amortizing',
      outstanding: money('100000.00'),
      since: '2026-05-11',
      until: '2026-05-12',
    });
    expect(full).toBe('133.33');
    expect(half).toBe('66.67');
  });

  it('accrues nothing over zero days, and nothing on a cleared loan', () => {
    expect(
      accruedInterest({ ...base, method: 'amortizing', outstanding: money('1000.00'), since: '2026-05-11', until: '2026-05-11' }),
    ).toBe('0.00');
    expect(
      accruedInterest({ ...base, method: 'amortizing', outstanding: money('0.00'), since: '2026-05-11', until: '2026-06-11' }),
    ).toBe('0.00');
  });

  it('⚠️ a backwards date range accrues nothing rather than going negative', () => {
    const r = accruedInterest({
      ...base,
      method: 'straight',
      outstanding: money('200000.00'),
      since: '2026-06-11',
      until: '2026-05-11',
    });
    // Negative interest would be a refund the lender never offered.
    expect(r).toBe('0.00');
  });
});

describe('splitPayment — interest first, principal second', () => {
  it('⭐ a payment SMALLER than the instalment still services interest first', () => {
    // The normal case, not the exception: "the history shows Grab repeatedly deducting less than
    // the instalment when the day's net is small."
    const r = splitPayment({
      payment: money('100.00'),
      outstanding: money('50000.00'),
      accrued: money('133.33'),
    });
    // ⚠️ It retires NO principal. A split that quietly moved some to principal would show a debt
    // shrinking on a day it did not.
    expect(r).toEqual({ interest: '100.00', principal: '0.00', overpayment: '0.00' });
  });

  it('covers interest then puts the rest on principal', () => {
    const r = splitPayment({
      payment: money('2355.56'),
      outstanding: money('50000.00'),
      accrued: money('133.33'),
    });
    expect(r.interest).toBe('133.33');
    expect(r.principal).toBe('2222.23');
    expect(r.overpayment).toBe('0.00');
  });

  it('⛔ principal never exceeds what is outstanding — the excess is an OVERPAYMENT', () => {
    const r = splitPayment({
      payment: money('10000.00'),
      outstanding: money('5000.00'),
      accrued: money('100.00'),
    });
    expect(r.interest).toBe('100.00');
    expect(r.principal).toBe('5000.00');
    // ⛔ Returned separately so the caller must decide. Absorbing it into principal would make a
    // negative loan; hiding it would make the lender's refund disappear.
    expect(r.overpayment).toBe('4900.00');
  });

  it('a zero or negative payment splits into nothing', () => {
    for (const p of ['0.00', '-50.00']) {
      expect(splitPayment({ payment: money(p), outstanding: money('100.00'), accrued: money('5.00') })).toEqual({
        interest: '0.00',
        principal: '0.00',
        overpayment: '0.00',
      });
    }
  });

  it('every split adds back up to the payment', () => {
    const cases = [
      ['1000.00', '5000.00', '133.33'],
      ['133.33', '5000.00', '133.33'],
      ['9999.99', '100.00', '0.01'],
    ] as const;
    for (const [pay, out, acc] of cases) {
      const r = splitPayment({ payment: money(pay), outstanding: money(out), accrued: money(acc) });
      const sum = Number(r.interest) + Number(r.principal) + Number(r.overpayment);
      expect(sum.toFixed(2)).toBe(Number(pay).toFixed(2));
    }
  });
});

describe('scheduledInstalment', () => {
  it("⭐ straight: Grab's Loan A quote, ₱2,355.56/day", () => {
    // ₱200,000 at 2%/month straight over 90 daily instalments. The migration doc records the real
    // figure as ₱2,355.56/day, which is what this must reproduce.
    const r = scheduledInstalment({
      principal: money('200000.00'),
      ratePercent: 2,
      ratePeriod: 'month',
      method: 'straight',
      periods: 90,
      daysPerPeriod: 1,
    });
    expect(r).toBe('2355.56');
  });

  it('amortizing costs less than straight for the same terms', () => {
    const terms = {
      principal: money('200000.00'),
      ratePercent: 2,
      ratePeriod: 'month' as const,
      periods: 12,
      daysPerPeriod: 30,
    };
    const straight = Number(scheduledInstalment({ ...terms, method: 'straight' }));
    const amortizing = Number(scheduledInstalment({ ...terms, method: 'amortizing' }));
    // ⭐ Because amortizing charges the shrinking balance while straight charges the original.
    expect(amortizing).toBeLessThan(straight);
  });

  it('⚠️ equal_principal reports the FIRST instalment, which is the largest', () => {
    const r = scheduledInstalment({
      principal: money('120000.00'),
      ratePercent: 2,
      ratePeriod: 'month',
      method: 'equal_principal',
      periods: 12,
      daysPerPeriod: 30,
    });
    // 10,000 principal + 2,400 interest on the full balance in month one. A single number cannot
    // describe this method honestly, so it reports the one a borrower must be able to afford.
    expect(r).toBe('12400.00');
  });

  it('⛔ a zero rate does not divide by zero', () => {
    const r = scheduledInstalment({
      principal: money('12000.00'),
      ratePercent: 0,
      ratePeriod: 'month',
      method: 'amortizing',
      periods: 12,
      daysPerPeriod: 30,
    });
    // The annuity formula has (factor − 1) underneath, which is 0 when the rate is 0 — the classic
    // way this blows up.
    expect(r).toBe('1000.00');
  });
});

/**
 * T-573 (DEF-841) — interest is exact: scaled bigint from the stored decimal rate string, half-up to the centavo, ONE rounding.
 * Every `want` below is hand-computed: base × rate% × days / (100 × 1|30|365). The float formula this replaced lands a centavo
 * low on a half-centavo tie (0.365 is not representable) and loses the last digits on a ₱5M+ balance.
 */
describe('accruedInterest — exact (DEF-841)', () => {
  const run = (o: { base: string; rate: string; period: 'day' | 'month' | 'year'; days: number; method?: 'straight' | 'amortizing' | 'equal_principal' }) => {
    // 2026-01-01 + days, in UTC date arithmetic (no leap-day surprises inside the cases below).
    const until = new Date(Date.parse('2026-01-01T00:00:00Z') + o.days * 86_400_000).toISOString().slice(0, 10);
    return accruedInterest({
      outstanding: money(o.base),
      principal: money(o.base),
      ratePercent: o.rate,
      ratePeriod: o.period,
      method: o.method ?? 'amortizing',
      since: '2026-01-01',
      until,
    });
  };

  const table: readonly [string, Parameters<typeof run>[0], string][] = [
    ['₱5,000,000 at 36%/yr for 365 days is exactly 1,800,000', { base: '5000000.00', rate: '36', period: 'year', days: 365 }, '1800000.00'],
    ['₱5,000,000.01 at 36.5%/day for 100 days (large base; float is a centavo low)', { base: '5000000.01', rate: '36.5', period: 'day', days: 100 }, '182500000.37'],
    ['₱99,999,999,999.99 at 36%/yr for 365 days = 35,999,999,999.9964, rounds to 36,000,000,000.00', { base: '99999999999.99', rate: '36', period: 'year', days: 365 }, '36000000000.00'],
    ['tiny balance ₱0.01 for a year at 2%/month rounds to 0', { base: '0.01', rate: '2', period: 'month', days: 30 }, '0.00'],
    ['half-centavo tie rounds UP: ₱0.50 at 36.5%/day for 2 days = 0.365', { base: '0.50', rate: '36.5', period: 'day', days: 2 }, '0.37'],
    ['half-centavo tie rounds UP: ₱0.50 at 36.5%/yr for 90 days = 0.045', { base: '0.50', rate: '36.5', period: 'year', days: 90 }, '0.05'],
    ['just under a tie stays down: ₱0.50 at 36.4%/day for 2 days = 0.364', { base: '0.50', rate: '36.4', period: 'day', days: 2 }, '0.36'],
    ['day: ₱1,000 at 0.1%/day for 30 days', { base: '1000.00', rate: '0.1', period: 'day', days: 30 }, '30.00'],
    ['month: ₱200,000 at 2%/month for 1 day = 133.333…', { base: '200000.00', rate: '2', period: 'month', days: 1 }, '133.33'],
    ['month: ₱200,000 at 2%/month for 30 days', { base: '200000.00', rate: '2', period: 'month', days: 30 }, '4000.00'],
    ['year: ₱200,000 at 12.3456%/yr for 100 days (4-dp rate)', { base: '200000.00', rate: '12.3456', period: 'year', days: 100 }, '6764.71'],
    ['stored form "2.0000" equals "2"', { base: '200000.00', rate: '2.0000', period: 'month', days: 1 }, '133.33'],
    ['zero rate accrues nothing', { base: '200000.00', rate: '0', period: 'month', days: 30 }, '0.00'],
    ['straight method: charged on the principal', { base: '200000.00', rate: '2', period: 'month', days: 15, method: 'straight' }, '2000.00'],
    ['equal_principal method: charged on the outstanding', { base: '200000.00', rate: '2', period: 'month', days: 15, method: 'equal_principal' }, '2000.00'],
  ];
  it.each(table)('%s', (_name, input, want) => {
    expect(run(input)).toBe(want);
  });

  it('refuses a rate that is not a plain non-negative decimal (no float coercion, no exponent form)', () => {
    for (const bad of ['', 'abc', '-1', '1e2', '1,5', 'NaN']) {
      expect(() => run({ base: '100.00', rate: bad, period: 'day', days: 1 })).toThrow();
    }
  });
});
