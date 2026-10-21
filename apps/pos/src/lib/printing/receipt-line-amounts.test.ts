import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ReceiptData, SessionBillLine } from '@/lib/types';
import { formatReceiptText } from './receiptFormatter';
import { ReceiptView } from '@/components/receipt/receipt-view';
import { receiptLineAmounts } from './receipt-line-amounts';
import { mkStore } from '@/test-helpers/statutoryOracle';

const item = (over: Partial<SessionBillLine> = {}): SessionBillLine => ({
  id: 'line', type: 'addon', itemId: 'dish', itemName: 'Test dish', unitPrice: 100,
  qtyOrdered: 1, voidedQty: 0, freeQty: 0, discountType: null, discountValue: null,
  discountQty: 0, createdAt: null, updatedAt: null, ...over,
});
const receipt = (lines: SessionBillLine[]): ReceiptData => ({
  session: { id: 's', sessionMode: 'alacarte', paymentSummary: {}, closedAt: null, startedByUid: 'synthetic' }, lines, payments: [],
  settings: { businessName: 'Synthetic', branchName: 'Test', address: '', contact: '',
    showLogo: false, showDiscountBreakdown: true, showCashierName: false, showTableOrCustomer: false,
    showItemNotes: false, showChargeBreakdown: true, paperWidth: '80mm', autoPrintAfterPayment: false,
    fontSize: 12, fontFamily: 'monospace' },
  store: mkStore('VAT_INCLUSIVE', 12),
  analytics: { subtotal: 123.45, grandTotal: 123.45 },
});
const thermalRow = (data: ReceiptData, name = 'Test dish', width: 58 | 80 = 80) =>
  formatReceiptText(data, width).split('\n').find(row => row.includes(name));
const preview = (data: ReceiptData) => renderToStaticMarkup(createElement(ReceiptView, { data }));

describe('DEF-716 receipt item amounts', () => {
  it.each([58, 80] as const)('excludes a free and a void unit, includes modifiers on the paid unit (%smm)', width => {
    const data = receipt([item({ qtyOrdered: 3, voidedQty: 1, freeQty: 1, modifiersTotal: 12.5, modifiersText: 'Extra cheese' })]);
    expect(thermalRow(data, 'Test dish', width)).toMatch(/112\.50\s*$/);
    expect(formatReceiptText(data, width)).toContain('Free: 1');
    expect(formatReceiptText(data, width)).toContain('Extra cheese');
    const html = preview(data);
    expect(html).toContain('112.50');
    expect(html).not.toContain('225.00');
    expect(html).toContain('Free: 1');
    expect(html).toContain('123.45'); // persisted grand total is not recalculated
  });
  it('shows an all-free line at zero, never charging its modifiers', () => {
    const data = receipt([item({ qtyOrdered: 2, freeQty: 2, modifiersTotal: 25 })]);
    expect(thermalRow(data)).toMatch(/\s0\.00\s*$/);
    expect(preview(data)).not.toContain('250.00');
  });
  it('allocates a rounded bill stage instead of independently rounding fractional lines', () => {
    const data = receipt(['PartA', 'PartB', 'PartC'].map((name, index) => item({ id: String(index), itemName: name, unitPrice: 0.01, qtyOrdered: 0.5 })));
    expect(thermalRow(data, 'PartA')).toMatch(/0\.01\s*$/);
    expect(thermalRow(data, 'PartB')).toMatch(/0\.01\s*$/);
    expect(thermalRow(data, 'PartC')).toMatch(/0\.00\s*$/); // total 0.02, not 0.03
  });
  it('uses exact gross-price line discounts in preview, including modern adjustment records', () => {
    const data = receipt([item({ unitPrice: 112, lineAdjustments: { a: { id: 'a', kind: 'discount', type: 'percent', value: 20, qty: 1, note: 'Promo', createdAtClientMs: 1 } as never } })]);
    expect(preview(data)).toContain('22.40'); // 20% of gross 112, not net 100
  });
  it('retains an ordinary line and hides fully voided items without store metadata', () => {
    const data = receipt([item(), item({ id: 'void', itemName: 'Voided item', voidedQty: 1 })]);
    data.store = undefined;
    expect(thermalRow(data)).toMatch(/100\.00\s*$/);
    expect(formatReceiptText(data)).not.toContain('Voided item');
    expect(preview(data)).toContain('100.00');
    expect(preview(data)).not.toContain('Voided item');
  });
  it('preserves signed historical modifier amounts instead of refusing a reprint', () => {
    const data = receipt([item({ modifiersTotal: -105 }), item({ id: 'second', itemName: 'Other', unitPrice: 20 })]);
    expect(thermalRow(data)).toMatch(/-5\.00\s*$/);
    expect(thermalRow(data, 'Other')).toMatch(/20\.00\s*$/);
    expect(receiptLineAmounts(data.lines ?? []).map(row => row.grossCentavos)).toEqual([-500, 2000]);
  });
  it('uses paid quantities, caps adjustment quantity, and retains the VAT-exclusive charge base', () => {
    const line = item({ qtyOrdered: 3, voidedQty: 1, freeQty: 1, unitPrice: 112, modifiersTotal: 28,
      lineAdjustments: {
        d: { id: 'd', kind: 'discount', type: 'percent', value: 20, qty: 99, note: '', createdAtClientMs: 1, createdByUid: 'test' },
        c: { id: 'c', kind: 'charge', type: 'percent', value: 10, qty: 1, note: '', createdAtClientMs: 2, createdByUid: 'test' },
      } });
    expect(receiptLineAmounts([line], { taxType: 'VAT_INCLUSIVE', taxRatePct: 12 })[0]).toMatchObject({
      activeQty: 2, grossCentavos: 14000, discountCentavos: 2800, chargeCentavos: 1250,
    });
  });
  it('caps legacy fixed discounts at the paid unit price including modifiers', () => {
    const line = item({ unitPrice: 100, modifiersTotal: 25, discountType: 'fixed', discountValue: 999, discountQty: 9 });
    expect(receiptLineAmounts([line])[0].discountCentavos).toBe(12500);
  });
  it('pins packages first without changing source order and uses that stable order for centavo ties', () => {
    const input = [item({ id: 'a', qtyOrdered: 0.5, unitPrice: 0.01 }), item({ id: 'p', type: 'package', qtyOrdered: 0.5, unitPrice: 0.01 })];
    const copy = JSON.stringify(input);
    const rows = receiptLineAmounts(input);
    expect(rows.map(row => [row.line.id, row.grossCentavos])).toEqual([['p', 1], ['a', 0]]);
    expect(JSON.stringify(input)).toBe(copy);
    expect(receiptLineAmounts([])).toEqual([]);
  });
  it('retains aggregate centavos when positive and negative fractional lines cancel', () => {
    const rows = receiptLineAmounts([
      item({ unitPrice: 0, modifiersTotal: -0.01, qtyOrdered: 0.5 }),
      item({ id: 'b', unitPrice: 0.03, qtyOrdered: 0.5 }),
    ]);
    expect(rows.map(row => row.grossCentavos)).toEqual([0, 1]);
  });
});
