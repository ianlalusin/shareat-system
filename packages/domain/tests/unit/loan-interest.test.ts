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
    ratePercent: 2,
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
