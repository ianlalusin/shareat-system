import { describe, expect, it } from 'vitest';
import { FLAG_OPTIONS, inputValue, showValue } from '../src/app/settings/business-rules/lib';

/**
 * T-575 (TESTER) - the business-rules screen learns two units: `days` (a whole number of days) and `flag` (0/1, shown as On/Off). T-575 adds BOTH so T-576 only has to add its key
 * (planner review, 13 Nov 2026). No `flag` key exists yet, so the rendering is tested here through the lib helpers with the unit passed as a string.
 *
 * RED NOW: `showValue('days', ...)` falls into the percent branch ("7%"), `showValue('flag', ...)` shows "1%", and FLAG_OPTIONS does not exist.
 */
const show = (unit: string, text: string) => (showValue as (u: string, t: string) => string)(unit, text);
const input = (unit: string, text: string) => (inputValue as (u: string, t: string) => string)(unit, text);

describe('T-575 showValue - the days unit', () => {
  it('1 -> "1 day", 7 -> "7 days", 30 -> "30 days", on the stored text and the default text [kills: days shown as a percent, "1 days"]', () => {
    expect(show('days', '1.000000')).toBe('1 day');
    expect(show('days', '7.000000')).toBe('7 days');
    expect(show('days', '30')).toBe('30 days');
  });
  it('the box holds a whole number: "7.000000" -> "7" [kills: a days box that shows 7.000000]', () => {
    expect(input('days', '7.000000')).toBe('7');
    expect(input('days', '1')).toBe('1');
  });
});

describe('T-575 showValue - the flag unit is On / Off', () => {
  it('1 -> "On", 0 -> "Off", stored or plain text [kills: a flag shown as 1% or 0%]', () => {
    expect(show('flag', '1.000000')).toBe('On');
    expect(show('flag', '0.000000')).toBe('Off');
    expect(show('flag', '1')).toBe('On');
    expect(show('flag', '0')).toBe('Off');
  });
  it('the box holds exactly "1" or "0" [kills: a toggle that posts "1.000000"]', () => {
    expect(input('flag', '1.000000')).toBe('1');
    expect(input('flag', '0.000000')).toBe('0');
  });
  it('the toggle offers On = "1" first and Off = "0", nothing else [kills: a third state, a swapped value]', () => {
    expect(FLAG_OPTIONS).toEqual([
      { value: '1', label: 'On' },
      { value: '0', label: 'Off' },
    ]);
  });
});

describe('T-575 the existing units are unchanged', () => {
  it('money, percent, hour, minutes [kills: a regression in the earlier units]', () => {
    expect(show('money', '70.000000')).toBe('₱70.00');
    expect(show('percent', '0.500000')).toBe('0.5%');
    expect(show('hour', '16.000000')).toBe('4:00 p.m.');
    expect(show('minutes', '90.000000')).toBe('90 min');
    expect(input('minutes', '90.000000')).toBe('90');
  });
});
