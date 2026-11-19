// @vitest-environment happy-dom
/**
 * T-534 S2 - the Convert section of the Till tab, rendered for real in happy-dom (the t531 pattern).
 * "Convert (GCash cash-in / cash-out)" opens a dialog: From (the money that leaves), To (the money that comes in), an amount tapped on the keypad, an optional note.
 * Offline: the button is off and says "This needs the internet." Today's open Converts are listed with Void where the server says this person may.
 * Each case names the mutant it kills.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TillPanel } from '../src/app/pos/_till/TillPanel';
import { convertEffectText } from '../src/app/pos/_till/ConvertSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQ = '00000000-0000-4000-8000-000000000534';
const READING = {
  receiptCount: 3, grossTotal: '2896.71', subtotal: '3075.00', discountTotal: '178.29', discounts: { senior: '128.29', pwd: '0.00', other: '50.00' },
  byTender: [{ name: 'Cash', amount: '2396.71' }, { name: 'GCash', amount: '500.00' }], toCheckCount: 0, lateCount: 0, spansTwoDates: false,
  unliSales: '2245.00', alaCarteSales: '830.00', heads: 5, packageSessions: 2, seniorPwdDiners: 1,
};
const TENDERS = [{ id: 'cash-id', name: 'Cash', kind: 'cash' as const }, { id: 'gcash-id', name: 'GCash', kind: 'wallet' as const }];
const ROWS = [
  { id: 'c1', fromName: 'Cash', toName: 'GCash', amount: '500.00', note: 'took cash', voided: false, canVoid: true },
  { id: 'c2', fromName: 'GCash', toName: 'Cash', amount: '200.00', note: null, voided: true, canVoid: false },
  { id: 'c3', fromName: 'GCash', toName: 'Cash', amount: '75.00', note: null, voided: false, canVoid: false },
];

let host: HTMLDivElement;
let root: Root;
const mkDeps = () => ({
  postClose: vi.fn(async () => ({ ok: true })),
  postBacklog: vi.fn(async () => ({ ok: true })),
  postResend: vi.fn(async () => ({ ok: true })),
  print: vi.fn(async () => 'printed' as const),
  newId: () => REQ,
  postConvert: vi.fn(async (_b: unknown) => ({ ok: true as boolean, error: '' })),
  postVoidConvert: vi.fn(async (_id: string) => ({ ok: true as boolean, error: '' })),
  refresh: vi.fn(),
});
let d: ReturnType<typeof mkDeps>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  d = mkDeps();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(over: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      createElement(TillPanel as never, {
        reading: READING, history: [], online: true, isManager: false, layout: { width: 58, font: 'normal' }, store: { name: 'Shareat Lipa' }, cashierName: 'Cara Counter',
        tillCountsHref: '/till?storeId=lipa', tenders: TENDERS, conversions: ROWS, deps: d, ...over,
      } as never),
    );
  });
}
const buttons = () => Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
const button = (name: string) => buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
const click = async (el: Element | undefined) => {
  expect(el, 'element to click exists').toBeDefined();
  await act(async () => (el as HTMLElement).click());
};
const pad = async (digits: string) => {
  for (const k of digits) await click(Array.from(document.querySelectorAll('[data-key]')).find((b) => b.getAttribute('data-key') === k));
};
const CONVERT = 'Convert (GCash cash-in / cash-out)';
/** The two tender buttons inside the From (or To) group of the open dialog. */
const choice = (group: 'From' | 'To', name: string) =>
  Array.from(Array.from(document.querySelectorAll('[role="group"]')).find((g) => g.getAttribute('aria-label') === group)?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === name);

describe('the Convert section', () => {
  it('online: the button is on and the open Converts are listed, the voided one struck through, Void only where the server allows [kills: Void on every row]', async () => {
    await render();
    expect(button(CONVERT)!.disabled).toBe(false);
    const text = host.textContent ?? '';
    for (const s of ['Cash → GCash · 500.00', 'took cash', 'GCash → Cash · 200.00', '(voided)', 'GCash → Cash · 75.00']) expect(text).toContain(s);
    expect(buttons().filter((b) => b.textContent?.trim() === 'Void').length).toBe(1);
    expect(host.querySelector('.line-through')?.textContent).toContain('200.00');
  });

  it('offline: the button is off and the sentence is "This needs the internet." and Void is off too [kills: a Convert attempt with no internet]', async () => {
    await render({ online: false });
    expect(button(CONVERT)!.disabled).toBe(true);
    expect(host.textContent).toContain('This needs the internet.');
    expect(button('Void')!.disabled).toBe(true);
  });

  it('From then To then a tapped amount then Save sends one request with the dialog\'s request id, From = the money that leaves [kills: From and To swapped]', async () => {
    await render();
    await click(button(CONVERT));
    expect(button('Save Convert')!.disabled).toBe(true);
    await click(choice('From', 'Cash'));
    await click(choice('To', 'GCash'));
    await pad('500');
    expect(document.body.textContent).toContain('Cash −500.00 · GCash +500.00');
    await click(button('Save Convert'));
    expect(d.postConvert).toHaveBeenCalledTimes(1);
    expect(d.postConvert.mock.calls[0]![0]).toEqual({ requestId: REQ, fromTenderId: 'cash-id', toTenderId: 'gcash-id', amount: '500', note: '' });
    expect(d.refresh).toHaveBeenCalled();
    expect(host.textContent).toContain('Convert saved.');
  });

  it('the same method on both sides cannot be saved, and a server refusal is shown in words [kills: saving from = to; a swallowed refusal]', async () => {
    await render();
    await click(button(CONVERT));
    await click(choice('From', 'Cash'));
    await click(choice('To', 'Cash'));
    await pad('10');
    expect(button('Save Convert')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('Pick two different payment methods.');
    await click(choice('To', 'GCash'));
    d.postConvert.mockResolvedValueOnce({ ok: false, error: 'That payment method is not available at this store.' });
    await click(button('Save Convert'));
    expect(document.body.textContent).toContain('That payment method is not available at this store.');
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('Void sends the Convert id and refreshes [kills: voiding the wrong row]', async () => {
    await render();
    await click(button('Void'));
    expect(d.postVoidConvert).toHaveBeenCalledWith('c1');
    expect(d.refresh).toHaveBeenCalled();
  });

  it('the reading shows Convert cash in / out only when something was converted [kills: a Convert block on every reading]', async () => {
    await render();
    expect(host.textContent).not.toContain('Convert: cash in');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ reading: { ...READING, convert: { cashIn: '200.00', cashOut: '500.00', net: '-300.00', count: 2 } } });
    expect(host.textContent).toContain('Convert: cash in');
    expect(host.textContent).toContain('200.00');
    expect(host.textContent).toContain('Convert: cash out');
  });
});

describe('convertEffectText', () => {
  it('names the two sides, From minus and To plus, and says nothing until there is an amount', () => {
    const [cash, gcash] = TENDERS;
    expect(convertEffectText(cash, gcash, '500')).toBe('Cash −500.00 · GCash +500.00');
    expect(convertEffectText(gcash, cash, '12.5')).toBe('GCash −12.50 · Cash +12.50');
    expect(convertEffectText(cash, gcash, '')).toBe('');
    expect(convertEffectText(cash, undefined, '5')).toBe('');
  });
});
