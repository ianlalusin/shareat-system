import { describe, expect, it } from 'vitest';
import { computeBranchPrice } from '../../packages/domain/src/items/branch-price';

/**
 * T-151 — the branch price rule, ported from v1's `computeBranchPrice`.
 * `docs/tasks/151-landed-cost-and-branch-price.md`.
 */
describe('the branch price rule', () => {
  it('percent_markup applies the markup to the basis', () => {
    const r = computeBranchPrice({ pricingMode: 'percent_markup', markupPercent: '8' }, '1.35');
    expect(r.price).toBe('1.46');
    expect(r.marginPct).toBe('8.00');
    // ⛔ percent_markup never alerts — the margin EQUALS the configured markup by construction.
    expect(r.marginAlert).toBe(false);
  });

  it('fixed_markup adds pesos, and its margin% shrinks as the basis grows', () => {
    const cheap = computeBranchPrice({ pricingMode: 'fixed_markup', fixedMarkupAmount: '10' }, '100');
    expect(cheap.price).toBe('110.00');
    expect(cheap.marginPct).toBe('10.00');

    const dear = computeBranchPrice({ pricingMode: 'fixed_markup', fixedMarkupAmount: '10' }, '500');
    expect(dear.price).toBe('510.00');
    expect(dear.marginPct).toBe('2.00');
  });

  it('⚠️ the margin alert fires below the threshold and stays quiet above it', () => {
    const rule = { pricingMode: 'fixed_markup', fixedMarkupAmount: '10', marginAlertThresholdPct: '5' } as const;
    expect(computeBranchPrice(rule, '500').marginAlert).toBe(true); // 2% — thin
    expect(computeBranchPrice(rule, '100').marginAlert).toBe(false); // 10% — fine
  });

  it('fixed mode prices at the set amount and reports the real margin', () => {
    const r = computeBranchPrice(
      { pricingMode: 'fixed', fixedAmount: '120', marginAlertThresholdPct: '25' },
      '100',
    );
    expect(r.price).toBe('120.00');
    expect(r.marginPct).toBe('20.00');
    expect(r.marginAlert).toBe(true);
  });

  it('a zero basis reports no margin rather than dividing by zero', () => {
    const r = computeBranchPrice({ pricingMode: 'fixed', fixedAmount: '50' }, '0');
    expect(r.price).toBe('50.00');
    expect(r.marginPct).toBeNull();
    expect(r.marginAlert).toBe(false);
  });
});
