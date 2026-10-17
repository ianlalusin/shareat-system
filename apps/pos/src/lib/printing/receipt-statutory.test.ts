/**
 * T-426 slice T - the printed and on-screen receipt with senior/PWD diners. Ruling 5, Ruling 6, Acceptance 7 (print part), flaws J and R.
 *
 * CONTRACT for the builder (S3) - ADDITIVE changes only:
 *   ReceiptData (lib/types.ts) gains `statutoryDiners?: ReceiptStatutoryDiner[]`, and `analytics` gains `statutoryDiscountTotal` and
 *   `statutoryVatRemovedTotal` (peso numbers, exact centavos). ReceiptStatutoryDiner =
 *     { kind: 'senior' | 'pwd'; name: string; idNo: string (the FULL ID: the receipt is where the law's per-transaction record lives);
 *       share: number; discount: number; vatRemoved: number; vatExempt: number; promoWasHigher: boolean }          (pesos)
 *   `analytics.discountsTotal` INCLUDES the statutory discount (not the VAT removed); `analytics.vatableSales / vatExemptSales / taxAmount` carry the
 *   mixed split (remainder VATable, diners exempt).
 *   formatReceiptText(data, width, fontMode) (lib/printing/receiptFormatter.ts), for a receipt with `statutoryDiners` of length >= 1:
 *     - a VAT block whenever `taxAmount > 0 || vatExemptSales > 0`: lines starting "VATABLE SALES", "VAT-EXEMPT SALES", "VAT (<rate>%)"; on a NON-VAT
 *       store (`settings.vatType === 'NON_VAT'`) the exempt row is labelled "SC/PWD SALES" instead and the text never says "VAT-EXEMPT".
 *     - a line "Less: VAT exemption (SC/PWD)" with the VAT removed, printed whenever `statutoryVatRemovedTotal > 0`, between DISCOUNTS/CHARGES and TOTAL,
 *       so SUBTOTAL - DISCOUNTS - VAT exemption + CHARGES = TOTAL (VAT-inclusive and non-VAT stores).
 *     - per diner: a heading with the kind ("SENIOR CITIZEN" or "PWD"), the name, the FULL ID number, the discount amount (2 decimals) and a line
 *       "Signature: ________" (at least 6 underscores); a diner with `promoWasHigher` is also marked "promo was higher".
 *     - a receipt with NO `statutoryDiners` prints none of this: no "Signature", no "Less: VAT exemption", no "SC/PWD".
 *   ReceiptView (components/receipt/receipt-view.tsx) shows the same: the "Less: VAT exemption (SC/PWD)" row, each diner's name and full ID, a signature line.
 */
import fc from 'fast-check';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatReceiptText } from '@/lib/printing/receiptFormatter';
import { ReceiptView } from '@/components/receipt/receipt-view';
import { allocate } from '@/lib/money/centavos';
import { mkStore, oracleStat, statBillArb, workedCase, type StatBill } from '@/test-helpers/statutoryOracle';

type WireDiner = { kind: 'senior' | 'pwd'; name: string; idNo: string; share: number; discount: number; vatRemoved: number; vatExempt: number; promoWasHigher: boolean };

const settings = (vatType: 'VAT' | 'NON_VAT' = 'VAT') => ({
  businessName: 'Shareat Test', branchName: 'Main', address: '1 Test St', contact: '0900', tin: '123-456-789', vatType,
  showCashierName: false, showTableOrCustomer: false, showItemNotes: false, showDiscountBreakdown: false, showChargeBreakdown: false, paperWidth: '80mm',
}) as any;

/** The WORKED CASE as the receipt document carries it (Acceptance 1), pesos. */
function workedReceipt(over: Partial<{ vatType: 'VAT' | 'NON_VAT'; diners: WireDiner[] }> = {}) {
  const w = workedCase();
  const diners: WireDiner[] = over.diners ?? [{
    kind: 'senior', name: w.diner.name, idNo: w.diner.idNo, share: 449, discount: 80.18, vatRemoved: 48.11, vatExempt: 320.71, promoWasHigher: false,
  }];
  return {
    session: { id: 's1', sessionMode: 'package_dinein', tableNumber: '4', paymentSummary: {}, closedAt: null, startedByUid: 'u1' },
    lines: w.lines, payments: [], settings: settings(over.vatType), store: w.store, receiptNumber: 'SHT-01-000007', receiptCreatedAt: 1_700_000_000_000,
    statutoryDiners: diners,
    analytics: {
      subtotal: 2114, discountsTotal: 80.18, chargesTotal: 0, taxAmount: 178.39, vatableSales: 1486.61, vatExemptSales: 320.71, grandTotal: 1985.71,
      totalPaid: 2000, change: 14.29, mop: { Cash: 2000 }, statutoryDiscountTotal: 80.18, statutoryVatRemovedTotal: 48.11,
    },
  } as any;
}
const text = (d: any, width: 58 | 80 = 80, mode: 'small' | 'normal' = 'normal') => formatReceiptText(d, width, mode);
const num = (s: string) => Math.round(Number(s.replace(/[^\d.]/g, '')) * 100);
function line(t: string, startsWith: string): string {
  const l = t.split('\n').find((x) => x.trimStart().toLowerCase().startsWith(startsWith.toLowerCase()));
  if (!l) throw new Error(`no line starting "${startsWith}" in:\n${t}`);
  return l;
}

describe('the printed receipt, worked case (Acceptance 7)', () => {
  const t = text(workedReceipt());

  it('has the VAT block with the mixed split: VATable P1,486.61, VAT-exempt P320.71, VAT (12%) P178.39', () => {
    expect(line(t, 'VATABLE SALES')).toMatch(/1486\.61/);
    expect(line(t, 'VAT-EXEMPT SALES')).toMatch(/320\.71/);
    expect(line(t, 'VAT (12%)')).toMatch(/178\.39/);
  });

  it('has the line "Less: VAT exemption (SC/PWD)" with P48.11, and DISCOUNTS carries only the 20% (P80.18)', () => {
    expect(t).toMatch(/Less: VAT exemption \(SC\/PWD\)\s+\(?-?48\.11\)?/i);
    expect(line(t, 'DISCOUNTS')).toMatch(/80\.18/);
  });

  it('adds up: 2,114.00 - 80.18 - 48.11 = 1,985.71', () => {
    const sub = num(line(t, 'SUBTOTAL')), dis = num(line(t, 'DISCOUNTS')), less = num(line(t, 'Less: VAT exemption')), tot = num(line(t, 'TOTAL'));
    expect(sub - dis - less).toBe(tot);
    expect(tot).toBe(198571);
  });

  it('prints the diner: kind, name, FULL ID, discount and a signature line (kills flaw R)', () => {
    expect(t).toMatch(/SENIOR CITIZEN/i);
    expect(t).toContain('Lola Remedios Cruz');
    expect(t).toContain('OSCA-2024-001187');
    expect(t).not.toMatch(/\*\*\*\*1187/);
    expect(t).toMatch(/80\.18/);
    expect(t).toMatch(/Signature:\s*_{6,}/);
  });

  it('prints the same facts on 58mm paper (the long ID is never cut)', () => {
    const t58 = text(workedReceipt(), 58); // 32 columns: a long label may wrap, so facts are matched with whitespace collapsed
    const flat = t58.replace(/\s+/g, ' ');
    expect(t58).toContain('OSCA-2024-001187');
    expect(flat).toMatch(/Less: VAT exemption \(SC\/PWD\) \(?-?48\.11\)?/i);
    expect(t58).toMatch(/Signature:\s*_{6,}/);
  });

  it('two diners print two blocks and two signature lines; a PWD is headed "PWD"', () => {
    const d: WireDiner[] = [
      { kind: 'senior', name: 'Lola A', idNo: 'OSCA-1', share: 449, discount: 80.18, vatRemoved: 48.11, vatExempt: 320.71, promoWasHigher: false },
      { kind: 'pwd', name: 'Mang B', idNo: 'PWD-2', share: 449, discount: 80.18, vatRemoved: 48.11, vatExempt: 320.71, promoWasHigher: false },
    ];
    const t2 = text(workedReceipt({ diners: d }));
    expect(t2.match(/Signature:\s*_{6,}/g)).toHaveLength(2);
    expect(t2).toMatch(/\bPWD\b/);
    expect(t2).toContain('Mang B');
    expect(t2).toContain('PWD-2');
  });

  it('a diner who took the higher promo is marked "promo was higher"', () => {
    const d: WireDiner[] = [{ kind: 'senior', name: 'Lola A', idNo: 'OSCA-1', share: 449, discount: 224.5, vatRemoved: 24.05, vatExempt: 200.45, promoWasHigher: true }];
    expect(text(workedReceipt({ diners: d }))).toMatch(/promo was higher/i);
  });

  it('a non-VAT store labels the exempt row "SC/PWD SALES" and never says VAT-EXEMPT', () => {
    const r = workedReceipt({ vatType: 'NON_VAT' });
    r.store = mkStore('NON_VAT', 0);
    r.analytics = { ...r.analytics, taxAmount: 0, vatableSales: 1600, vatExemptSales: 359.2, discountsTotal: 89.8, statutoryDiscountTotal: 89.8, statutoryVatRemovedTotal: 0, grandTotal: 2024.2 };
    const tn = text(r);
    expect(tn).toMatch(/SC\/PWD SALES/);
    expect(tn).not.toMatch(/VAT-EXEMPT/i);
  });

  it('no diners: none of the new text (the old receipt is unchanged)', () => {
    const r = workedReceipt({ diners: [] });
    r.analytics = { subtotal: 2114, discountsTotal: 0, chargesTotal: 0, taxAmount: 226.5, vatableSales: 1887.5, vatExemptSales: 0, grandTotal: 2114, totalPaid: 2114, change: 0, mop: {} };
    const tn = text(r);
    expect(tn).not.toMatch(/Signature/i);
    expect(tn).not.toMatch(/Less: VAT exemption/i);
    expect(tn).not.toMatch(/SC\/PWD/);
    expect(tn).toMatch(/SUBTOTAL/);
  });
});

describe('the printed receipt adds up on every generated bill (property; kills a receipt that does not add up)', () => {
  /** A receipt document built from the exact oracle's numbers, the way the S3 writer must build it. */
  function receiptFor(b: StatBill) {
    const o = oracleStat({ subtotalC: b.subtotalC, store: b.store, promoPct: b.promoPct, adjustments: b.adjustments, loyalty: b.loyalty, sharesC: b.sharesC });
    const disc = allocate(o.statutoryDiscountTotal, b.sharesC);
    const vat = allocate(o.statutoryVatRemovedTotal, b.sharesC);
    const diners: WireDiner[] = b.input.diners.map((d, i) => ({
      kind: d.kind, name: d.name, idNo: d.idNo, share: b.sharesC[i]! / 100, discount: disc[i]! / 100, vatRemoved: vat[i]! / 100,
      vatExempt: (b.sharesC[i]! - disc[i]! - vat[i]!) / 100, promoWasHigher: false,
    }));
    return {
      o,
      doc: {
        session: { id: 's1', sessionMode: b.mode, tableNumber: '1', paymentSummary: {}, closedAt: null, startedByUid: 'u1' },
        lines: b.lines, payments: [], settings: settings(b.store.taxType === 'NON_VAT' ? 'NON_VAT' : 'VAT'), store: b.store, receiptNumber: 'SHT-01-000001', receiptCreatedAt: 1,
        statutoryDiners: diners,
        analytics: {
          subtotal: o.subtotal / 100, discountsTotal: o.totalDiscounts / 100, chargesTotal: o.chargesTotal / 100, taxAmount: o.taxTotal / 100,
          vatableSales: o.vatableSales / 100, vatExemptSales: o.vatExemptSales / 100, grandTotal: o.grandTotal / 100, totalPaid: o.grandTotal / 100, change: 0, mop: {},
          statutoryDiscountTotal: o.statutoryDiscountTotal / 100, statutoryVatRemovedTotal: o.statutoryVatRemovedTotal / 100,
        },
      } as any,
    };
  }

  it('SUBTOTAL - DISCOUNTS - VAT exemption + CHARGES = TOTAL, and every diner has a name, a full ID and a signature line (600 bills, 58mm small font and 80mm)', () => {
    const bills = fc.sample(statBillArb, { numRuns: 600, seed: 426010 }).filter((b) => b.store.taxType !== 'VAT_EXCLUSIVE');
    expect(bills.length).toBeGreaterThan(300);
    const problems: string[] = [];
    let withExemption = 0;
    for (const [i, b] of bills.entries()) {
      const { o, doc } = receiptFor(b);
      const t = i % 2 ? text(doc, 58, 'small') : text(doc, 80, 'normal'); // 42 / 48 columns: every label and value fits on one line
      const bad = (m: string) => { if (problems.length < 15) problems.push(`#${i} ${b.store.taxType}: ${m}`); };
      try {
        const sub = num(line(t, 'SUBTOTAL'));
        const dis = (o.totalDiscounts > 0) ? num(line(t, 'DISCOUNTS')) : 0;
        const less = (o.statutoryVatRemovedTotal > 0) ? num(line(t, 'Less: VAT exemption')) : 0;
        const chg = (o.chargesTotal > 0) ? num(line(t, 'CHARGES')) : 0;
        const tot = num(line(t, 'TOTAL'));
        if (o.statutoryVatRemovedTotal > 0) withExemption++;
        if (sub - dis - less + chg !== tot) bad(`${sub} - ${dis} - ${less} + ${chg} != ${tot}`);
        if (tot !== o.grandTotal) bad(`TOTAL ${tot} vs ${o.grandTotal}`);
      } catch (e: any) { bad(String(e.message).split('\n')[0]!); }
      const sigs = (t.match(/Signature:\s*_{6,}/g) ?? []).length;
      if (sigs !== b.input.diners.length) bad(`${sigs} signature lines for ${b.input.diners.length} diners`);
      for (const d of b.input.diners) if (!t.includes(d.idNo) || !t.includes(d.name)) bad(`diner ${d.name} / ${d.idNo} missing from the print`);
    }
    expect(withExemption).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });
});

describe('the on-screen receipt (ReceiptView)', () => {
  const html = renderToStaticMarkup(createElement(ReceiptView as any, { data: workedReceipt(), paymentMethods: [] }));
  it('shows the VAT exemption row, the diner\'s name and full ID, the discount and a signature line', () => {
    expect(html).toMatch(/Less: VAT exemption \(SC\/PWD\)/i);
    expect(html).toContain('Lola Remedios Cruz');
    expect(html).toContain('OSCA-2024-001187');
    expect(html).toMatch(/Signature:\s*_{6,}/);
    expect(html).toMatch(/80\.18/);
    expect(html).toMatch(/320\.71/);
  });
});
