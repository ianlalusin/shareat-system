/**
 * T-585 R2 + R3 (tester, written first) - the issuer identity reaches the X/Z slips and survives the offline snapshot cache.
 * Made-up names and numbers only.
 */
import { describe, expect, it } from 'vitest';
import { formatXSlip, formatZSlip } from '@/lib/pos-print';
import { paymentPartOf } from '@/app/pos/_shell/payment-part';
import { readingSlipView, zSlipView, type ReadingJson } from '@/app/pos/_till/slips';

const identity = { businessName: 'Acme Grill Foods Inc.', addressLines: ['12 Sample St', 'Test City'], tin: '123-456-789-00002' };
const READING: ReadingJson = {
  receiptCount: 1, grossTotal: '100.00', subtotal: '100.00', discountTotal: '0.00', discounts: { senior: '0.00', pwd: '0.00', other: '0.00' },
  byTender: [{ name: 'Cash', amount: '100.00' }], toCheckCount: 0, lateCount: 0, spansTwoDates: false,
};
const layout = { width: 58 as const, font: 'normal' as const };
const trimmed = (lines: string[]) => lines.map((l) => l.trim());

describe('X and Z slips', () => {
  it('print the identity: legal name, address, TIN with branch', () => {
    const ctx = { storeName: 'Acme Lipa', vatRegistered: true, printedBy: 'Joy', identity };
    const x = trimmed(formatXSlip(readingSlipView(READING, ctx), layout));
    expect(x.slice(0, 4)).toEqual(['ACME GRILL FOODS INC.', '12 Sample St', 'Test City', 'TIN: 123-456-789-00002 VAT']);
    const z = trimmed(formatZSlip(zSlipView(READING, ctx, { zNo: 3, businessDate: '2026-11-14', approvedBy: 'Mia', reprint: false }), layout));
    expect(z.slice(0, 4)).toEqual(['ACME GRILL FOODS INC.', '12 Sample St', 'Test City', 'TIN: 123-456-789-00002 VAT']);
  });

  it('without an identity (old caller) print the store name only and no TIN label', () => {
    const x = trimmed(formatXSlip(readingSlipView(READING, { storeName: 'Acme Lipa', vatRegistered: true, printedBy: 'Joy' }), layout));
    expect(x[0]).toBe('ACME LIPA');
    expect(x.join('\n')).not.toMatch(/TIN/);
  });
});

describe('the offline snapshot cache', () => {
  const body = (store: Record<string, unknown> = {}): Record<string, unknown> => ({
    store: { storeId: 's1', name: 'Acme Lipa', mode: 'live', terminalNo: 2, vatRegistered: true, receiptPaperMm: 58, receiptCopies: 1, ...store },
    tenders: [], discountPresets: [], rules: { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 }, staff: [], stands: [], menu: {},
  });

  it('round trip: the identity survives JSON storage and comes out of paymentPartOf', () => {
    const cached = JSON.parse(JSON.stringify(body({ identity }))) as Record<string, unknown>;
    expect(paymentPartOf(cached)?.store.identity).toEqual(identity);
  });

  it('an OLD snapshot without the identity still gives a payment part (no crash, identity absent)', () => {
    const part = paymentPartOf(body());
    expect(part).not.toBeNull();
    expect(part?.store.identity).toBeUndefined();
  });
});
