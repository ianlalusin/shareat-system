// @vitest-environment happy-dom
/**
 * T-623 - "Wallet payments to check" on /pos/receipts, rendered for real in happy-dom (the t534-s3 pattern).
 * A person who holds the right sees the section with a Checked button per row and a light confirm; a cashier sees nothing; offline the buttons are off.
 * Each case names the mutant it kills.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
// The real action is a server action (imports the server session); the component takes `check` as a prop in tests.
vi.mock('../src/app/pos/receipts/actions', () => ({ checkWalletPaymentAction: vi.fn() }));

import { WalletChecksSection, confirmText, type CheckPayment } from '../src/app/pos/receipts/WalletChecks';
import { PosContext } from '../src/app/pos/_shell/pos-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAYMENTS = [
  { paymentId: 'pay-1', receiptNo: 'SL-01-000007', when: 'Nov 21, 2026, 2:14 pm', tenderName: 'GCash', amount: '450.00', referenceNo: '1234' },
  { paymentId: 'pay-2', receiptNo: 'SL-01-000008', when: 'Nov 20, 2026, 7:02 pm', tenderName: 'Maya', amount: '120.00', referenceNo: '99887' },
];

let host: HTMLDivElement;
let root: Root;
let check: ReturnType<typeof vi.fn<CheckPayment>>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  check = vi.fn<CheckPayment>(async () => ({ ok: true }));
  refresh.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(over: Record<string, unknown> = {}, online = true) {
  const el = createElement(WalletChecksSection as never, { canCheck: true, storeId: 'store-1', payments: PAYMENTS, check, ...over } as never);
  await act(async () => {
    root.render(online ? el : createElement(PosContext.Provider, { value: { online: false } as never }, el));
  });
}
const buttons = () => Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
const button = (name: string) => buttons().find((b) => (b.textContent ?? '').trim() === name);
const click = async (el: Element | undefined) => {
  expect(el, 'element to click exists').toBeDefined();
  await act(async () => (el as HTMLElement).click());
};

describe('T-623 - Wallet payments to check', () => {
  it('a manager sees the count, every row with its reference, and a Checked button per row [kills: no section / no button]', async () => {
    await render();
    expect(host.textContent).toContain('Wallet payments to check (2)');
    expect(host.textContent).toContain('SL-01-000007');
    expect(host.textContent).toContain('1234');
    expect(host.textContent).toContain('₱450.00');
    expect(buttons().filter((b) => (b.textContent ?? '').trim() === 'Checked')).toHaveLength(2);
  });

  it('a cashier gets nothing: no section, no button [kills: the section drawn without the right]', async () => {
    await render({ canCheck: false });
    expect(host.textContent).toBe('');
    expect(buttons()).toHaveLength(0);
  });

  it('Checked asks first, in plain words, and sends nothing until confirmed; confirming sends that payment and refreshes [kills: no confirm]', async () => {
    await render();
    await click(buttons().filter((b) => (b.textContent ?? '').trim() === 'Checked')[0]);
    expect(document.body.textContent).toContain('Mark ₱450.00 GCash ref 1234 as checked? You saw it arrive. This cannot be undone.');
    expect(check).not.toHaveBeenCalled();
    await click(button('Yes, mark as checked'));
    expect(check).toHaveBeenCalledWith({ storeId: 'store-1', paymentId: 'pay-1' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refusal's own sentence is shown and nothing refreshes", async () => {
    check.mockResolvedValueOnce({ ok: false, error: 'This payment was already checked by Ana at 2:14 pm.' });
    await render();
    await click(buttons().filter((b) => (b.textContent ?? '').trim() === 'Checked')[0]);
    await click(button('Yes, mark as checked'));
    expect(document.body.textContent).toContain('This payment was already checked by Ana at 2:14 pm.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('offline the buttons are off and the section says "Needs the internet." [kills: the buttons open offline]', async () => {
    await render({}, false);
    expect(host.textContent).toContain('Needs the internet.');
    const checked = buttons().filter((b) => (b.textContent ?? '').trim() === 'Checked');
    expect(checked).toHaveLength(2);
    expect(checked.every((b) => b.disabled)).toBe(true);
  });

  it('with nothing to check the heading says (0) and no row shows', async () => {
    await render({ payments: [] });
    expect(host.textContent).toContain('Wallet payments to check (0)');
    expect(button('Checked')).toBeUndefined();
  });

  it('confirmText reads the amount, the method and the reference', () => {
    expect(confirmText(PAYMENTS[1]!)).toBe('Mark ₱120.00 Maya ref 99887 as checked? You saw it arrive. This cannot be undone.');
  });
});
