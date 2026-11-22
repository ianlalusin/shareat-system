// @vitest-environment happy-dom
/**
 * T-627 - store charges on the Payment screen, rendered for real in happy-dom, and the pure bill / payload pieces behind it. docs/tasks/627-pos-charges.md.
 * The bill lists the charges with a Remove each and an Add charge button; Due, the balance and the change are against total + charges; the sale payload carries the
 * chargeTotal only when there is one; the receipt prints the charge and AMOUNT DUE; the sheet checks with the server's sentences and sends charge.added / charge.removed.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentPanel, type PaymentPanelProps } from '@/app/pos/_payment/PaymentPanel';
import { projectBill, toPriceCharges, toPriceLines, type BillChargeRow, type BillLineRow, type ProjectedBill } from '@/app/pos/_payment/bill';
import { buildSalePayload, checkCharge, CHARGE_SENTENCES, priceBill } from '@/app/pos/_payment/logic';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T_CASH = id(901);
const TENDERS = [{ id: T_CASH, name: 'Cash', kind: 'cash' }];
const RULES = { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 };
const line = (n: number, name: string, qty: number, unitPrice: string): BillLineRow => ({ lineId: id(n), name, kind: 'item', qty, bundleHeads: null, unitPrice, pending: false, discounts: [] });
const PORK = [line(11, 'Pork belly', 2, '250.00')]; // 500.00
const charge = (n: number, name: string, unitAmount: string, qty = 1, o: Partial<BillChargeRow> = {}): BillChargeRow => ({ id: id(n), presetId: null, name, unitAmount, qty, pending: false, ...o });
const bill = (charges: BillChargeRow[], l: BillLineRow[] = PORK): ProjectedBill => ({ lines: l, charges, problem: null, notices: [], needsExtraFor: [] });
const PRESETS = [{ id: id(51), name: 'Leftover', amount: '100.00', perUnit: true }, { id: id(52), name: 'Extra griller', amount: '150.00', perUnit: false }];

let host: HTMLDivElement;
let root: Root;
let sendEvent: ReturnType<typeof vi.fn>;
let enqueue: ReturnType<typeof vi.fn>;
let print: ReturnType<typeof vi.fn>;
let onPaid: ReturnType<typeof vi.fn>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
  sendEvent = vi.fn(async () => null);
  enqueue = vi.fn(async (e: unknown) => ({ seq: 1, ...(e as object) }));
  print = vi.fn(async () => 'printed' as const);
  onPaid = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const render = async (b: ProjectedBill, over: Partial<PaymentPanelProps> = {}) => {
  await act(async () => {
    root.render(
      createElement(PaymentPanel, {
        sessionId: id(31), label: 'Stand 3', heads: 2, isTakeOut: false, bill: b, presets: [], chargePresets: PRESETS, tenders: TENDERS, rules: RULES, vatRegistered: true, terminalNo: 1,
        storeName: 'Shareat Lipa', cashierName: 'Joy', personId: id(40), online: true, layout: { width: 58, font: 'normal' }, copies: 1,
        deps: { reserveTerminalSeq: vi.fn(async () => 7), newId: () => id(99), enqueue, requestDrain: vi.fn(), print }, sendEvent, newId: () => id(98), onBack: () => undefined, onPaid, ...over,
      } as PaymentPanelProps),
    );
  });
};
const button = (text: RegExp | string, within: ParentNode = document.body) =>
  [...within.querySelectorAll('button')].find((b) => (typeof text === 'string' ? (b.textContent ?? '').trim() === text : text.test(b.textContent ?? ''))) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined | null) => {
  expect(el, 'the control exists').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};

describe('T-627 bill math on the device (the same function as the server)', () => {
  it('Due is the goods plus the charges; the VAT block is the goods only', () => {
    const priced = priceBill({ lines: toPriceLines(PORK), charges: toPriceCharges([charge(1, 'Leftover', '100.00', 3), charge(2, 'Corkage', '50.00')]), rules: RULES, vatRegistered: true });
    expect(priced).toMatchObject({ total: '500.00', chargeTotal: '350.00', amountDue: '850.00' });
    expect(priced.vat.vatAmount).toBe('53.57'); // 500.00 x 12 / 112, unchanged by the charges
  });

  it('the sale payload carries chargeTotal only when there is a charge (a bill without one is the payload it always was)', () => {
    const base = { sessionId: id(31), receiptId: id(32), terminalNo: 1, terminalSeq: 7, now: new Date('2026-11-22T10:00:00Z'), online: true, rows: [{ tenderId: T_CASH, amount: '850.00' }], tenders: TENDERS, seniors: [] };
    const withCharge = buildSalePayload({ ...base, priced: priceBill({ lines: toPriceLines(PORK), charges: toPriceCharges([charge(1, 'Corkage', '50.00')]), rules: RULES, vatRegistered: true }) });
    expect((withCharge.device as Record<string, unknown>).chargeTotal).toBe('50.00');
    const without = buildSalePayload({ ...base, priced: priceBill({ lines: toPriceLines(PORK), rules: RULES, vatRegistered: true }) });
    expect(Object.keys(without.device as object)).not.toContain('chargeTotal');
  });

  it('the charge sheet checks with the server sentences: a name 1 to 40, an amount above 0, a whole quantity', () => {
    expect(checkCharge({ kind: 'custom', name: ' ', amount: '10' })).toBe(CHARGE_SENTENCES.name);
    expect(checkCharge({ kind: 'custom', name: 'x'.repeat(41), amount: '10' })).toBe(CHARGE_SENTENCES.name);
    expect(checkCharge({ kind: 'custom', name: 'Corkage', amount: '0' })).toBe(CHARGE_SENTENCES.amount);
    expect(checkCharge({ kind: 'custom', name: 'Corkage', amount: '10.555' })).toBe(CHARGE_SENTENCES.amount);
    expect(checkCharge({ kind: 'custom', name: 'Corkage', amount: '50' })).toBeNull();
    expect(checkCharge({ kind: 'preset', qty: 0 })).toBe(CHARGE_SENTENCES.qty);
    expect(checkCharge({ kind: 'preset', qty: 3 })).toBeNull();
  });
});

describe('T-627 projecting the charges of a table (server + outbox)', () => {
  const view = { sessionId: id(31), view: undefined, body: { session: { id: id(31), mode: 'dine_in', standId: null, status: 'open', headsCashier: 2, headsServer: null }, lines: [], charges: [{ id: id(61), presetId: null, name: 'Corkage', unitAmount: '50.00', qty: 1 }] }, menu: null, presets: [], chargePresets: PRESETS };
  const ev = (kind: 'charge.added' | 'charge.removed', payload: Record<string, unknown>) => ({ seq: 1, kind, personId: id(40), occurredAtDevice: '2026-11-22T10:00:00Z', payload }) as never;

  it('a pending add of a preset and a custom charge shows once, a pending remove takes a server charge off, and an add for another table is ignored', () => {
    const b = projectBill({
      ...view,
      pending: [
        ev('charge.added', { chargeId: id(62), sessionId: id(31), presetId: id(51), qty: 3, addedAtDevice: 'x' }),
        ev('charge.added', { chargeId: id(63), sessionId: id(31), name: 'Cake fee', unitAmount: '75.00', qty: 1, addedAtDevice: 'x' }),
        ev('charge.added', { chargeId: id(64), sessionId: id(77), presetId: id(52), qty: 1, addedAtDevice: 'x' }),
        ev('charge.added', { chargeId: id(61), sessionId: id(31), name: 'Corkage', unitAmount: '50.00', qty: 1, addedAtDevice: 'x' }), // the server already holds it
        ev('charge.removed', { chargeId: id(61), removedAtDevice: 'x' }),
      ],
    });
    expect((b.charges ?? []).map((c) => [c.name, c.unitAmount, c.qty, c.pending])).toEqual([['Leftover', '100.00', 3, true], ['Cake fee', '75.00', 1, true]]);
  });

  it('a pending preset this tablet does not hold stops the bill with a sentence (Pay stays off) instead of guessing an amount', () => {
    const b = projectBill({ ...view, chargePresets: [], pending: [ev('charge.added', { chargeId: id(62), sessionId: id(31), presetId: id(51), qty: 1, addedAtDevice: 'x' })] });
    expect(b.problem).toMatch(/charge on this table is not on this tablet yet/);
  });
});

describe('T-627 the Payment screen', () => {
  it('lists each charge with its amount, adds them to Due, and the Finish payload and the printed receipt carry them', async () => {
    await render(bill([charge(1, 'Leftover', '100.00', 3, { presetId: id(51) }), charge(2, 'Corkage', '50.00')]));
    const list = host.querySelector('ul[aria-label="Charges on this bill"]')!;
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('300.00'), expect.stringContaining('50.00')]));
    const totals = host.querySelector('[data-region="bill-totals"]')!.textContent!;
    expect(totals).toContain('Charges (after VAT)');
    expect(totals).toContain('+350.00');
    expect(totals).toContain('₱850.00'); // Due = 500.00 + 350.00
    // the cash row is filled with what is owed: the balance is against the amount due
    await click(button(/^Cash/, host.querySelector('[aria-label="Pay with"]')!));
    expect(host.querySelector('[data-amount]')!.textContent).toContain('850.00');
    // the customer hands over 1,000.00: the change is against the amount due (150.00), not against the goods
    const pad = host.querySelector('[aria-label="Amount keypad"]')!;
    for (const k of '1000') await click([...pad.querySelectorAll('button')].find((b) => b.textContent === k));
    expect(host.querySelector('[data-region="pay-footer"] [role="status"]')!.textContent).toContain('150.00');
    await click(button(/^Finish/));
    expect(enqueue).toHaveBeenCalledTimes(1);
    const sale = (enqueue.mock.calls[0]![0] as { kind: string; payload: { device: { total: string; chargeTotal: string }; payments: { amount: string }[] } });
    expect(sale.kind).toBe('sale.completed');
    expect(sale.payload.device).toMatchObject({ total: '500.00', chargeTotal: '350.00' });
    expect(sale.payload.payments[0]!.amount).toBe('1000.00');
    const printed = (print.mock.calls[0]![0] as string[]).join('\n');
    expect(printed).toMatch(/Leftover x3\s+300\.00/);
    expect(printed).toMatch(/AMOUNT DUE\s+850\.00/);
    expect(printed).toMatch(/CHANGE\s+150\.00/);
  });

  it('a bill without charges shows no Charges line in the totals and no AMOUNT DUE on the paper', async () => {
    await render(bill([]));
    expect(host.querySelector('[data-region="bill-totals"]')!.textContent).not.toContain('Charges (after VAT)');
    await click(button(/^Cash/, host.querySelector('[aria-label="Pay with"]')!));
    await click(button(/^Finish/));
    expect((print.mock.calls[0]![0] as string[]).join('\n')).not.toContain('AMOUNT DUE');
  });

  it('Remove on a charge sends charge.removed for that charge, with no PIN', async () => {
    await render(bill([charge(2, 'Corkage', '50.00')]));
    await click(host.querySelector('button[aria-label="Remove Corkage"]'));
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent.mock.calls[0]![0]).toMatchObject({ kind: 'charge.removed', personId: id(40), payload: { chargeId: id(2) } });
  });

  it('Add charge opens the sheet: a per-unit preset asks how many and sends charge.added with the preset id; a once-per-bill preset sends quantity 1; nothing is typed for a preset amount', async () => {
    await render(bill([]));
    await click(button('+ Add charge'));
    const dialog = document.querySelector('dialog')!;
    expect(dialog).toBeTruthy();
    await click(button(/Leftover/, dialog));
    expect(dialog.textContent).toContain('How many');
    await click(dialog.querySelector('button[aria-label="More"]'));
    await click(dialog.querySelector('button[aria-label="More"]'));
    expect(dialog.textContent).toContain('₱300.00'); // 3 x 100.00
    await click(button('Add charge', dialog));
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent.mock.calls[0]![0]).toMatchObject({ kind: 'charge.added', payload: { sessionId: id(31), presetId: id(51), qty: 3 } });
    expect(Object.keys((sendEvent.mock.calls[0]![0] as { payload: object }).payload)).not.toContain('unitAmount');
  });

  it('a custom charge needs a name and an amount, then sends its own name and a two-decimal amount, once', async () => {
    await render(bill([]));
    await click(button('+ Add charge'));
    const dialog = document.querySelector('dialog')!;
    await click(button('Custom charge', dialog));
    expect(button('Add charge', dialog)!.disabled, 'no name, no amount yet').toBe(true);
    const input = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Cake fee');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const pad = dialog.querySelector('[aria-label="Amount keypad"]')!;
    for (const k of '7' + '5') await click([...pad.querySelectorAll('button')].find((b) => b.textContent === k));
    await click(button('Add charge', dialog));
    expect(sendEvent.mock.calls[0]![0]).toMatchObject({ kind: 'charge.added', payload: { name: 'Cake fee', unitAmount: '75.00', qty: 1 } });
    expect(Object.keys((sendEvent.mock.calls[0]![0] as { payload: object }).payload)).not.toContain('presetId');
  });
});
