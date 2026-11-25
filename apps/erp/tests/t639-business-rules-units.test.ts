import { describe, expect, it } from 'vitest';
import { RULE_GROUPS, inputValue, showValue } from '../src/app/settings/business-rules/lib';

/** T-639 - the rules screen shows a multiplier as "1.5×" and a count as a whole number, and groups the five rules under "Expense alerts". */
const show = (unit: string, text: string) => (showValue as (u: string, t: string) => string)(unit, text);
const input = (unit: string, text: string) => (inputValue as (u: string, t: string) => string)(unit, text);

describe('T-639 showValue / inputValue - times and count', () => {
  it('a multiplier reads with a times sign and no trailing zeros, never a percent [kills: 1.5 shown as 1.5%]', () => {
    expect(show('times', '1.500000')).toBe('1.5×');
    expect(show('times', '5.000000')).toBe('5×');
    expect(show('times', '2')).toBe('2×');
  });

  it('the multiplier box holds 1.5 and 5, the count box a whole number [kills: a box that shows 1.500000]', () => {
    expect(input('times', '1.500000')).toBe('1.5');
    expect(input('times', '5.000000')).toBe('5');
    expect(input('count', '4.000000')).toBe('4');
    expect(show('count', '4.000000')).toBe('4');
  });

  it('Expense alerts is a group on the screen', () => {
    expect(RULE_GROUPS.find((g) => g.namespace === 'expenses')).toEqual({ namespace: 'expenses', heading: 'Expense alerts' });
  });
});
