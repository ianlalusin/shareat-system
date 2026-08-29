import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { splitVariance } from '../../src/stock/invoice-link';
import { quantity } from '../../src/stock/quantity';

/**
 * T-163 — how a purchase price variance divides between stock still on the shelf and stock
 * already eaten.
 *
 * ⛔ **These cases correct T-163's own spec.** Its test 4 said *"the 60 open re-value; the 40
 * consumed keep ₱300; `5450` takes ₱600"* — but ₱600 is `60 × ₱10`, the OPEN share, which belongs
 * to inventory. The consumed share is `40 × ₱10 = ₱400`. Written out here with the arithmetic
 * shown, because a swapped pair of numbers reads perfectly well and is wrong in a way no reviewer
 * catches by eye.
 */

describe('splitVariance — Ian’s worked case', () => {
  it('⭐ 100 kg at ₱300, 40 consumed, invoice says ₱310 — inventory ₱600, 5450 ₱400', () => {
    // Variance = 100 × ₱10 = ₱1,000. Of that, 60 kg is still on the shelf and re-costs; the
    // 40 kg already consumed posted COGS at ₱300 in a period that may be closed.
    const split = splitVariance(money('1000.00'), quantity('60'), quantity('100'));

    expect(split.inventoryShare).toBe(money('600.00'));
    expect(split.consumedShare).toBe(money('400.00'));
    expect(split.total).toBe(money('1000.00'));
  });

  it('⭐ the two shares always sum to the total, exactly', () => {
    // The property that makes the journal entry balance. Rounding both independently is how a
    // one-centavo hole appears in an entry that looks right on both sides.
    for (const open of ['0', '1', '7', '33.333', '99.999', '100']) {
      const s = splitVariance(money('1000.01'), quantity(open), quantity('100'));
      const sum = BigInt(s.inventoryShare.replace('.', '')) + BigInt(s.consumedShare.replace('.', ''));
      expect(money(sum)).toBe(money('1000.01'));
    }
  });

  it('nothing consumed — the whole variance re-costs the stock', () => {
    const split = splitVariance(money('1000.00'), quantity('100'), quantity('100'));
    expect(split.inventoryShare).toBe(money('1000.00'));
    expect(split.consumedShare).toBe(money('0.00'));
  });

  it('⭐ everything consumed — the whole variance goes to 5450, and this is the case the spec could not express', () => {
    // T-163 also said "within tolerance, no 5450 line". With nothing open there is no remainder to
    // absorb the difference, so that reading makes the entry unbalanceable. Hence: the tolerance
    // governs the FINDING, never where the money goes.
    const split = splitVariance(money('1000.00'), quantity('0'), quantity('100'));
    expect(split.inventoryShare).toBe(money('0.00'));
    expect(split.consumedShare).toBe(money('1000.00'));
  });

  it('a CHEAPER invoice splits the same way, with both shares negative', () => {
    const split = splitVariance(money('-1000.00'), quantity('60'), quantity('100'));
    expect(split.inventoryShare).toBe(money('-600.00'));
    expect(split.consumedShare).toBe(money('-400.00'));
  });
});

describe('splitVariance — rounding and edges', () => {
  it('rounds the inventory share half-up and gives the remainder to 5450', () => {
    // ₱1.00 across a one-third open share: 0.333… rounds to ₱0.33, and ₱0.67 is the remainder.
    const split = splitVariance(money('1.00'), quantity('1'), quantity('3'));
    expect(split.inventoryShare).toBe(money('0.33'));
    expect(split.consumedShare).toBe(money('0.67'));
  });

  it('a receipt of nothing puts the whole difference in 5450 rather than dividing by zero', () => {
    const split = splitVariance(money('5.00'), quantity('0'), quantity('0'));
    expect(split.consumedShare).toBe(money('5.00'));
    expect(split.inventoryShare).toBe(money('0.00'));
  });

  it('⚠️ an open quantity above what was received is clamped, not trusted', () => {
    // A caller passing a stale open figure must not be able to invent inventory value.
    const split = splitVariance(money('100.00'), quantity('500'), quantity('100'));
    expect(split.inventoryShare).toBe(money('100.00'));
    expect(split.consumedShare).toBe(money('0.00'));
  });

  it('a zero variance splits into two zeroes', () => {
    const split = splitVariance(money('0.00'), quantity('50'), quantity('100'));
    expect(split.inventoryShare).toBe(money('0.00'));
    expect(split.consumedShare).toBe(money('0.00'));
  });
});

describe('splitVariance — the ₱0.99 tolerance is advisory', () => {
  it('⭐ flags small variances without changing where the money goes', () => {
    const small = splitVariance(money('0.60'), quantity('50'), quantity('100'));
    expect(small.withinTolerance).toBe(true);
    // Still split, still posted — the flag is for a human, not for the ledger.
    expect(small.inventoryShare).toBe(money('0.30'));
    expect(small.consumedShare).toBe(money('0.30'));
  });

  it('₱0.99 exactly is inside; ₱1.00 is outside', () => {
    expect(splitVariance(money('0.99'), quantity('0'), quantity('1')).withinTolerance).toBe(true);
    expect(splitVariance(money('1.00'), quantity('0'), quantity('1')).withinTolerance).toBe(false);
  });

  it('tolerance is on the MAGNITUDE, so a cheap invoice is judged the same way', () => {
    expect(splitVariance(money('-0.99'), quantity('0'), quantity('1')).withinTolerance).toBe(true);
    expect(splitVariance(money('-1.00'), quantity('0'), quantity('1')).withinTolerance).toBe(false);
  });
});
