import { describe, expect, it } from 'vitest';
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import { priceSession } from './price';

/**
 * T-627 (test 1) - the bill math of the store charges (leftover, an extra griller). docs/tasks/627-pos-charges.md.
 * Charges are added AFTER discounts and VAT, sit OUTSIDE the VAT base, are never discounted and never part of the senior/PWD base; per-unit x qty; exact centavos.
 * `total` (and `vat`, and every line) must NOT move when a charge is added; only `chargeTotal` and `amountDue = total + chargeTotal` do.
 */
type Snap = Parameters<typeof priceSession>[0];
type Line = Snap['lines'][number];
type Disc = Line['discounts'][number];
const RATES = { vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n } as const;
const disc = (id: string, kind: Disc['kind'], qty: number, extra: Partial<Disc> = {}): Disc => ({ discountId: id, kind, valueType: 'percent', value: '0', qty, ...extra }) as Disc;
const line = (lineId: string, qty: number, unitPrice: string, discounts: Disc[] = []): Line => ({ lineId, qty, unitPrice, bundleHeads: null, discounts }) as Line;
const price = (lines: Line[], charges: Snap['charges'], vatRegistered = true) => priceSession({ vatRegistered, ...RATES, lines, charges } as Snap);

/** A VAT bill with a senior and a percent preset: 4 x 449.00 (one senior), 150.00 with 10% off. */
const BILL = (): Line[] => [line('PKG', 4, '449.00', [disc('S1', 'senior', 1)]), line('RICE', 1, '150.00', [disc('P1', 'preset', 1, { value: '10' })])];

describe('priceSession charges (T-627)', () => {
  it('no charges: chargeTotal is 0.00 and amountDue equals total', () => {
    const r = price(BILL(), undefined);
    expect(r.charges).toEqual([]);
    expect(r.chargeTotal).toBe('0.00');
    expect(r.amountDue).toBe(r.total);
  });

  it('a charge comes after discounts and VAT: total, VAT and every line are exactly what they were without it', () => {
    const without = price(BILL(), []);
    const withCharge = price(BILL(), [{ chargeId: 'C1', unitAmount: '150.00', qty: 1 }]);
    expect(withCharge.total).toBe(without.total);
    expect(withCharge.subtotal).toBe(without.subtotal);
    expect(withCharge.discountTotal).toBe(without.discountTotal);
    expect(withCharge.vat).toEqual(without.vat);
    expect(withCharge.lines).toEqual(without.lines);
    expect(withCharge.chargeTotal).toBe('150.00');
    expect(withCharge.amountDue).toBe(fromCentavos(toCentavos(money(without.total)) + 15000n));
  });

  it('per-unit charges are unit amount x quantity, exact to the centavo, in the order given', () => {
    const r = price(BILL(), [
      { chargeId: 'C1', unitAmount: '33.33', qty: 3 },
      { chargeId: 'C2', unitAmount: '0.01', qty: 1000 },
      { chargeId: 'C3', unitAmount: '250.50', qty: 1 },
    ]);
    expect(r.charges).toEqual([
      { chargeId: 'C1', amount: '99.99' },
      { chargeId: 'C2', amount: '10.00' },
      { chargeId: 'C3', amount: '250.50' },
    ]);
    expect(r.chargeTotal).toBe('360.49');
  });

  it('a charge is never discounted: a 100% preset on the whole bill leaves the charge whole, and the senior base ignores it', () => {
    const free = price([line('L1', 1, '100.00', [disc('P1', 'preset', 1, { value: '100' })])], [{ chargeId: 'C1', unitAmount: '75.00', qty: 2 }]);
    expect(free.total).toBe('0.00');
    expect(free.chargeTotal).toBe('150.00');
    expect(free.amountDue).toBe('150.00');
    const senior = price([line('L1', 1, '112.00', [disc('S1', 'senior', 1)])], [{ chargeId: 'C1', unitAmount: '1000.00', qty: 1 }]);
    const seniorAlone = price([line('L1', 1, '112.00', [disc('S1', 'senior', 1)])], []);
    expect(senior.lines[0]!.discounts[0]).toEqual(seniorAlone.lines[0]!.discounts[0]); // the 20% and the VAT removed do not see the charge
    expect(senior.vat).toEqual(seniorAlone.vat);
  });

  it('a non-VAT organisation is the same: charges are plain amounts on top of the total', () => {
    const r = price([line('L1', 2, '250.00')], [{ chargeId: 'C1', unitAmount: '20.00', qty: 3 }], false);
    expect(r.total).toBe('500.00');
    expect(r.chargeTotal).toBe('60.00');
    expect(r.amountDue).toBe('560.00');
    expect(r.vat.vatAmount).toBe('0.00');
  });
});
