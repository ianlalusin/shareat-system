import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input } from '../src/components/ui/Input';
import { Select } from '../src/components/ui/Select';
import { Button } from '../src/components/ui/Button';
import { Textarea } from '../src/components/ui/Textarea';
import * as forms from '../src/components/ui/FormGrid';
import { NewDeliveryForm } from '../src/app/inventory/deliveries/NewDeliveryForm';
import { NewOrderForm } from '../src/app/trade/orders/NewOrderForm';

describe('T-445 approved compact controls', () => {
  it.each([Input, Select, Button])('marks shared single-line controls while retaining the touch minimum', (Control) => {
    const html = renderToStaticMarkup(createElement(Control as never, { name: 'sample' }));
    expect(html).toContain('data-erp-control="single"');
    expect(html).toContain('min-h-11');
  });
  it('keeps multiline geometry separate', () => {
    const html = renderToStaticMarkup(createElement(Textarea, { name: 'notes' }));
    expect(html).toContain('data-erp-control="multiline"');
    expect(html).toContain('min-h-24');
  });
  it('limits desktop density to a fine pointer and leaves file/checkbox/radio targets out', () => {
    const css = readFileSync('apps/erp/src/app/globals.css', 'utf8');
    expect(css).toContain('@media (min-width: 768px) and (pointer: fine)');
    expect(css).toContain('min-height: 32px');
    expect(css).toContain('[data-erp-control="single"]:not([type="file"]):not([type="checkbox"]):not([type="radio"])');
  });
  it('defaults entry forms to shared compact fields and preserves an explicit grid', () => {
    const props = { layout: 'fields' } as unknown as Parameters<typeof forms.FormGrid>[0];
    expect(renderToStaticMarkup(createElement(forms.FormGrid, props, 'x'))).toContain('erp-form-fields');
    expect(renderToStaticMarkup(createElement(forms.FormGrid, {}, 'x'))).toContain('erp-form-fields');
    expect(renderToStaticMarkup(createElement(forms.FormGrid, { layout: 'grid' }, 'x'))).toContain('repeat(auto-fit,minmax(min(100%,14rem),1fr))');
  });
  it('keeps wide spans and deliberate grid column overrides in a grid', () => {
    expect(renderToStaticMarkup(createElement(forms.FormGrid, {}, createElement(forms.Field, { label: 'Reason', span: 'wide' }, 'Text')))).toContain('repeat(auto-fit');
    expect(renderToStaticMarkup(createElement(forms.FormGrid, { className: 'md:grid-cols-3' }, 'Text'))).toContain('repeat(auto-fit');
  });
  it('infers short units, date and money widths while preserving explicit full and span widths', () => {
    const render = (props: Parameters<typeof forms.Field>[0], control: Record<string, string>) => renderToStaticMarkup(createElement(forms.Field, props, createElement(Input, control)));
    expect(render({ label: 'Unit' }, { name: 'baseUnit' })).toContain('erp-field-short');
    expect(render({ label: 'Date' }, { type: 'date' })).toContain('erp-field-date');
    expect(render({ label: 'Amount' }, { name: 'amount', inputMode: 'decimal' })).toContain('erp-field-code');
    expect(render({ label: 'Full', width: 'full' }, { name: 'baseUnit' })).toContain('erp-field-full');
    expect(render({ label: 'Wide', span: 'wide' }, { name: 'baseUnit' })).not.toContain('erp-field-short');
  });
  it('keeps a short field label and live rule wrapper together', () => {
    const props = { label: 'Unit', width: 'short' } as unknown as Parameters<typeof forms.Field>[0];
    const html = renderToStaticMarkup(createElement(forms.Field, props, createElement(Input, { name: 'baseUnit' })));
    expect(html).toContain('erp-field-short');
    expect(html).toContain('<label');
    expect(html).toContain('name="baseUnit"');
    expect(html).not.toContain('width="short"');
  });
  it('exports a native section with a visible legend', () => {
    const Section = (forms as unknown as { FormSection: typeof forms.FormGrid }).FormSection;
    expect(typeof Section).toBe('function');
    if (!Section) return;
    const html = renderToStaticMarkup(createElement(Section, { title: 'Document' } as never, 'fields'));
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend');
    expect(html).toContain('Document');
  });
  it('preserves delivery fields, required receipt and line actions inside the named sections', () => {
    const html = renderToStaticMarkup(createElement(NewDeliveryForm, {
      action: () => {}, storeId: 'store', today: '2026-10-19',
      suppliers: [{ id: 'supplier', name: 'Sample Foods' }],
      items: [{ id: 'item', code: 'KMCH-001', name: 'Kimchi', baseUnit: 'g' }], locations: [],
    }));
    for (const name of ['storeId', 'kind', 'supplierId', 'referenceNo', 'deliveredOn', 'proofPhoto', 'itemId', 'orderedQuantity', 'purchaseUnit', 'conversionFactor', 'unitCost', 'locationId']) {
      expect(html).toContain(`name="${name}"`);
    }
    for (const section of ['Document', 'Receipt evidence', 'Items received']) expect(html).toContain(`>${section}</legend>`);
    expect(html).toMatch(/<input[^>]*name="proofPhoto"[^>]*required=""/);
    expect(html).toContain('aria-label="Remove line"');
    expect((html.match(/<form\b/g) ?? []).length).toBe(1);
  });
  it('preserves trade order defaults and the unsupported-counterparty refusal while sectioning fields', () => {
    const props: Parameters<typeof NewOrderForm>[0] = {
      action: () => {}, storeId: 'store', today: '2026-10-19',
      stores: [{ id: 'store', name: 'Lipa', code: 'LIPA' }],
      customers: [{ id: 'buyer', name: 'Sample buyer', customerGroup: 'wholesale', treatment: 'external', counterpartyStoreId: null, priceListId: null }],
      items: [{ id: 'item', code: 'KMCH-001', name: 'Kimchi', baseUnit: 'g' }],
      quotes: { buyer: { item: '0.1800' } }, branchPrices: {},
    };
    const html = renderToStaticMarkup(createElement(NewOrderForm, props));
    for (const name of ['storeId', 'customerId', 'orderDate', 'referenceNo', 'itemId', 'quantity', 'rate', 'deliveryFee', 'otherFees', 'notes']) expect(html).toContain(`name="${name}"`);
    for (const section of ['Document', 'Order lines', 'Fees and notes']) expect(html).toContain(`>${section}</legend>`);
    expect(html).toContain('placeholder="₱0.1800"');
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    const refused = renderToStaticMarkup(createElement(NewOrderForm, { ...props, customers: props.customers.map(c => ({ ...c, treatment: 'inter_entity' as const })) }));
    expect(refused).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
