// @vitest-environment happy-dom
/**
 * T-534 S3 - "Wrong payment method" on a Receipts row, rendered for real in happy-dom (the t534-s2 pattern).
 * The button opens a dialog: which paid row, the new method, an amount (the whole row by default), a reference for a wallet, a reason, and a manager PIN unless the
 * signed-in person already approves. Offline: the button is off and says "This needs the internet." Each case names the mutant it kills.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { CorrectPayment, correctionEffectText, type PostCorrection } from '../src/app/pos/receipts/CorrectPayment';
import { PosContext } from '../src/app/pos/_shell/pos-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TENDERS = [{ id: 'cash-id', name: 'Cash', kind: 'cash' as const }, { id: 'gcash-id', name: 'GCash', kind: 'wallet' as const }];
const PAYMENTS = [{ paymentId: 'pay-1', tenderId: 'cash-id', tenderName: 'Cash', left: '1000.00' }];

let host: HTMLDivElement;
let root: Root;
let post: ReturnType<typeof vi.fn<PostCorrection>>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  post = vi.fn<PostCorrection>(async () => ({ ok: true }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(over: Record<string, unknown> = {}, online = true) {
  const el = createElement(CorrectPayment as never, { receiptId: 'rcpt-1', receiptNo: 'SL-01-000007', payments: PAYMENTS, tenders: TENDERS, canApprove: false, post, ...over } as never);
  await act(async () => {
    root.render(online ? el : createElement(PosContext.Provider, { value: { online: false } as never }, el));
  });
}
const buttons = () => Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
const button = (name: string) => buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
const click = async (el: Element | undefined) => {
  expect(el, 'element to click exists').toBeDefined();
  await act(async () => (el as HTMLElement).click());
};
const type = async (label: string, value: string) => {
  const input = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent ?? '').includes(label))?.querySelector('input') as HTMLInputElement | undefined;
  expect(input, `input "${label}"`).toBeDefined();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const pad = async (digits: string) => {
  for (const k of digits) await click(Array.from(document.querySelectorAll('[data-key]')).find((b) => b.getAttribute('data-key') === k));
};

describe('T-534 S3 - Wrong payment method (the Receipts row)', () => {
  it('offline the button is off and says "This needs the internet."; online it opens the dialog [kills: the button open offline]', async () => {
    await render({}, false);
    expect(button('Wrong payment method')!.disabled).toBe(true);
    expect(host.textContent).toContain('This needs the internet.');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({}, true);
    expect(button('Wrong payment method')!.disabled).toBe(false);
    expect(host.textContent).not.toContain('This needs the internet.');
  });

  it('a receipt with nothing left to move shows no button', async () => {
    await render({ payments: [{ ...PAYMENTS[0]!, left: '0.00' }] });
    expect(button('Wrong payment method')).toBeUndefined();
  });

  it('the amount defaults to the whole paid row; a wallet asks for a reference; Save stays off until method, reason, reference and PIN are in [kills: no reference/PIN gate]', async () => {
    await render();
    await click(button('Wrong payment method'));
    expect(document.body.textContent).toContain('up to 1,000.00');
    expect(document.body.textContent).not.toContain('Reference number');
    expect(button('Save correction')!.disabled).toBe(true);
    await click(button('GCash'));
    expect(document.body.textContent).toContain('Reference number');
    expect(document.body.textContent).toContain('Cash −1,000.00 · GCash +1,000.00');
    await type('Reason', 'Paid by GCash');
    expect(button('Save correction')!.disabled, 'no reference, no PIN yet').toBe(true);
    await type('Reference number', 'GC-0001234');
    expect(button('Save correction')!.disabled, 'no PIN yet').toBe(true);
    await type('Manager PIN', '123456');
    expect(button('Save correction')!.disabled).toBe(false);
  });

  it('a signed-in approver sees no PIN box; Save posts the body once with the same request id on a retry, and shows the server sentence when refused [kills: a new id per try]', async () => {
    post.mockResolvedValueOnce({ ok: false, error: 'Already in a closed day. Refund it and ring it again.' });
    await render({ canApprove: true });
    await click(button('Wrong payment method'));
    expect(document.body.textContent).not.toContain('Manager PIN');
    await click(button('GCash'));
    await click(button('Clear amount'));
    await pad('300');
    await type('Reference number', 'GC-0001234');
    await type('Reason', 'Paid by GCash');
    await click(button('Save correction'));
    expect(document.body.textContent).toContain('Already in a closed day. Refund it and ring it again.');
    await click(button('Save correction'));
    expect(post).toHaveBeenCalledTimes(2);
    const [first, second] = post.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({ receiptId: 'rcpt-1', paymentId: 'pay-1', toTenderId: 'gcash-id', amount: '300', referenceNo: 'GC-0001234', reason: 'Paid by GCash', pin: '' });
    expect(second!.requestId).toBe(first!.requestId);
  });

  it('the effect line is empty until there is a method and an amount', () => {
    expect(correctionEffectText('Cash', undefined, '100')).toBe('');
    expect(correctionEffectText('Cash', TENDERS[1], '')).toBe('');
    expect(correctionEffectText('Cash', TENDERS[1], '300')).toBe('Cash −300.00 · GCash +300.00');
  });
});
