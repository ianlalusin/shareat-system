// @vitest-environment happy-dom
/**
 * T-502 S12 - "Record expenses" on /ap/invoices/[id]: the payment Amount boxes must accept typing (1 Nov browser bug).
 *
 * ROOT CAUSE (InvoiceBatchRecord.tsx): a NATIVE `form.addEventListener('input', ...)` that called setState. A browser runs a
 * microtask checkpoint between listeners, so React re-rendered the parent (still holding the OLD payment rows) BEFORE its own root
 * handler saw the keystroke: the controlled Amount box was rewritten with its old value, onChange never fired, typing did nothing.
 * Script-dispatched events (jsdom, happy-dom, `dispatchEvent`) get no such checkpoint, so a plain render test cannot see it.
 * HONEST LIMIT: happy-dom + the vitest React (18.3) do NOT reproduce the browser ordering even with a synchronous queueMicrotask
 * (measured: the old code still passes test 1). So the REGRESSION GUARD is test 2 (source: no native input/change listener on the
 * batch form, React onInput instead); test 1 only pins that typing and adding a row work and never remount the rows. The real proof
 * was a real browser (1 Nov): at the form's bubble listener the Amount value had already reverted, and React's onChange never ran.
 * The pending-button rule (spec section 14 addendum) is test 3: the Save buttons are SubmitButton.
 * MUTANT: put `form.addEventListener('input', syncPaid)` back -> test 2 goes red (checked).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, ...rel.split('/')), 'utf8');
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const parts = [
  { key: 'c1', kind: 'category', categoryId: 'c1', label: 'Food', itemNames: ['Pork'], total: '180.00', left: '180.00' },
  { key: 'c2', kind: 'category', categoryId: 'c2', label: 'Gas', itemNames: ['LPG'], total: '50.00', left: '50.00' },
];

async function mount() {
  const { InvoiceBatchRecord } = await import('../src/components/expenses/InvoiceBatchRecord');
  const div = document.createElement('div');
  document.body.append(div);
  const root = createRoot(div);
  await act(async () => {
    root.render(
      h(InvoiceBatchRecord as never, {
        action: () => undefined, invoiceId: 'i', storeId: 's', supplierId: 'sup', supplierName: 'S', supplierCreditTermsDays: null,
        invoiceStatus: 'pending', view: { invoiceId: 'i', itemised: true, linesExceedTotal: false, parts },
        categories: [], moneyLines: { sources: [], staff: [] }, returnTo: '/x',
      }),
    );
  });
  await act(async () => { await tick(); });
  return { div, root };
}
const amount = (n: number) => document.querySelector(`input[name="lineAmount_${n}"]`) as HTMLInputElement | null;
async function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
  });
  await act(async () => { await tick(); });
}

describe('T-502 S12 batch record: payment amounts take typing', () => {
  it('a typed amount sticks and a second row can be typed into, with a microtask checkpoint after every listener (browser ordering)', async () => {
    const realQueueMicrotask = globalThis.queueMicrotask;
    const { root } = await mount();
    globalThis.queueMicrotask = (fn: VoidFunction) => fn(); // emulate: the browser drains microtasks after each native listener
    try {
      expect(amount(0)?.value).toBe('230.00');
      await type(amount(0)!, '200.00');
      expect(amount(0)!.value).toBe('200.00');
      const add = [...document.querySelectorAll('button')].find((b) => /add another/i.test(`${b.textContent} ${b.getAttribute('aria-label')} ${b.innerHTML}`));
      expect(add).toBeTruthy();
      await act(async () => { add!.click(); await tick(); });
      expect(amount(1)).toBeTruthy();
      await type(amount(1)!, '30.00');
      expect(amount(1)!.value).toBe('30.00');
      expect(amount(0)!.value).toBe('200.00');
    } finally {
      globalThis.queueMicrotask = realQueueMicrotask;
      await act(async () => root.unmount());
    }
  });

  it('the batch form follows its payment rows with React onInput, never a native input/change listener', () => {
        const batch = read('components/expenses/InvoiceBatchRecord.tsx');
    expect(batch).not.toMatch(/addEventListener\(\s*['"](input|change)['"]/);
    expect(batch).toMatch(/<form[^>]*onInput=\{syncPaid\}/);
  });

  it('every expense Save is a SubmitButton (disabled while the request is in flight)', () => {
    expect(read('components/expenses/InvoiceBatchRecord.tsx')).toMatch(/<SubmitButton[^>]*pendingLabel/);
    expect(read('app/expenses/new/page.tsx')).toMatch(/<SubmitButton[^>]*pendingLabel="Saving…">Save draft</);
    expect(read('app/ap/invoices/[id]/page.tsx')).toMatch(/<SubmitButton[^>]*pendingLabel="Saving…">\s*Record expense\s*<\/SubmitButton>/);
  });
});
