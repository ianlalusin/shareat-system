/**
 * T-598 S4 -- DEF-404 (open items show invoice number and due date), DEF-531 (a partial supplier form leaves the
 * other fields alone), DEF-627 (a duplicate supplier name reads as a sentence).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/ap/actions', () => ({ recordPaymentAction: vi.fn(), autoAllocatePaymentAction: vi.fn() }));

import { AutoAllocatePaymentForm } from '../src/app/ap/suppliers/[id]/AutoAllocatePaymentForm';
import { supplierPlainFieldsFrom } from '../src/app/ap/supplier-form';
import { errorMessage } from '../src/lib/constraint-messages';

const item = (expenseId: string, invoiceNo: string | null, dueDate: string | null) => ({
  expenseId, particulars: 'Stock purchase', businessDate: '2026-01-10', outstanding: '2000.00', invoiceNo, dueDate,
});

function render(items: unknown[]): string {
  return renderToStaticMarkup(
    createElement(AutoAllocatePaymentForm as never, {
      postAction: () => {},
      previewAction: async () => ({ ok: true, allocations: [], unallocated: '0.00' }),
      supplierId: '22222222-2222-4222-8222-222222222222',
      storeId: '11111111-1111-4111-8111-111111111111',
      items,
      wallets: [],
      floats: [],
      today: '2026-01-15',
    } as never),
  ).replace(/&amp;/g, '&');
}

describe('DEF-404: each open item names its invoice and due date', () => {
  it('two invoices with different due dates are told apart', () => {
    const html = render([
      item('33333333-3333-4333-8333-333333333333', 'INV-001', '2026-02-01'),
      item('44444444-4444-4444-8444-444444444444', 'INV-002', '2026-03-15'),
    ]);
    expect(html).toContain('invoice INV-001');
    expect(html).toContain('due February 1, 2026');
    expect(html).toContain('invoice INV-002');
    expect(html).toContain('due March 15, 2026');
  });
  it('an item with no invoice number or due date shows neither', () => {
    const html = render([item('33333333-3333-4333-8333-333333333333', null, null)]);
    expect(html).not.toContain('invoice ');
    expect(html).not.toContain(' due ');
  });
});

describe('DEF-531: the supplier edit form only changes what it sent', () => {
  it('a form that sends only a name leaves address, phone, notes, VAT and status alone', () => {
    const fd = new FormData();
    fd.set('name', 'Tyipco');
    const f = supplierPlainFieldsFrom(fd);
    expect(f).toEqual({ address: undefined, contactNo: undefined, notes: undefined, vatStatus: undefined, status: undefined });
  });
  it('a field that was sent blank clears it; a status that was sent is kept', () => {
    const fd = new FormData();
    fd.set('address', '  ');
    fd.set('contactNo', '0917');
    fd.set('status', 'inactive');
    const f = supplierPlainFieldsFrom(fd);
    expect(f.address).toBeNull();
    expect(f.contactNo).toBe('0917');
    expect(f.status).toBe('inactive');
  });
});

describe('DEF-627: a duplicate supplier name', () => {
  it('reads as a sentence, not the generic fallback', () => {
    const raw = 'duplicate key value violates unique constraint "suppliers_org_name_key"';
    expect(errorMessage(new Error(raw))).toBe('Another supplier is already called that.');
  });
});
