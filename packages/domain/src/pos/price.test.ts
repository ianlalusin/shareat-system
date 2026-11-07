import { describe, expect, it } from 'vitest';
import { priceSession } from './price';

/**
 * T-524 R7 (TESTER) - `priceSession`, the one pure arithmetic function (docs/tasks/524-pos-v2-domain.md R7, test 1).
 *
 * ASSUMED SHAPES (derived from the spec; the builder matches them or says why not). Money is `Money` = a 2-dp decimal string.
 *
 *   priceSession(snapshot: PriceSnapshot): PricedSession
 *
 *   PriceSnapshot = {
 *     vatRegistered: boolean;            // organizations.tax_type === 'vat'
 *     vatPercentBasisPoints: bigint;     // 1200n = 12% (BOSS ruling 6 Nov: percents travel as basis points; the caller reads them, this function never defaults them)
 *     scPwdPercentBasisPoints: bigint;   // 2000n = 20%
 *     lines: {                           // NON-cancelled lines only
 *       lineId: string; qty: number; unitPrice: string;
 *       bundleHeads: number | null;      // null or 1 = an ordinary per-unit line; N > 1 = a "(up to N)" bundle line (qty 1, unitPrice = the bundle amount)
 *       discounts: {                     // ACTIVE discounts only, already in creation order
 *         discountId: string; kind: 'senior' | 'pwd' | 'preset' | 'custom';
 *         valueType: 'percent' | 'fixed'; value: string; qty: number;   // qty = units (heads, on a bundle line) covered
 *       }[];
 *     }[];
 *   }
 *   PricedSession = {
 *     lines: { lineId; gross; discountTotal; net; discounts: { discountId; coveredGross; vatRemoved; discountAmount }[] }[];  // same order as the input
 *     subtotal; discountTotal; total;    // 2-dp strings
 *   }
 *   `coveredGross` is the covered units' gross (cov x unit price; on a bundle line the allocated per-head shares): it is what the
 *   statutory record's gross_amount is. `vatRemoved` is '0.00' for everything except senior/pwd on a VAT org.
 */

const RATES = { vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n } as const;
type Line = Parameters<typeof priceSession>[0]['lines'][number];
type Disc = Line['discounts'][number];

const disc = (id: string, kind: Disc['kind'], qty: number, extra: Partial<Disc> = {}): Disc =>
  ({ discountId: id, kind, valueType: 'percent', value: '0', qty, ...extra }) as Disc;
const senior = (id: string, qty = 1) => disc(id, 'senior', qty);
const line = (lineId: string, qty: number, unitPrice: string, discounts: Disc[] = [], bundleHeads: number | null = null): Line =>
  ({ lineId, qty, unitPrice, bundleHeads, discounts }) as Line;
const price = (lines: Line[], vatRegistered = true) => priceSession({ vatRegistered, ...RATES, lines } as Parameters<typeof priceSession>[0]);

describe('priceSession (T-524 R7)', () => {
  it('PC-7: a 449.00 per-head package x4, one senior on 1 unit, VAT org -> VAT 48.11, 20% 80.18, line 128.29, net 1,667.71', () => {
    const r = price([line('L1', 4, '449.00', [senior('D1')])]);
    expect(r.lines[0]!.discounts).toEqual([{ discountId: 'D1', coveredGross: '449.00', vatRemoved: '48.11', discountAmount: '80.18' }]);
    expect(r.lines[0]).toMatchObject({ lineId: 'L1', gross: '1796.00', discountTotal: '128.29', net: '1667.71' });
    expect(r).toMatchObject({ subtotal: '1796.00', discountTotal: '128.29', total: '1667.71' });
  });

  it('a PWD is priced exactly like a senior (same statute, same figures)', () => {
    const r = price([line('L1', 4, '449.00', [disc('D1', 'pwd', 1)])]);
    expect(r.lines[0]!.discounts[0]).toMatchObject({ vatRemoved: '48.11', discountAmount: '80.18' });
    expect(r.total).toBe('1667.71');
  });

  it('non-VAT org: a senior takes 20% of the gross, no VAT is removed', () => {
    const r = price([line('L1', 4, '449.00', [senior('D1')])], false);
    expect(r.lines[0]!.discounts).toEqual([{ discountId: 'D1', coveredGross: '449.00', vatRemoved: '0.00', discountAmount: '89.80' }]);
    expect(r).toMatchObject({ subtotal: '1796.00', discountTotal: '89.80', total: '1706.20' });
  });

  it('two seniors on one table are two discount rows, each priced on its own head', () => {
    const r = price([line('L1', 4, '449.00', [senior('D1'), senior('D2')])]);
    expect(r.lines[0]!.discounts.map((d) => [d.discountId, d.vatRemoved, d.discountAmount])).toEqual([
      ['D1', '48.11', '80.18'],
      ['D2', '48.11', '80.18'],
    ]);
    expect(r.lines[0]).toMatchObject({ discountTotal: '256.58', net: '1539.42' });
    expect(r.total).toBe('1539.42');
  });

  it('one senior row covering 2 units equals twice one unit (qty scales the covered gross)', () => {
    const r = price([line('L1', 4, '449.00', [senior('D1', 2)])]);
    expect(r.lines[0]!.discounts[0]).toMatchObject({ coveredGross: '898.00', vatRemoved: '96.21', discountAmount: '160.36' });
    // 898/1.12 = 801.785714 -> VAT 96.214286 -> 96.21 ; 801.785714 x 0.20 = 160.357143 -> 160.36
    expect(r.lines[0]!.discountTotal).toBe('256.57');
  });

  it('a preset 10% on 1 of 2 units takes 10% of that unit only, and removes no VAT on a VAT org', () => {
    const r = price([line('L1', 2, '250.00', [disc('D1', 'preset', 1, { valueType: 'percent', value: '10' })])]);
    expect(r.lines[0]!.discounts).toEqual([{ discountId: 'D1', coveredGross: '250.00', vatRemoved: '0.00', discountAmount: '25.00' }]);
    expect(r.lines[0]).toMatchObject({ gross: '500.00', discountTotal: '25.00', net: '475.00' });
  });

  it('a fixed discount above the unit price is capped at the unit price, per covered unit', () => {
    const r = price([line('L1', 3, '80.00', [disc('D1', 'custom', 2, { valueType: 'fixed', value: '100.00' })])]);
    expect(r.lines[0]!.discounts[0]!.discountAmount).toBe('160.00'); // 2 x min(100, 80)
    expect(r.lines[0]).toMatchObject({ gross: '240.00', discountTotal: '160.00', net: '80.00' });
  });

  it('a fixed discount below the unit price is taken as is, per covered unit', () => {
    const r = price([line('L1', 3, '80.00', [disc('D1', 'preset', 2, { valueType: 'fixed', value: '30.00' })])]);
    expect(r.lines[0]!.discountTotal).toBe('60.00');
  });

  it('a bundle "(up to 6)" with one senior: the senior pays on their own head, the bundle amount split exactly', () => {
    // 1,200.00 / 6 = 200.00 a head. VAT 200 - 200/1.12 = 21.428571 -> 21.43 ; 20% of 178.571429 = 35.714286 -> 35.71
    const r = price([line('B1', 1, '1200.00', [senior('D1')], 6)]);
    expect(r.lines[0]!.discounts).toEqual([{ discountId: 'D1', coveredGross: '200.00', vatRemoved: '21.43', discountAmount: '35.71' }]);
    expect(r.lines[0]).toMatchObject({ gross: '1200.00', discountTotal: '57.14', net: '1142.86' });
  });

  it('a bundle whose amount does not divide evenly: the allocation leaves the extra centavo on the earliest head (allocate), exactly', () => {
    // 1,000.00 / 6 -> 166.67, 166.67, 166.67, 166.67, 166.66, 166.66. The senior is head 1 = 166.67.
    // VAT 166.67 - 148.8125 = 17.8575 -> 17.86 ; 20% of 148.8125 = 29.7625 -> 29.76
    const r = price([line('B1', 1, '1000.00', [senior('D1')], 6)]);
    expect(r.lines[0]!.discounts[0]).toEqual({ discountId: 'D1', coveredGross: '166.67', vatRemoved: '17.86', discountAmount: '29.76' });
    expect(r.lines[0]).toMatchObject({ discountTotal: '47.62', net: '952.38' });
  });

  it('a bundle with all 6 heads covered: the shares add back to the bundle amount exactly (nothing lost, nothing invented)', () => {
    const r = price([line('B1', 1, '1000.00', [senior('D1', 6)], 6)]);
    expect(r.lines[0]!.discounts[0]!.coveredGross).toBe('1000.00');
    // 1000 - 1000/1.12 = 107.142857 -> 107.14 ; 20% of 892.857143 = 178.571429 -> 178.57
    expect(r.lines[0]!.discounts[0]).toMatchObject({ vatRemoved: '107.14', discountAmount: '178.57' });
  });

  it('rounds half-up, once per discount (5% of 10.10 is 0.505 -> 0.51, not 0.50)', () => {
    const r = price([line('L1', 1, '10.10', [disc('D1', 'preset', 1, { value: '5' })])]);
    expect(r.lines[0]!.discounts[0]!.discountAmount).toBe('0.51');
  });

  it('rounds once on the covered total, not unit by unit (3 x 5% of 10.10 = 1.515 -> 1.52, not 3 x 0.51)', () => {
    const r = price([line('L1', 3, '10.10', [disc('D1', 'preset', 3, { value: '5' })])]);
    expect(r.lines[0]!.discounts[0]!.discountAmount).toBe('1.52');
  });

  it('a free refill line (unit price 0) prices at 0.00 and never breaks the totals', () => {
    const r = price([line('R1', 2, '0.00')]);
    expect(r.lines[0]).toMatchObject({ gross: '0.00', discountTotal: '0.00', net: '0.00' });
    expect(r.total).toBe('0.00');
  });

  it('a session with no discounts: net = gross, total = subtotal, discountTotal 0.00', () => {
    const r = price([line('L1', 4, '449.00'), line('L2', 2, '250.00')]);
    expect(r).toMatchObject({ subtotal: '2296.00', discountTotal: '0.00', total: '2296.00' });
  });

  it('totals add exactly across a mixed bill: lines sum to the receipt, subtotal - discounts = total', () => {
    const r = price([
      line('L1', 4, '449.00', [senior('D1')]), // 128.29
      line('L2', 2, '250.00', [disc('D2', 'preset', 1, { value: '10' })]), // 25.00
      line('L3', 3, '80.00', [disc('D3', 'custom', 2, { valueType: 'fixed', value: '100.00' })]), // 160.00
      line('R1', 2, '0.00'),
    ]);
    expect(r).toMatchObject({ subtotal: '2536.00', discountTotal: '313.29', total: '2222.71' });
    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(r.lines.reduce((a, l) => a + cents(l.gross), 0)).toBe(cents(r.subtotal));
    expect(r.lines.reduce((a, l) => a + cents(l.discountTotal), 0)).toBe(cents(r.discountTotal));
    expect(r.lines.reduce((a, l) => a + cents(l.net), 0)).toBe(cents(r.total));
    for (const l of r.lines) {
      expect(cents(l.net)).toBe(cents(l.gross) - cents(l.discountTotal));
      expect(cents(l.discountTotal)).toBe(l.discounts.reduce((a, d) => a + cents(d.vatRemoved) + cents(d.discountAmount), 0));
    }
  });
});
