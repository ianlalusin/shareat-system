import { describe, expect, it } from 'vitest';
import { computeRecordPay, slicerRateInForce, type SlicerRateLike } from '../../src/production/slicer-pay-math';

/**
 * T-635 test 1 - the pay maths, pure. kg x the rate in force on produced_on; the per-item override over the org default; g -> kg;
 * exact centavos rounded half-up ONCE per record; a unit that is not kg or g, and a line with no rate, are refused in words.
 * (Unpaid lines are left out by the query: see the integration file.)
 */
const DEFAULT: SlicerRateLike = { itemId: null, ratePerKg: '5.00', effectiveFrom: '2026-01-01' };
const OVERRIDE_B: SlicerRateLike = { itemId: 'B', ratePerKg: '8.00', effectiveFrom: '2026-01-10' };
const line = (itemId: string, quantity: string, unit = 'kg') => ({ itemId, itemName: `Item ${itemId}`, quantity, unit });

describe('slicerRateInForce', () => {
  it('is the latest row on or before the date; before the first row there is none', () => {
    const rates = [DEFAULT, { itemId: null, ratePerKg: '6.00', effectiveFrom: '2026-02-01' }];
    expect(slicerRateInForce(rates, 'A', '2025-12-31')).toBeNull();
    expect(slicerRateInForce(rates, 'A', '2026-01-31')).toBe('5.00');
    expect(slicerRateInForce(rates, 'A', '2026-02-01')).toBe('6.00');
  });
  it('an override in force beats the default, even a newer default; before the override starts the default applies', () => {
    const rates = [DEFAULT, OVERRIDE_B, { itemId: null, ratePerKg: '9.00', effectiveFrom: '2026-01-20' }];
    expect(slicerRateInForce(rates, 'B', '2026-01-05')).toBe('5.00');
    expect(slicerRateInForce(rates, 'B', '2026-01-12')).toBe('8.00');
    expect(slicerRateInForce(rates, 'B', '2026-01-25')).toBe('8.00');
    expect(slicerRateInForce(rates, 'A', '2026-01-25')).toBe('9.00');
  });
});

describe('computeRecordPay', () => {
  it('kg x rate, per-item override over the default', () => {
    const r = computeRecordPay('2026-01-12', [line('A', '10'), line('B', '5')], [DEFAULT, OVERRIDE_B]);
    expect(r).toEqual({ ok: true, pay: '90.00', kg: '15.000' }); // 10 x 5.00 + 5 x 8.00
  });
  it('the rate is the one in force on produced_on, not today', () => {
    const r = computeRecordPay('2026-01-05', [line('B', '5')], [DEFAULT, OVERRIDE_B]);
    expect(r).toEqual({ ok: true, pay: '25.00', kg: '5.000' });
  });
  it('grams are converted to kg', () => {
    expect(computeRecordPay('2026-01-12', [line('A', '2500', 'g')], [DEFAULT])).toEqual({ ok: true, pay: '12.50', kg: '2.500' });
  });
  it('is rounded half-up ONCE per record, not per line', () => {
    // two lines of 0.5 kg at 0.01 are 0.005 each: per line would be 0.01 + 0.01 = 0.02; per record is 0.01.
    const rates: SlicerRateLike[] = [{ itemId: null, ratePerKg: '0.01', effectiveFrom: '2026-01-01' }];
    expect(computeRecordPay('2026-01-12', [line('A', '0.5'), line('B', '0.5')], rates)).toEqual({ ok: true, pay: '0.01', kg: '1.000' });
    // 1.5 kg at 3.33 = 4.995 -> 5.00 (half-up)
    expect(computeRecordPay('2026-01-12', [line('A', '1.5')], [{ itemId: null, ratePerKg: '3.33', effectiveFrom: '2026-01-01' }])).toMatchObject({ pay: '5.00' });
  });
  it('a record with no paid lines pays nothing', () => {
    expect(computeRecordPay('2026-01-12', [], [DEFAULT])).toEqual({ ok: true, pay: '0.00', kg: '0.000' });
  });
  it('refuses a unit that is not kg or g, in words naming the item', () => {
    const r = computeRecordPay('2026-01-12', [line('A', '3', 'pcs')], [DEFAULT]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Item A was recorded in pcs.*per kg/);
  });
  it('refuses a line with no rate in force, never paying it at zero', () => {
    const r = computeRecordPay('2025-12-31', [line('A', '3')], [DEFAULT]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no slicer rate in force for Item A/);
  });
});
