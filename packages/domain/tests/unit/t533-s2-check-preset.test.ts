/**
 * T-533 S2 - the discount preset rules, in words (pure: no database). `checkPreset` mirrors the table's CHECKs so the load can name the preset it refuses.
 */
import { describe, expect, it } from 'vitest';
import { RefusalError } from '@shareat/db';
import { checkPreset } from '../../src/pos/store-setup';

const refusal = (raw: Parameters<typeof checkPreset>[0]) => {
  try {
    checkPreset(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(RefusalError);
    return (e as RefusalError).userMessage;
  }
  throw new Error('expected a refusal, got success');
};

describe('checkPreset', () => {
  it('accepts a percent or a fixed amount and stores two decimals (strings and numbers alike)', () => {
    expect(checkPreset({ name: ' Senior Treat ', valueType: 'percent', value: 20 })).toEqual({ name: 'Senior Treat', valueType: 'percent', value: '20.00' });
    expect(checkPreset({ name: 'Peso Off', valueType: 'fixed', value: '99.5' })).toEqual({ name: 'Peso Off', valueType: 'fixed', value: '99.50' });
    expect(checkPreset({ name: 'Full', valueType: 'percent', value: 100 }).value).toBe('100.00');
    expect(checkPreset({ name: 'Big', valueType: 'fixed', value: 1500 }).value).toBe('1500.00');
  });

  it('refuses a value of 0, in words', () => {
    expect(refusal({ name: 'Zero Off', valueType: 'fixed', value: 0 })).toBe('The discount "Zero Off" has a value of 0. A discount must be more than 0.');
    expect(refusal({ name: 'Zero Off', valueType: 'percent', value: '0.00' })).toMatch(/value of 0/);
  });

  it('refuses a percent over 100, in words, but not 100 itself', () => {
    expect(refusal({ name: 'Huge', valueType: 'percent', value: 150 })).toBe('The discount "Huge" is a percent over 100. A percent discount can be at most 100.');
    expect(refusal({ name: 'Huge', valueType: 'percent', value: 100.01 })).toMatch(/percent over 100/);
    expect(() => checkPreset({ name: 'Full', valueType: 'percent', value: '100.00' })).not.toThrow();
  });

  it('refuses a bad type, a negative, over-precise, exponent or non-numeric value, and a bad name', () => {
    expect(refusal({ name: 'X', valueType: 'bogus', value: 10 })).toMatch(/percent or a fixed peso amount/);
    for (const v of [-5, 10.123, 1e21, 'abc', NaN, Infinity, null, undefined]) expect(refusal({ name: 'X', valueType: 'fixed', value: v })).toMatch(/above 0 with at most two decimals/);
    expect(refusal({ name: '  ', valueType: 'fixed', value: 10 })).toMatch(/1 to 40 characters/);
    expect(refusal({ name: 'n'.repeat(41), valueType: 'fixed', value: 10 })).toMatch(/1 to 40 characters/);
    expect(refusal({ name: 42, valueType: 'fixed', value: 10 })).toMatch(/1 to 40 characters/);
  });
});
