/**
 * T-398 S5d (TESTER) - B1: Lipa's New trade order form must let a person save a draft for a customer linked to another company
 * (an inter-entity sale, the T-398 S5 feature). Found in the 26 Oct smoketest: the form still says "Another company - not yet supported
 * (T-133 section 4)" and disables Save draft. Rendered the way t343-s7-trade-line-numbers renders the form (static markup, first customer selected).
 *
 * ASSUMED (flagged): the option carries the linked company's name as `counterpartyOrgName`, so the hint can read "Inter-entity sale to <name>"
 * like the order page. The hint legs that need the name are B1c; B1a/B1b do not depend on it.
 * MUTANTS: `unsupported` left true for inter_entity -> B1a, B1b; hint text left as the old sentence -> B1b; name not shown -> B1c.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

async function render(extra: Record<string, unknown> = {}) {
  const { NewOrderForm } = await import('../src/app/trade/orders/NewOrderForm');
  return renderToStaticMarkup(
    createElement(NewOrderForm, {
      action: () => undefined,
      stores: [{ id: 'store-1', code: 'S1', name: 'Store One' }],
      storeId: 'store-1',
      customers: [
        {
          id: 'cust-1',
          name: 'Padre Garcia',
          customerGroup: 'franchise',
          treatment: 'inter_entity',
          counterpartyStoreId: null,
          priceListId: null,
          creditLimit: null,
          ...extra,
        },
      ],
      items: [{ id: 'item-1', code: 'ITM1', name: 'Pork belly', baseUnit: 'kg' }],
      quotes: {},
      branchPrices: {},
      today: '2026-10-26',
    } as never),
  );
}

/** The opening tag of the button whose text is "Save draft". */
const saveButton = (html: string) => {
  const seg = html.split('<button').slice(1).find((x) => x.slice(0, x.indexOf('</button>')).includes('Save draft'));
  return seg ? `<button${seg.slice(0, seg.indexOf('>') + 1)}` : '';
};

describe('B1 an inter-entity customer can be ordered for', () => {
  it('B1a. Save draft is ENABLED when the selected customer is linked to another company', async () => {
    const html = await render();
    const tag = saveButton(html);
    expect(tag, 'no Save draft button found').not.toBe('');
    // The ATTRIBUTE only: every kit Button carries the Tailwind class disabled:pointer-events-none, which a bare word match also hits.
    // Mutant killed: the old `unsupported` state (disabled={treatment === 'inter_entity'}) renders ` disabled=""` -> red.
    expect(/\sdisabled(=|\s|>)/.test(tag), `Save draft is disabled: ${tag.slice(0, 120)}`).toBe(false);
  });

  it('B1b. the hint says it is an inter-entity sale and no longer says "not yet supported"', async () => {
    const html = await render();
    expect(html).not.toMatch(/not yet supported/i);
    expect(html).not.toContain('T-133');
    expect(html).toMatch(/inter-entity sale/i);
  });

  it('B1c. the hint names the other company, like the order page ("Inter-entity sale to <name>")', async () => {
    const html = await render({ counterpartyOrgName: 'Padre Garcia Foods Inc' });
    expect(html).toContain('Inter-entity sale to Padre Garcia Foods Inc');
  });
});
