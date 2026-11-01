/**
 * T-504 item 7 (TESTER) - thousands commas in the SHARED money-input parser (`parseDecimalInput` / `parseMoneyInput`,
 * packages/domain/src/shared/money-input.ts). The sentence 'The amount for "Foodpanda" - "16,980" is not a valid amount.
 * Use at most two decimal places.' comes from `parseDecimalInput`'s catch block (decimal() refuses the comma). Every form
 * that goes through it benefits, so this is a unit test on the parser, not on sales days.
 */
import { describe, expect, it } from 'vitest';
import { parseDecimalInput, parseMoneyInput } from '../src/shared/money-input';

const parse = (raw: string) => parseMoneyInput(raw, 'x', 'The amount for "Foodpanda"');
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return String((e as { userMessage?: string }).userMessage);
  }
  return '';
};

describe('valid groupings parse, and the stored value never holds a comma', () => {
  it.each([
    ['16,980', '16980.00'],
    ['16,980.50', '16980.50'],
    ['1,234,567.8', '1234567.80'],
    ['999,999,999,999.99', '999999999999.99'],
    ['  16,980  ', '16980.00'],
  ])('%s', (raw, want) => {
    expect(parse(raw)).toBe(want);
  });
  it('plain input is unchanged ("16980", "0.5", "0")', () => {
    expect([parse('16980'), parse('0.5'), parse('0')]).toEqual(['16980.00', '0.50', '0.00']);
  });
  it('a 14,3 quantity accepts commas too ("1,200.125")', () => {
    expect(parseDecimalInput('1,200.125', '14,3', 'q', 'The quantity')).toBe('1200.125');
  });
});

describe('wrong groupings are refused with the EXISTING sentence', () => {
  it.each(['1,5', '16,98,0', ',100', '1,,000', '16,980,', '1,0000', '12,34', '1,000.5,0', '1.000,50', ',', '1, 000', '0,500', '01,000', '00,100'])('%s', (raw) => {
    expect(messageOf(() => parse(raw))).toBe(`The amount for "Foodpanda" — "${raw}" is not a valid amount. Use at most two decimal places.`);
  });
  it('an over-large comma figure still gets the "too large" sentence, not "not valid"', () => {
    expect(messageOf(() => parse('1,000,000,000,000'))).toMatch(/is too large/);
  });
});
