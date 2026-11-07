import { describe, expect, it } from 'vitest';
import { priceSession } from './price';

/**
 * T-528 R1 (TESTER) - the VAT breakdown `priceSession` adds for the receipt. docs/tasks/528-pos-payment-screen.md R1.
 *
 * ASSUMED SHAPE (from R1; the builder matches it or says why not): `PricedSession` gains ONE field,
 *   vat: { vatableSales: Money; vatExemptSales: Money; vatAmount: Money; vatRemovedForScPwd: Money }   (Money = a 2-dp decimal string)
 * VAT org:  vatExemptSales = sum over senior/PWD discounts of (coveredGross - vatRemoved); vatRemovedForScPwd = sum of vatRemoved;
 *           restNet = total - sum(coveredGross - vatRemoved - discountAmount); vatAmount = halfUp(restNet x vatBp, 10000 + vatBp); vatableSales = restNet - vatAmount.
 * Non-VAT:  every figure '0.00' except vatExemptSales = the sum of the senior/PWD covered GROSS.
 * Identity (VAT org, to the centavo): vatableSales + vatAmount + vatExemptSales - sum(senior/PWD discountAmount) = total.
 *
 * NOTE for the planner: receipts.png prints VAT-exempt 391.42 for the mock bill (covered net AFTER the 20%); R1's text gives 489.28 (before it). These tests follow R1's
 * text and identity, which hold only for 489.28. See the hand-back.
 *
 * RED NOW FOR THE RIGHT REASON: `priceSession` returns no `vat` field.
 */
type Snap = Parameters<typeof priceSession>[0];
type Line = Snap['lines'][number];
type Disc = Line['discounts'][number];
const RATES = { vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n } as const;

const disc = (id: string, kind: Disc['kind'], qty: number, extra: Partial<Disc> = {}): Disc => ({ discountId: id, kind, valueType: 'percent', value: '0', qty, ...extra }) as Disc;
const line = (lineId: string, qty: number, unitPrice: string, discounts: Disc[] = [], bundleHeads: number | null = null): Line => ({ lineId, qty, unitPrice, bundleHeads, discounts }) as Line;
const price = (lines: Line[], vatRegistered = true) => priceSession({ vatRegistered, ...RATES, lines } as Snap);
const vatOf = (r: ReturnType<typeof priceSession>) => (r as unknown as { vat?: Record<string, string> }).vat;
const cents = (m: string): bigint => BigInt(m.replace('.', ''));

/** The payment.png / receipts.png bill: package 449 x4 (1 senior), pitcher 120, cheese corn 99 x2 (1 senior, same diner), kimchi 150 (10% preset). */
const MOCK_BILL = (): Line[] => [
  line('PKG', 4, '449.00', [disc('S1', 'senior', 1)]),
  line('TEA', 1, '120.00'),
  line('CORN', 2, '99.00', [disc('S2', 'senior', 1)]),
  line('RICE', 1, '150.00', [disc('P1', 'preset', 1, { value: '10' })]),
];

describe('priceSession.vat (T-528 R1)', () => {
  it('T-524 spec figure 48.11 / 80.18: package 449.00 x4, one senior, VAT org', () => {
    const r = price([line('L1', 4, '449.00', [disc('D1', 'senior', 1)])]);
    expect(r.total).toBe('1667.71');
    expect(vatOf(r)).toEqual({ vatableSales: '1202.68', vatExemptSales: '400.89', vatAmount: '144.32', vatRemovedForScPwd: '48.11' });
  });

  it('T-524 spec figure 26.79 / 44.64: a 250.00 dish x2, one senior, VAT org', () => {
    const r = price([line('L1', 2, '250.00', [disc('D1', 'senior', 1)])]);
    expect(r.lines[0]!.discounts[0]).toMatchObject({ vatRemoved: '26.79', discountAmount: '44.64' });
    expect(r.total).toBe('428.57');
    expect(vatOf(r)).toEqual({ vatableSales: '223.21', vatExemptSales: '223.21', vatAmount: '26.79', vatRemovedForScPwd: '26.79' });
  });

  it('the receipt-mock bill (payment.png): 2,092.42 splits into VATable 1,518.75 + VAT 182.25 + exempt 489.28, VAT removed 58.72', () => {
    const r = price(MOCK_BILL());
    expect(r).toMatchObject({ subtotal: '2264.00', discountTotal: '171.58', total: '2092.42' });
    expect(vatOf(r)).toEqual({ vatableSales: '1518.75', vatExemptSales: '489.28', vatAmount: '182.25', vatRemovedForScPwd: '58.72' });
  });

  it('no senior/PWD on a VAT org: the exempt and removed figures are 0.00 and the VAT is the VAT inside the whole discounted bill', () => {
    const r = price([line('TEA', 1, '120.00'), line('RICE', 1, '150.00', [disc('P1', 'preset', 1, { value: '10' })])]);
    expect(r.total).toBe('255.00');
    expect(vatOf(r)).toEqual({ vatableSales: '227.68', vatExemptSales: '0.00', vatAmount: '27.32', vatRemovedForScPwd: '0.00' });
  });

  it('a PWD is counted exactly like a senior', () => {
    const r = price([line('L1', 4, '449.00', [disc('D1', 'pwd', 1)])]);
    expect(vatOf(r)).toEqual({ vatableSales: '1202.68', vatExemptSales: '400.89', vatAmount: '144.32', vatRemovedForScPwd: '48.11' });
  });

  it('non-VAT org: every figure is 0.00 except vatExemptSales = the senior/PWD covered GROSS', () => {
    const r = price([line('L1', 4, '449.00', [disc('D1', 'senior', 1)])], false);
    expect(r.total).toBe('1706.20');
    expect(vatOf(r)).toEqual({ vatableSales: '0.00', vatExemptSales: '449.00', vatAmount: '0.00', vatRemovedForScPwd: '0.00' });
  });

  it('non-VAT org, no senior/PWD: all four figures are 0.00', () => {
    const r = price([line('TEA', 2, '120.00')], false);
    expect(vatOf(r)).toEqual({ vatableSales: '0.00', vatExemptSales: '0.00', vatAmount: '0.00', vatRemovedForScPwd: '0.00' });
  });

  it('a senior row covering 2 units sums the covered shares (exempt = 898.00 - 96.21)', () => {
    const r = price([line('L1', 4, '449.00', [disc('D1', 'senior', 2)])]);
    expect(vatOf(r)).toMatchObject({ vatExemptSales: '801.79', vatRemovedForScPwd: '96.21' });
  });

  it('a bundle line (1,200.00 for up to 6 heads) with one senior head: the head share is the bundle allocated over 6, and the identity holds', () => {
    const r = price([line('B', 1, '1200.00', [disc('D1', 'senior', 1)], 6)]);
    expect(r.lines[0]!.discounts[0]!.coveredGross).toBe('200.00');
    const v = vatOf(r)!;
    expect(cents(v.vatableSales!) + cents(v.vatAmount!) + cents(v.vatExemptSales!) - cents(r.lines[0]!.discounts[0]!.discountAmount)).toBe(cents(r.total));
    expect(v.vatExemptSales).toBe('178.57');
  });

  it('identity over 1,000 seeded random VAT bills: vatable + VAT + exempt - senior/PWD discounts = total, to the centavo, and no figure is negative', () => {
    let seed = 0x528;
    const rnd = (n: number) => {
      // mulberry32: a fixed seed makes the 1,000 bills the same on every machine
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const percents = ['5', '10', '12.5', '15', '33.33'];
    let seniorBills = 0;
    for (let i = 0; i < 1000; i++) {
      const lines: Line[] = [];
      const nLines = 1 + rnd(6);
      for (let l = 0; l < nLines; l++) {
        // one line in four is a bundle: qty 1 at the flat amount, covering N heads (a discount unit is a HEAD, its price the bundle amount allocated over N)
        const bundleHeads = rnd(4) === 0 ? 2 + rnd(5) : null;
        const qty = bundleHeads !== null ? 1 : 1 + rnd(6);
        const unitPrice = `${1 + rnd(1500)}.${String(rnd(100)).padStart(2, '0')}`;
        const discounts: Disc[] = [];
        let free = bundleHeads ?? qty;
        for (let d = 0; d < 3 && free > 0; d++) {
          if (rnd(3) === 0) continue;
          const take = 1 + rnd(free);
          free -= take;
          const id = `d${i}-${l}-${d}`;
          const pick = rnd(4);
          discounts.push(
            pick === 0
              ? disc(id, 'senior', take)
              : pick === 1
                ? disc(id, 'pwd', take)
                : pick === 2
                  ? disc(id, 'preset', take, { value: percents[rnd(percents.length)]! })
                  : disc(id, 'custom', take, { valueType: 'fixed', value: `${1 + rnd(40)}.${rnd(2) === 0 ? '00' : '50'}` }),
          );
        }
        lines.push(line(`L${l}`, qty, unitPrice, discounts, bundleHeads));
      }
      const r = price(lines);
      const v = vatOf(r);
      expect(v, `bill ${i}`).toBeDefined();
      const statutory = r.lines.flatMap((pl, li) => pl.discounts.filter((_, di) => ['senior', 'pwd'].includes(lines[li]!.discounts[di]!.kind)));
      if (statutory.length > 0) seniorBills++;
      const sumDiscount = statutory.reduce((a, d) => a + cents(d.discountAmount), 0n);
      expect(cents(v!.vatableSales!) + cents(v!.vatAmount!) + cents(v!.vatExemptSales!) - sumDiscount, `bill ${i} identity`).toBe(cents(r.total));
      for (const k of Object.keys(v!)) expect(cents(v![k]!) >= 0n, `bill ${i} ${k} is not negative`).toBe(true);
    }
    expect(seniorBills, 'the seeded bills really include senior/PWD discounts').toBeGreaterThan(300);
  });

  it('over 1,000 seeded random NON-VAT bills the figures are 0.00 except vatExemptSales, which is the senior/PWD covered gross', () => {
    let seed = 0xabc;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 8) % n;
    };
    for (let i = 0; i < 1000; i++) {
      const qty = 1 + rnd(5);
      const unit = `${10 + rnd(900)}.${String(rnd(100)).padStart(2, '0')}`;
      const take = 1 + rnd(qty);
      const r = price([line('L1', qty, unit, [disc('D1', 'senior', take)])], false);
      expect(vatOf(r), `bill ${i}`).toEqual({ vatableSales: '0.00', vatExemptSales: r.lines[0]!.discounts[0]!.coveredGross, vatAmount: '0.00', vatRemovedForScPwd: '0.00' });
    }
  });
});
