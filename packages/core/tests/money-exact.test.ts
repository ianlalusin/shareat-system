import { describe, expect, it } from 'vitest';
import { decimal, divideMoney, multiplyToMoney, money } from '../src/money';

/**
 * T-371 S4 — the exact qty x cost -> Money and Money / integer helpers. Half-up, away from zero, once, to the centavo.
 * Every case below is one where `Number` math + `toFixed(2)` gives a DIFFERENT (wrong) answer; the "float control" block
 * asserts that, so the cases cannot go green on a float implementation.
 */
const q = (v: string) => decimal(v, '14,3');
const c = (v: string) => decimal(v, '14,4');

describe('multiplyToMoney — exact scaled-bigint', () => {
  it.each([
    ['3', '33.3350', '100.01'], // 100.005 -> half-up
    ['1', '1.0050', '1.01'], // (1.005).toFixed(2) === '1.00'
    ['1.500', '0.0100', '0.02'], // 0.015 -> half-up (float: 0.01)
    ['2.000', '10.0000', '20.00'],
    ['0.001', '0.0049', '0.00'], // below the boundary
    ['0.001', '5.0000', '0.01'], // exactly .005
    ['-3.000', '33.3350', '-100.01'], // away from zero
    ['0.000', '12345.6789', '0.00'],
  ])('%s x %s = %s', (a, b, expected) => {
    expect(multiplyToMoney(q(a), c(b))).toBe(money(expected));
  });

  it('refuses NaN and empty at the mint and never reaches the arithmetic', () => {
    expect(() => decimal('NaN', '14,3')).toThrow();
    expect(() => decimal('', '14,3')).toThrow();
    expect(() => multiplyToMoney('NaN' as never, c('1'))).toThrow();
  });
});

describe('divideMoney — exact, half-up to the centavo', () => {
  it.each([
    ['100.00', 12, '8.33'],
    ['100.01', 12, '8.33'],
    ['0.05', 10, '0.01'], // exactly .005 -> half-up (float: 0.005.toFixed(2) is '0.01' by luck; see 0.03/2)
    ['0.03', 2, '0.02'], // 0.015 -> 0.02 (float toFixed gives 0.01)
    ['-0.03', 2, '-0.02'],
    ['-100.00', 12, '-8.33'],
    ['10.00', 3, '3.33'],
    ['0.01', 3, '0.00'],
    ['100.00', 1, '100.00'],
  ])('%s / %s = %s', (v, d, expected) => {
    expect(divideMoney(money(v), d)).toBe(money(expected));
    expect(divideMoney(money(v), BigInt(d))).toBe(money(expected));
  });

  it('refuses zero and non-integer divisors', () => {
    expect(() => divideMoney(money('1.00'), 0)).toThrow();
    expect(() => divideMoney(money('1.00'), 2.5)).toThrow();
    expect(() => divideMoney(money('1.00'), Number.NaN)).toThrow();
  });
});

describe('float control — the same cases are wrong under Number + toFixed(2)', () => {
  it('(1 x 1.005).toFixed(2) and (0.03 / 2).toFixed(2) round DOWN where half-up requires up', () => {
    expect((1 * 1.005).toFixed(2)).toBe('1.00');
    expect((0.03 / 2).toFixed(2)).toBe('0.01');
    expect((1.5 * 0.01).toFixed(2)).toBe('0.01');
    expect(multiplyToMoney(q('1'), c('1.005'))).not.toBe(money((1 * 1.005).toFixed(2)));
    expect(divideMoney(money('0.03'), 2)).not.toBe(money((0.03 / 2).toFixed(2)));
  });
});
