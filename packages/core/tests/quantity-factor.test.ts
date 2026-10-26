import { describe, expect, it } from 'vitest';
import { decimal, multiplyQuantityByFactor } from '../src/money';

/**
 * T-489 (DEF-780) - purchase quantity x conversion factor, exact. Quantity is (14,3), the factor is (14,6); the product is
 * computed in scaled bigint and rounded HALF-UP away from zero ONCE, to three decimals. Every row below is one where the
 * old `Math.round(Number(factor) * 1000)` (factor at 3 decimals, product truncated) gives a different answer.
 */
const q = (v: string) => decimal(v, '14,3');
const f = (v: string) => decimal(v, '14,6');

describe('multiplyQuantityByFactor - exact scaled-bigint', () => {
  it.each([
    ['5.000', '0.0625', '0.313'], // 0.3125 -> half-up (old code: 0.063 x 5 = 0.315)
    ['1000.000', '0.0625', '62.500'], // old code: 63.000 (+0.8%)
    ['3.000', '2.204622', '6.614'], // 6.613866
    ['1.000', '0.0004', '0.000'], // genuinely below half a thousandth
    ['1.000', '0.0005', '0.001'], // exactly half -> up
    ['12.000', '12', '144.000'],
    ['0.000', '2.204622', '0.000'],
    ['7.500', '1', '7.500'],
    ['-5.000', '0.0625', '-0.313'], // away from zero
    ['-1.000', '0.0004', '0.000'],
    ['1.000', '0.000001', '0.000'], // the smallest factor the column holds
    ['99999999999.999', '1', '99999999999.999'],
  ])('%s x %s = %s', (a, b, expected) => {
    expect(multiplyQuantityByFactor(q(a), f(b))).toBe(q(expected));
  });

  it('refuses a result outside numeric(14,3) rather than wrapping it', () => {
    expect(() => multiplyQuantityByFactor(q('99999999999.999'), f('2'))).toThrow(RangeError);
  });

  it('refuses a forged non-decimal and never reaches the arithmetic', () => {
    expect(() => multiplyQuantityByFactor('NaN' as never, f('1'))).toThrow();
    expect(() => multiplyQuantityByFactor(q('1'), '' as never)).toThrow();
  });
});
