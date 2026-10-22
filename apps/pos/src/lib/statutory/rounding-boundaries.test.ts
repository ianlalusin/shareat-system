import { describe, expect, it } from 'vitest';
import { calculateBillTotalsCentavos } from '@/lib/tax';
import { mkDiner, mkLine, mkStore, fixedPromo, percentPromo, oldWholeBillSeniorDiscount } from '@/test-helpers/statutoryOracle';

describe('independent audit: small statutory rounding boundaries', () => {
  it('never allocates more discount plus VAT removal than a diner consumed', () => {
    const diners = Array.from({ length: 6 }, (_, i) => mkDiner(i + 1));
    const result = calculateBillTotalsCentavos([mkLine({ id: 'pkg', type: 'package', priceC: 1, qty: 6 })],
      mkStore('VAT_INCLUSIVE', 12), null, [], null, { diners, heads: 6 });
    expect(result.statutoryDiscountTotal).toBe(1);
    expect(result.statutoryVatRemovedTotal).toBe(1);
    expect(result.vatExemptSales).toBe(4);
    for (const diner of result.statutoryDiners) {
      expect(diner.vatExempt).toBeGreaterThanOrEqual(0);
      expect(diner.share).toBe(diner.discount + diner.vatRemoved + diner.vatExempt);
    }
    expect(result.statutoryDiners.reduce((sum, diner) => sum + diner.vatExempt, 0)).toBe(result.vatExemptSales);
  });
  it('a fixed promo half-cent split cannot create negative VAT removal at a non-VAT store', () => {
    const result = calculateBillTotalsCentavos([mkLine({ id: 'pkg', type: 'package', priceC: 1, qty: 2 })],
      mkStore('NON_VAT', 0), fixedPromo(0.01), [], null, { diners: [mkDiner(1)], heads: 2 });
    expect(result.billDiscountTotal).toBe(1);
    expect(result.statutoryVatRemovedTotal).toBe(0);
    expect(result.statutoryDiners[0]!.vatRemoved).toBe(0);
    expect(result.grandTotal).toBe(1);
  });
  it('retains the existing normalization of a stored numeric tax-rate string', () => {
    const store = { ...mkStore('VAT_INCLUSIVE', 12), taxRatePct: '12' };
    const result = calculateBillTotalsCentavos([mkLine({ id: 'pkg', type: 'package', priceC: 44900, qty: 4 })],
      store as any, null, [], null, { diners: [mkDiner(1)], heads: 4 });
    expect(result.statutoryDiscountTotal).toBe(8018);
    expect(result.statutoryVatRemovedTotal).toBe(4811);
  });
  it('allocates the bill line budget once when separate own-line discounts land on half centavos', () => {
    const adjs = { d: { id: 'd', kind: 'discount', note: 'Promo', type: 'percent', value: 10, qty: 1, createdAtClientMs: 1, createdByUid: 'staff' } };
    const lines = ['a', 'b'].map(id => mkLine({ id, type: 'addon', priceC: 44995, qty: 1, adjs }));
    const store = mkStore('VAT_INCLUSIVE', 12);
    const legacy = calculateBillTotalsCentavos(lines, store, oldWholeBillSeniorDiscount(), [], null);
    const result = calculateBillTotalsCentavos(lines, store, null, [], null,
      { diners: [mkDiner(1, { dishLineIds: ['a'] }), mkDiner(2, { dishLineIds: ['b'] })], heads: 2 });
    expect(result.statutoryDiners.reduce((sum, diner) => sum + diner.share, 0)).toBe(80991);
    expect(result.grandTotal).toBe(legacy.grandTotal);
    expect(result.statutoryDiscountTotal).toBe(legacy.billDiscountTotal);
    expect(result.vatExemptSales).toBe(legacy.vatExemptSales);
  });
  it.each(['VAT_INCLUSIVE', 'VAT_EXCLUSIVE', 'NON_VAT'] as const)('keeps tiny amounts nonnegative and each diner balanced at %s stores', taxType => {
    const store = mkStore(taxType, taxType === 'NON_VAT' ? 0 : 12);
    for (let heads = 1; heads <= 8; heads++) for (let priceC = 1; priceC <= 15; priceC++) {
      for (let count = 1; count <= heads; count++) for (const promo of [null, percentPromo(50), fixedPromo(0.01)]) {
        const result = calculateBillTotalsCentavos([mkLine({ id: 'pkg', type: 'package', priceC, qty: heads })],
          store, promo, [], null, { diners: Array.from({ length: count }, (_, i) => mkDiner(i + 1)), heads });
        expect(result.statutoryVatRemovedTotal).toBeGreaterThanOrEqual(0);
        if (taxType !== 'VAT_INCLUSIVE') expect(result.statutoryVatRemovedTotal).toBe(0);
        for (const diner of result.statutoryDiners) {
          expect(diner.discount).toBeGreaterThanOrEqual(0);
          expect(diner.vatRemoved).toBeGreaterThanOrEqual(0);
          expect(diner.vatExempt).toBeGreaterThanOrEqual(0);
          expect(diner.share).toBe(diner.discount + diner.vatRemoved + diner.vatExempt);
        }
      }
    }
  });
});
