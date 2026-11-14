/**
 * T-570 AUDIT - `tryMoney` is the one client reader of a money box, and the box now HOLDS the grouped text.
 * It must read a correct grouping exactly, and still refuse a wrong one (DEF-383).
 */
import { describe, expect, it } from 'vitest';
import { totalOfLines, tryMoney } from '../../src/shared/money-lines';

describe('tryMoney reads what a number box shows', () => {
  it.each([
    ['1,200', '1200.00'],
    ['1,234.50', '1234.50'],
    ['1,234,567.89', '1234567.89'],
    ['-1,200', '-1200.00'],
    ['230.00', '230.00'],
    [' 1,200 ', '1200.00'],
  ])('%s -> %s', (raw, want) => {
    expect(String(tryMoney(raw))).toBe(want);
  });

  it.each(['1,5', '12,5', '16,98,0', '0,500', '1e3', 'abc', '', '   '])('%j is not an amount', (raw) => {
    expect(tryMoney(raw)).toBeNull();
  });

  it('totalOfLines adds grouped amounts exactly', () => {
    const lines = [{ amount: '1,200' }, { amount: '1,234.50' }] as never;
    expect(String(totalOfLines(lines))).toBe('2434.50');
  });
});
