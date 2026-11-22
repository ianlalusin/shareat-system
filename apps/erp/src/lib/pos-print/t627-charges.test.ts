import { money } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import { formatReceipt } from './receipt-text';
import { formatRefundSlip } from './refund-text';
import { formatXSlip, formatZSlip } from './reading-text';
import type { ReadingSlipView, ReceiptView, RefundSlipView, ZSlipView } from './types';

/**
 * T-627 (test 5) - store charges on the paper: the receipt prints each charge by name with its amount under the VAT block and then AMOUNT DUE; the X and the Z print a
 * CHARGES row (only when above zero); a refund slip prints CHARGES (only when charges went back). Nothing is computed here: the figures arrive worked out.
 * A bill without charges prints exactly as before (the existing receipt / reading tests pin that).
 */
const L32 = { width: 58 as const, font: 'normal' as const };
const header = { businessName: 'Shareat Lipa', addressLines: ['Lipa City, Batangas'], tin: '123-456-789-000', vatRegistered: true };

function receipt(o: Partial<ReceiptView> = {}): ReceiptView {
  return {
    header, receiptNo: 'LIP-01-000042', issuedAtLocal: '22/11/26 19:52', tableLabel: 'Stand 3', heads: 2, cashierName: 'Joy',
    lines: [{ name: 'Pork belly', qty: 2, unitPrice: money('250.00'), gross: money('500.00'), discounts: [], net: money('500.00') }],
    subtotal: money('500.00'), discountTotal: money('0.00'), total: money('500.00'),
    tenders: [{ name: 'Cash', amount: money('1000.00'), reference: null, toCheck: false }], change: money('150.00'), diners: [], footerLines: [], offline: false, reprint: false,
    vat: { vatRegistered: true, vatableSales: money('446.43'), vatExemptSales: money('0.00'), vatAmount: money('53.57'), vatRateLabel: '12%', vatRemovedForScPwd: money('0.00'), scPwdDiscount: money('0.00') },
    ...o,
  };
}

describe('T-627 receipt paper', () => {
  it('prints each charge by name with its amount, outside the VAT block, then AMOUNT DUE', () => {
    const lines = formatReceipt(receipt({ charges: [{ name: 'Leftover', qty: 3, amount: money('300.00') }, { name: 'Corkage', qty: 1, amount: money('50.00') }], amountDue: money('850.00') }), L32);
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(lines[at('Leftover')]).toMatch(/Leftover x3\s+300\.00$/);
    expect(lines[at('Corkage')]).toMatch(/Corkage\s+50\.00$/);
    expect(lines[at('AMOUNT DUE')]).toMatch(/AMOUNT DUE\s+850\.00$/);
    // goods TOTAL and the VAT block first, charges after them, tenders last
    expect(at('TOTAL')).toBeLessThan(at('VAT (12%)'));
    expect(at('VAT (12%)')).toBeLessThan(at('Leftover'));
    expect(at('AMOUNT DUE')).toBeLessThan(at('Cash'));
    expect(lines.filter((l) => /^TOTAL\s/.test(l))[0]).toMatch(/500\.00$/); // TOTAL is still the goods
  });

  it('a bill with no charges prints no charge lines and no AMOUNT DUE', () => {
    for (const view of [receipt(), receipt({ charges: [], amountDue: money('500.00') })]) {
      const lines = formatReceipt(view, L32);
      expect(lines.some((l) => l.includes('AMOUNT DUE'))).toBe(false);
    }
  });
});

const slip = (): ReadingSlipView => ({
  header, printedBy: 'Cara', windowFromLocal: '22/11/26 04:00', windowToLocal: '22/11/26 22:30', spansTwoDates: false, receiptCount: 2, subtotal: money('750.00'),
  discounts: { senior: money('0.00'), pwd: money('0.00'), other: money('0.00') }, discountTotal: money('0.00'), grossTotal: money('1250.00'),
  unliSales: money('0.00'), alaCarteSales: money('750.00'), heads: 3, packageSessions: 0, seniorPwdDiners: 0,
  tenders: [{ name: 'Cash', amount: money('1250.00') }], toCheckCount: 0, lateCount: 0,
});

describe('T-627 X and Z paper', () => {
  it('the X and the Z print a CHARGES row above GROSS TOTAL when charges were taken', () => {
    const view = { ...slip(), chargeTotal: money('500.00') };
    const z: ZSlipView = { ...view, zNo: 1, businessDateLocal: '22/11/26', approvedBy: 'Manny', reprint: false };
    for (const lines of [formatXSlip(view, L32), formatZSlip(z, L32)]) {
      const charges = lines.findIndex((l) => l.startsWith('CHARGES'));
      expect(lines[charges]).toMatch(/CHARGES\s+\+500\.00$/);
      expect(charges).toBeGreaterThan(-1);
      expect(charges).toBeLessThan(lines.findIndex((l) => l.startsWith('GROSS TOTAL')));
    }
  });

  it('no charges, no row (zero and absent are the same)', () => {
    for (const view of [slip(), { ...slip(), chargeTotal: money('0.00') }]) expect(formatXSlip(view, L32).some((l) => l.startsWith('CHARGES'))).toBe(false);
  });
});

describe('T-627 refund slip', () => {
  const refund = (charges?: string): RefundSlipView => ({
    header, refundNo: 'LIP-R-000001', receiptNo: 'LIP-01-000042', refundedAtLocal: '22/11/26 21:00', lines: [{ name: 'Pork belly', qty: 1, amount: money('250.00') }],
    ...(charges ? { charges: money(charges) } : {}), total: money(charges ? String(250 + Number(charges)) : '250.00'),
    payments: [{ name: 'Cash', amount: money(charges ? String(250 + Number(charges)) : '250.00'), reference: null }], reason: 'Wrong order', approvedBy: 'Manny', recordedBy: 'Cara',
  });
  it('prints CHARGES only when charges went back', () => {
    expect(formatRefundSlip(refund('350.00'), L32).find((l) => l.startsWith('CHARGES'))).toMatch(/CHARGES\s+350\.00$/);
    expect(formatRefundSlip(refund(), L32).some((l) => l.startsWith('CHARGES'))).toBe(false);
    expect(formatRefundSlip(refund('0.00'), L32).some((l) => l.startsWith('CHARGES'))).toBe(false);
  });
});
