import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FindReceipt } from '../src/app/pos/receipts/FindReceipt';

/** T-613 D4 - the "Find a receipt" box: a plain GET form carrying the typed number (and the requested store), touch-sized controls. */
describe('FindReceipt', () => {
  it('is a GET search form with the typed number kept, the store carried, and 48px controls', () => {
    const html = renderToStaticMarkup(createElement(FindReceipt, { value: 'LIP-01-000123', storeId: 'store-1', days: 30 }));
    expect(html).toContain('method="get"');
    expect(html).toContain('name="find"');
    expect(html).toContain('value="LIP-01-000123"');
    expect(html).toContain('name="storeId"');
    expect(html).toContain('last 30 days');
    expect(html.match(/min-h-12/g)?.length).toBe(2);
  });
  it('leaves the store out when the page has none', () => {
    expect(renderToStaticMarkup(createElement(FindReceipt, { value: '', days: 30 }))).not.toContain('name="storeId"');
  });
});
