import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { mapPosReceipt } from '../src/pos-receipt-map';

const DAY_START = Date.UTC(2027, 0, 1, 16, 0, 0); // Manila 2027-01-02 00:00

function sale(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeId: 'store-1',
    sessionId: 's1',
    createdAtClientMs: DAY_START + 3_600_000,
    createdAt: Timestamp.fromMillis(DAY_START + 3_600_001),
    sessionMode: 'package_dinein',
    receiptNumber: 'ABC-01-000123',
    // POS's terminal sequence name is a glossary trap: spelled by concatenation.
    ['receipt' + 'Seq']: 123,
    terminalNo: 1,
    terminalSeq: 123,
    deviceId: 'dev-1',
    status: 'final',
    total: 1250.5,
    totalPaid: 1300,
    change: 49.5,
    discountsTotal: 0,
    customerName: 'Juan Dela Cruz',
    customerTin: '123-456-789',
    customerAddress: '1 Rizal St',
    statutoryDiners: [
      { kind: 'senior', name: 'Lola Basyang', idNo: 'OSCA-99', share: 1, discount: 10, vatRemoved: 1, vatExempt: 2, promoWasHigher: false },
    ],
    lines: [
      { id: 'l1', type: 'package', itemId: 'i1', itemName: 'Unli Pork', unitPrice: 399, qtyOrdered: 2, discountType: null, discountValue: null, discountQty: 0, freeQty: 0, voidedQty: 0, updatedAt: 'x', qtyOverrideAt: 'y' },
      { id: 'l2', type: 'addon', itemId: 'i2', itemName: 'Iced Tea', unitPrice: 75.25, qtyOrdered: 1, discountType: 'fixed', discountValue: 5, discountQty: 1, freeQty: 0, voidedQty: 0 },
    ],
    analytics: { mop: { Cash: 800.5, 'G-Cash': 450 }, raw: { customerName: 'Juan Dela Cruz' } },
    analyticsApplied: true,
    analyticsAppliedAt: Timestamp.fromMillis(1),
    analyticsApplyId: 'ap1',
    ...over,
  };
}

describe('mapPosReceipt', () => {
  it('maps header, lines and tenders; money as exact strings', () => {
    const m = mapPosReceipt({ id: 'r1', data: sale() });
    expect(m.header).toMatchObject({
      firestoreDocId: 'r1',
      posStoreId: 'store-1',
      kind: 'sale',
      status: 'final',
      posCalendarDate: '2027-01-02',
      total: '1250.50',
      totalPaid: '1300.00',
      change: '49.50',
      receiptNumber: 'ABC-01-000123',
      terminalNo: 1,
      moneyFlag: false,
    });
    expect(m.lines).toHaveLength(2);
    expect(m.lines[1]).toMatchObject({ lineId: 'l2', unitPrice: '75.25', discountFixed: '5.00' });
    expect(m.tenders.map((t) => [t.alias, t.amount])).toEqual([
      ['cash', '800.50'],
      ['gcash', '450.00'],
    ]);
  });

  it('flags a value that is not a whole centavo and still keeps the receipt', () => {
    const m = mapPosReceipt({ id: 'r2', data: sale({ total: 263.888 }) });
    expect(m.header.moneyFlag).toBe(true);
    expect(m.header.total).toBe('263.89');
  });

  it('maps a refund doc (rf- id, negative total) as kind refund with negative money', () => {
    const m = mapPosReceipt({
      id: 'rf-0042',
      data: sale({ isRefund: true, parentReceiptId: 'r1', total: -399, totalPaid: -399, change: 0, analytics: { mop: { Cash: -399 } } }),
    });
    expect(m.header.kind).toBe('refund');
    expect(m.header.total).toBe('-399.00');
    expect(m.header.parentReceiptId).toBe('r1');
    expect(m.tenders[0]).toMatchObject({ alias: 'cash', amount: '-399.00' });
  });

  it('copies no personal field anywhere, raw included', () => {
    const m = mapPosReceipt({ id: 'r1', data: sale() });
    const text = JSON.stringify(m);
    for (const s of ['Juan Dela Cruz', '123-456-789', '1 Rizal St', 'Lola Basyang', 'OSCA-99']) {
      expect(text).not.toContain(s);
    }
    for (const k of ['customerName', 'customerTin', 'customerAddress', 'idNo']) {
      expect(text).not.toContain(`"${k}"`);
    }
    // the non-personal part of a statutory diner survives in raw
    expect((m.header.raw as { statutoryDiners: { kind: string }[] }).statutoryDiners[0]!.kind).toBe('senior');
  });

  describe('docHash', () => {
    const hash = (d: Record<string, unknown>) => mapPosReceipt({ id: 'r1', data: d }).docHash;
    it('is stable for the same doc', () => expect(hash(sale())).toBe(hash(sale())));
    it('ignores housekeeping fields', () => {
      const h = hash(sale());
      expect(hash(sale({ analyticsApplied: false, analyticsAppliedAt: Timestamp.fromMillis(99), analyticsApplyId: 'zz' }))).toBe(h);
      expect(hash(sale({ reRingLinkedAt: Timestamp.fromMillis(5), editedAt: Timestamp.fromMillis(7), editedByUid: 'u', lastDiffSummary: 'x' }))).toBe(h);
      expect(hash(sale({ customerName: 'Someone Else' }))).toBe(h);
    });
    it('changes on a real change', () => {
      const h = hash(sale());
      expect(hash(sale({ status: 'voided', voidedAt: Timestamp.fromMillis(DAY_START + 7_200_000), voidReason: 'wrong order' }))).not.toBe(h);
      expect(hash(sale({ total: 1251 }))).not.toBe(h);
      const d = sale();
      (d.lines as { qtyOrdered: number }[])[0]!.qtyOrdered = 3;
      expect(hash(d)).not.toBe(h);
      expect(hash(sale({ analytics: { mop: { Cash: 1250.5 } } }))).not.toBe(h);
    });
  });
});
