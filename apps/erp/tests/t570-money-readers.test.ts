// @vitest-environment happy-dom
/**
 * T-570 AUDIT (blocker + major) - the number box now HOLDS grouped text ("1,234.50"), so every client reader of a money
 * box must ungroup first. Real components, real events, with `NumericEntryBehaviour` mounted as the root layout mounts it:
 *   - MoneyLines: the live Total adds 1,200 and 1,234.50 exactly (it showed 0 and "not a valid amount").
 *   - InvoiceBatchRecord: a payment of 1,734.50 against a 1,734.50 bill enables Save (it was dropped, so Save stayed off).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { NumericEntryBehaviour } from '../src/components/forms/NumericEntry';
import { MoneyLines } from '../src/components/money/MoneyLines';
import { InvoiceBatchRecord } from '../src/components/expenses/InvoiceBatchRecord';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const stops: Array<() => void> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await act(async () => stop());
  document.body.replaceChildren();
});

async function mount(child: unknown) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(h('div', null, h(NumericEntryBehaviour), child as never));
  });
  await act(async () => {
    await tick();
  });
  stops.push(() => root.unmount());
  return host;
}

/** A keystroke: set the value the way typing does and fire `input` (the behaviour then groups it). */
async function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
  });
  await act(async () => {
    await tick();
  });
}
const amount = (n: number) => document.querySelector(`input[name="lineAmount_${n}"]`) as HTMLInputElement;

describe('MoneyLines reads the grouped box', () => {
  it('Total adds "1,200" and "1,234.50" exactly, with no false invalid-amount message', async () => {
    const host = await mount(h(MoneyLines as never, { direction: 'out', sources: [], staff: [] }));
    await type(amount(0), '1200');
    expect(amount(0).value).toBe('1,200');
    expect(host.textContent).toMatch(/Total\s*₱1,200\.00/);
    expect(host.textContent).not.toMatch(/not a valid amount/);
    const add = [...document.querySelectorAll('button')].find((b) => /add another/i.test(`${b.textContent} ${b.getAttribute('aria-label')} ${b.innerHTML}`))!;
    await act(async () => {
      add.click();
      await tick();
    });
    await type(amount(1), '123450');
    await type(amount(1), '1234.50');
    expect(amount(1).value).toBe('1,234.50');
    expect(host.textContent).toMatch(/Total\s*₱2,434\.50/);
    expect(host.textContent).not.toMatch(/not a valid amount/);
  });
});

describe('InvoiceBatchRecord reads the grouped payment box', () => {
  it('a 1,734.50 payment against a 1,734.50 bill enables Save', async () => {
    const parts = [
      { key: 'c1', kind: 'category', categoryId: 'c1', label: 'Food', itemNames: ['Pork'], total: '1500.00', left: '1500.00' },
      { key: 'c2', kind: 'category', categoryId: 'c2', label: 'Gas', itemNames: ['LPG'], total: '234.50', left: '234.50' },
    ];
    const host = await mount(
      h(InvoiceBatchRecord as never, {
        action: () => undefined, invoiceId: 'i', storeId: 's', supplierId: 'sup', supplierName: 'S', supplierCreditTermsDays: null,
        invoiceStatus: 'pending', view: { invoiceId: 'i', itemised: true, linesExceedTotal: false, parts },
        categories: [], moneyLines: { sources: [], staff: [] }, returnTo: '/x',
      }),
    );
    const save = () => [...host.querySelectorAll('button')].find((b) => b.type === 'submit') as HTMLButtonElement;
    await type(amount(0), '1000');
    expect(host.textContent).toMatch(/payments add up to ₱1,000\.00/);
    expect(save().disabled).toBe(true);
    await type(amount(0), '1734.50');
    expect(amount(0).value).toBe('1,734.50');
    expect(host.textContent).not.toMatch(/payments add up to/);
    expect(save().disabled).toBe(false);
  });
});
