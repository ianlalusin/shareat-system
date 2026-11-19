/**
 * T-601 S4 - the store mode reaches the paper: the slip builders and the cached snapshot carry `test` through to TEST - NOT A SALE. Made-up names only.
 */
import { describe, expect, it } from 'vitest';
import { formatRefundSlip, formatXSlip, formatZSlip } from '@/lib/pos-print';
import { paymentPartOf } from '@/app/pos/_shell/payment-part';
import { readingSlipView, zSlipView, type ReadingJson } from '@/app/pos/_till/slips';
import { refundSlipView, type RefundSlipJson } from '@/app/pos/receipts/refund-slip';

const READING: ReadingJson = {
  receiptCount: 1, grossTotal: '100.00', subtotal: '100.00', discountTotal: '0.00', discounts: { senior: '0.00', pwd: '0.00', other: '0.00' },
  byTender: [{ name: 'Cash', amount: '100.00' }], toCheckCount: 0, lateCount: 0, spansTwoDates: false,
};
const SLIP: RefundSlipJson = {
  refundNo: 'SL-R-000001', receiptNo: 'SL-01-000007', recordedAt: '2026-11-20T04:30:00.000Z', reason: 'x', total: '10.00',
  lines: [{ name: 'Pork', qty: 1, amount: '10.00' }], payments: [{ tenderName: 'Cash', amount: '10.00', referenceNo: null }], approvedByName: 'Mia', recordedByName: 'Joy',
};
const layout = { width: 58 as const, font: 'normal' as const };
const has = (lines: string[]) => lines.map((l) => l.trim()).includes('TEST - NOT A SALE');
const ctx = (mode?: string) => ({ storeName: 'Acme Lipa', vatRegistered: true, printedBy: 'Joy', ...(mode ? { mode } : {}) });

describe('T-601 S4 - callers pass the store mode', () => {
  it('X, Z and refund slips carry the line for test and not for live or no mode', () => {
    const z = { zNo: 3, businessDate: '2026-11-14', approvedBy: 'Mia', reprint: false };
    expect(has(formatXSlip(readingSlipView(READING, ctx('test')), layout))).toBe(true);
    expect(has(formatZSlip(zSlipView(READING, ctx('test'), z), layout))).toBe(true);
    expect(has(formatRefundSlip(refundSlipView(SLIP, { storeName: 'Acme Lipa', vatRegistered: true, mode: 'test' }), layout))).toBe(true);
    for (const mode of ['live', undefined]) {
      expect(has(formatXSlip(readingSlipView(READING, ctx(mode)), layout))).toBe(false);
      expect(has(formatZSlip(zSlipView(READING, ctx(mode), z), layout))).toBe(false);
      expect(has(formatRefundSlip(refundSlipView(SLIP, { storeName: 'Acme Lipa', vatRegistered: true, mode }), layout))).toBe(false);
    }
  });

  it('the cached snapshot keeps the store mode for the Payment screen, and an old one without it still loads', () => {
    const body = (store: Record<string, unknown>): Record<string, unknown> => ({
      store: { storeId: 's', name: 'Acme Lipa', terminalNo: 1, vatRegistered: true, receiptPaperMm: 58, receiptCopies: 1, ...store },
      rules: { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 }, tenders: [], discountPresets: [], staff: [],
    });
    expect(paymentPartOf(body({ mode: 'test' }))?.store.mode).toBe('test');
    expect(paymentPartOf(body({}))?.store.mode).toBeUndefined();
  });

  it('T-601 S5: the cached snapshot keeps the store code for the receipt number, and an old one without it still loads', () => {
    const body = (store: Record<string, unknown>): Record<string, unknown> => ({
      store: { storeId: 's', name: 'Acme Lipa', terminalNo: 1, vatRegistered: true, receiptPaperMm: 58, receiptCopies: 1, ...store },
      rules: { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 }, tenders: [], discountPresets: [], staff: [],
    });
    expect(paymentPartOf(body({ code: 'LIP' }))?.store.code).toBe('LIP');
    expect(paymentPartOf(body({}))?.store.code).toBeUndefined();
    expect(paymentPartOf(body({ code: '' }))?.store.code).toBeUndefined();
  });
});
