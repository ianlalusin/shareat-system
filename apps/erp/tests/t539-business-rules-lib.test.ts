import { describe, expect, it } from 'vitest';
import { RULE_GROUPS, inputValue, showValue } from '../src/app/settings/business-rules/lib';

/**
 * T-539 S1 TESTER - the business-rules screen's display helpers learn the `hour` unit and the POS group. docs/tasks/539-pos-business-rule-keys.md R2, R5.
 *
 * RED today: `showValue('hour', ...)` renders "4.000000%"-style text (the non-money branch is the percent branch), `inputValue('hour', ...)` trims like a percent only by
 * accident, and RULE_GROUPS has no POS entry.
 *
 * ASSUMPTION: the hour label uses a lower-case "a.m." / "p.m." with one space, exactly as the spec writes it ("4:00 a.m.", "4:00 p.m.", "12:00 a.m.", "12:00 p.m.").
 * `unit` is passed as a string cast because the lib's signature widens to 'money' | 'percent' | 'hour' only when the builder lands.
 */
const show = (unit: string, text: string) => (showValue as (u: string, t: string) => string)(unit, text);
const input = (unit: string, text: string) => (inputValue as (u: string, t: string) => string)(unit, text);

describe('T-539 showValue - the hour unit reads as a clock time, not a percent', () => {
  it('4 -> "4:00 a.m." and 16 -> "4:00 p.m." [kills: an hour shown as 4% or 16:00]', () => {
    expect(show('hour', '4.000000')).toBe('4:00 a.m.');
    expect(show('hour', '16.000000')).toBe('4:00 p.m.');
  });

  it('the two edges of the day: 0 -> "12:00 a.m." and 12 -> "12:00 p.m." [kills: midnight shown as 0:00 a.m. and noon as 0:00 p.m.]', () => {
    expect(show('hour', '0.000000')).toBe('12:00 a.m.');
    expect(show('hour', '12.000000')).toBe('12:00 p.m.');
  });

  it('the rest of the day: 1, 11, 13, 23 [kills: an off-by-one around noon]', () => {
    expect(show('hour', '1.000000')).toBe('1:00 a.m.');
    expect(show('hour', '11.000000')).toBe('11:00 a.m.');
    expect(show('hour', '13.000000')).toBe('1:00 p.m.');
    expect(show('hour', '23.000000')).toBe('11:00 p.m.');
  });

  it('works on the registry default text "4" as well as the stored "4.000000" [kills: a parser that needs six decimals]', () => {
    expect(show('hour', '4')).toBe('4:00 a.m.');
  });

  it('money and percent are unchanged [kills: a regression in the existing units]', () => {
    expect(show('money', '70.000000')).toBe('₱70.00');
    expect(show('percent', '0.500000')).toBe('0.5%');
    expect(show('percent', '20.000000')).toBe('20%');
  });
});

describe('T-539 inputValue - the hour box holds a whole number', () => {
  it('"4.000000" -> "4", "0.000000" -> "0", "23.000000" -> "23" [kills: an hour box that shows 4.000000 or 4.00]', () => {
    expect(input('hour', '4.000000')).toBe('4');
    expect(input('hour', '0.000000')).toBe('0');
    expect(input('hour', '23.000000')).toBe('23');
  });

  it('money and percent boxes are unchanged', () => {
    expect(input('money', '70.000000')).toBe('70.00');
    expect(input('percent', '0.500000')).toBe('0.5');
    expect(input('percent', '20.000000')).toBe('20');
  });
});

describe('T-539 RULE_GROUPS - POS is a group, last, after Tax', () => {
  it('the headings in order are Settlement, Tax, POS [kills: POS rules missing from the screen, or shown first]', () => {
    expect(RULE_GROUPS.map((g) => g.heading)).toEqual(['Settlement', 'Tax', 'POS']);
    expect(RULE_GROUPS.map((g) => g.namespace)).toEqual(['settlement', 'tax', 'pos']);
    expect(RULE_GROUPS[RULE_GROUPS.length - 1]).toEqual({ namespace: 'pos', heading: 'POS' });
  });
});
