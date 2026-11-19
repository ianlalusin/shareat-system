// @vitest-environment happy-dom
/**
 * T-534 S4 - "Refund" on a Receipts row, rendered for real in happy-dom (the t534-s3 pattern): pick items and how many (the money of each comes from the server), the money back
 * defaults to the receipt's own paid rows (cash first) and can be changed within what each takes, a reason, a manager PIN unless the signed-in person approves. Offline the button is
 * off and says "This needs the internet." On success the slip prints once through the adapter. Each case names the mutant it kills.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { RefundReceipt, type PostRefund } from '../src/app/pos/receipts/RefundReceipt';
import { autoSplit, refundOrder, refundTotalCents, splitProblem } from '../src/app/pos/receipts/refund-logic';
import { PosContext } from '../src/app/pos/_shell/pos-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINES = [{ lineId: 'line-1', name: 'Pork belly', qty: 4, left: 4, amounts: ['250.00', '500.00', '750.00', '1000.00'] }];
// GCash is listed FIRST on purpose: the default split must still put cash first.
const PAYMENTS = [
  { paymentId: 'pay-g', tenderId: 'gcash-id', tenderName: 'GCash', kind: 'wallet' as const, left: '700.00' },
  { paymentId: 'pay-c', tenderId: 'cash-id', tenderName: 'Cash', kind: 'cash' as const, left: '300.00' },
];
const SLIP = {
  refundNo: 'SL-R-000001', receiptNo: 'SL-01-000007', recordedAt: '2026-11-20T04:30:00.000Z', reason: 'Customer returned it', total: '500.00',
  lines: [{ name: 'Pork belly', qty: 2, amount: '500.00' }], payments: [{ tenderName: 'Cash', amount: '300.00', referenceNo: null }, { tenderName: 'GCash', amount: '200.00', referenceNo: 'GC-0001234' }],
  approvedByName: 'Manny Manager', recordedByName: 'Cara Counter',
};

let host: HTMLDivElement;
let root: Root;
let post: ReturnType<typeof vi.fn<PostRefund>>;
let print: ReturnType<typeof vi.fn<(l: string[], o: { copies: number }) => Promise<'printed'>>>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  post = vi.fn<PostRefund>(async () => ({ ok: true, slip: SLIP }));
  print = vi.fn(async () => 'printed' as const);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(over: Record<string, unknown> = {}, online = true) {
  const el = createElement(RefundReceipt as never, {
    receiptId: 'rcpt-1', receiptNo: 'SL-01-000007', lines: LINES, payments: PAYMENTS, canApprove: false, slipContext: { storeName: 'Shareat Lipa', vatRegistered: true },
    layout: { width: 58, font: 'normal' }, post, print, ...over,
  } as never);
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
const setInput = async (input: HTMLInputElement | null | undefined, value: string) => {
  expect(input, 'input exists').toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const byLabel = (label: string) => Array.from(document.querySelectorAll('label')).find((l) => (l.textContent ?? '').includes(label))?.querySelector('input') as HTMLInputElement | undefined;
const moneyBack = (name: string) => document.querySelector(`input[aria-label="${name} money back"]`) as HTMLInputElement | null;

describe('T-534 S4 - Refund (the Receipts row)', () => {
  it('offline the button is off and says "This needs the internet."; online it opens the dialog [kills: the button open offline]', async () => {
    await render({}, false);
    expect(button('Refund')!.disabled).toBe(true);
    expect(host.textContent).toContain('This needs the internet.');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({}, true);
    expect(button('Refund')!.disabled).toBe(false);
    expect(host.textContent).not.toContain('This needs the internet.');
  });

  it('a receipt with nothing left to refund shows no button', async () => {
    await render({ lines: [{ ...LINES[0]!, left: 0, amounts: [] }] });
    expect(button('Refund')).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ payments: PAYMENTS.map((p) => ({ ...p, left: '0.00' })) });
    expect(button('Refund')).toBeUndefined();
  });

  it('picking 2 of 4 shows the SERVER\'s money for 2 (500.00), and the money back defaults to cash first: cash 300, GCash 200 [kills: first listed method first]', async () => {
    await render();
    await click(button('Refund'));
    expect(button('Refund 0.00')!.disabled).toBe(true);
    await click(button('One more Pork belly'));
    await click(button('One more Pork belly'));
    expect(document.body.textContent).toContain('Refund total 500.00');
    expect(moneyBack('Cash')!.value).toBe('300.00');
    expect(moneyBack('GCash')!.value).toBe('200.00');
    // the wallet row asks for the reference of the money sent back
    expect(document.body.textContent).toContain('Reference number of the money sent back');
  });

  it('Save stays off until reason, the wallet reference and the PIN are in; an over-cap split is flagged; changing the split is kept when the quantity changes [kills: no gate]', async () => {
    await render();
    await click(button('Refund'));
    await click(button('One more Pork belly'));
    await click(button('One more Pork belly'));
    expect(button('Refund 500.00')!.disabled).toBe(true);
    await setInput(byLabel('Reason'), 'Customer returned it');
    expect(button('Refund 500.00')!.disabled, 'no reference, no PIN yet').toBe(true);
    await setInput(byLabel('Reference number of the money sent back'), 'GC-0001234');
    expect(button('Refund 500.00')!.disabled, 'no PIN yet').toBe(true);
    await setInput(byLabel('Manager PIN'), '123456');
    expect(button('Refund 500.00')!.disabled).toBe(false);
    // cash cannot take more than its 300
    await setInput(moneyBack('Cash'), '400');
    expect(document.body.textContent).toContain('Cash can only take back ₱300.00.');
    expect(button('Refund 500.00')!.disabled).toBe(true);
    await setInput(moneyBack('Cash'), '100');
    expect(document.body.textContent).toContain('must equal the refund');
    await setInput(moneyBack('GCash'), '400');
    expect(button('Refund 500.00')!.disabled).toBe(false);
    await click(button('One more Pork belly')); // 3 units = 750: the hand-made split is kept, so it no longer adds up
    expect(button('Refund 750.00')!.disabled).toBe(true);
  });

  it('a signed-in approver sees no PIN box; Save posts the body, the same request id on a retry, shows the server sentence when refused, and prints ONE slip on success [kills: a new id per try, no print]', async () => {
    post.mockResolvedValueOnce({ ok: false, error: 'Only 1 of Pork belly can still be refunded.' });
    await render({ canApprove: true });
    await click(button('Refund'));
    expect(document.body.textContent).not.toContain('Manager PIN');
    await click(button('One more Pork belly'));
    await click(button('One more Pork belly'));
    await setInput(byLabel('Reason'), 'Customer returned it');
    await setInput(byLabel('Reference number of the money sent back'), 'GC-0001234');
    await click(button('Refund 500.00'));
    expect(document.body.textContent).toContain('Only 1 of Pork belly can still be refunded.');
    expect(print).not.toHaveBeenCalled();
    await click(button('Refund 500.00'));
    expect(post).toHaveBeenCalledTimes(2);
    const [first, second] = post.mock.calls.map((c) => c[0]);
    expect(first).toEqual({
      requestId: first!.requestId, receiptId: 'rcpt-1', lines: [{ receiptLineId: 'line-1', qty: 2 }],
      payments: [{ paymentId: 'pay-c', amount: '300.00', referenceNo: '' }, { paymentId: 'pay-g', amount: '200.00', referenceNo: 'GC-0001234' }], reason: 'Customer returned it', pin: '',
    });
    expect(second!.requestId).toBe(first!.requestId);
    expect(document.body.textContent).toContain('Refund SL-R-000001 saved.');
    expect(print).toHaveBeenCalledTimes(1);
    const [lines, opts] = print.mock.calls[0]!;
    expect(opts).toEqual({ copies: 1 });
    expect(lines.join('\n')).toContain('REFUND');
    expect(lines.join('\n')).toContain('SL-R-000001');
    expect(lines.join('\n')).toContain('SL-01-000007');
    expect(lines.join('\n')).toContain('Manny Manager');
  });
});

describe('T-534 S4 - the pure parts', () => {
  it('refundTotalCents adds the server\'s amounts for the picked quantities and ignores a quantity above what is left', () => {
    expect(refundTotalCents(LINES, { 'line-1': 2 })).toBe(50000n);
    expect(refundTotalCents(LINES, { 'line-1': 0 })).toBe(0n);
    expect(refundTotalCents(LINES, { 'line-1': 5 })).toBe(0n);
  });
  it('autoSplit fills cash first and then the others in order, each up to what it takes; paid rows with nothing left are skipped', () => {
    expect(refundOrder(PAYMENTS).map((p) => p.paymentId)).toEqual(['pay-c', 'pay-g']);
    expect(autoSplit(PAYMENTS, 50000n)).toEqual({ 'pay-c': 30000n, 'pay-g': 20000n });
    expect(autoSplit(PAYMENTS, 20000n)).toEqual({ 'pay-c': 20000n });
    expect(autoSplit([{ ...PAYMENTS[1]!, left: '0.00' }, PAYMENTS[0]!], 10000n)).toEqual({ 'pay-g': 10000n });
  });
  it('splitProblem: within the caps, adding up, a wallet row with a reference is fine; anything else is a sentence', () => {
    expect(splitProblem(PAYMENTS, { 'pay-c': '300.00', 'pay-g': '200.00' }, { 'pay-g': 'GC-0001234' }, 50000n)).toBeNull();
    expect(splitProblem(PAYMENTS, { 'pay-c': '300.00', 'pay-g': '200.00' }, {}, 50000n)).toContain('reference number');
    expect(splitProblem(PAYMENTS, { 'pay-c': '300.01', 'pay-g': '199.99' }, { 'pay-g': 'GC-0001234' }, 50000n)).toContain('Cash can only take back');
    expect(splitProblem(PAYMENTS, { 'pay-c': '100.00' }, {}, 50000n)).toContain('must equal');
  });
});
