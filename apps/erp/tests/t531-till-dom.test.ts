// @vitest-environment happy-dom
/**
 * T-531 R6 (TESTER) - the Till tab, rendered for real in happy-dom (the t528c pattern). docs/tasks/531-pos-day-close.md R6, R11, R8 "Screens".
 *
 * ASSUMED API (apps/erp/src/app/pos/_till/TillPanel.tsx, a client component; the page `app/pos/till/page.tsx` loads the data and renders it):
 *   TillPanel({ reading, history, online, isManager, layout, store: { name }, cashierName, tillCountsHref, deps })
 *     reading  = the xReading figures as JSON { receiptCount, grossTotal, subtotal, discountTotal, discounts: {senior,pwd,other}, byTender: { name, amount }[], toCheckCount, lateCount, spansTwoDates, ... }
 *     history  = [{ id, zNo, businessDate, grossTotal, tenders: { name, amount }[], v1Status: 'sent' | 'failed' | 'pending' | 'not_applicable', slip?: string[] }]
 *     deps     = { postClose(body: { closeId, approval: { employeeId, pin } }) -> { ok: true, dayCloseId, zNo, slip: string[] } | { ok: false, error },
 *                  postBacklog(body: { closeRunId, approval: { employeeId, pin } }) -> same shape, postResend(businessDate) -> { ok: true } | { ok: false, error },
 *                  print(lines: string[], { copies }) -> Promise<'printed' | ...>, newId() -> string }
 *   Accessible names: the buttons "Print X", "Close day (Z)", "Close day by day", "Resend", "Reprint", "Close day" (the confirm sheet's); the keypad fields are labelled
 *   "Employee ID" and "PIN"; the link reads "Till counts and handover".
 * Sentences (exact): "Closing the day needs the internet.", "This close would cover more than 2 days. Call a manager.", "Not yet sent to v1. Tap Resend.", "Spans two dates".
 *
 * RED NOW FOR THE RIGHT REASON: _till/TillPanel.tsx does not exist (the import fails; every case reports it).
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TILL_MODULE = '../src/app/pos/_till/TillPanel';
const PIN = '482915';
const RUN_ID = '00000000-0000-4000-8000-000000000031';
const READING = {
  receiptCount: 3, grossTotal: '2896.71', subtotal: '3075.00', discountTotal: '178.29', discounts: { senior: '128.29', pwd: '0.00', other: '50.00' },
  byTender: [{ name: 'Cash', amount: '2396.71' }, { name: 'GCash', amount: '500.00' }], toCheckCount: 1, lateCount: 1, spansTwoDates: false,
  unliSales: '2245.00', alaCarteSales: '830.00', heads: 5, packageSessions: 2, seniorPwdDiners: 1,
};
const SLIP = ['SHAREAT LIPA', 'Z-READING', 'Z NO:                     Z-0001', 'GROSS TOTAL             2,896.71'];
const HISTORY = [{ id: 'z1', zNo: 1, businessDate: '2026-11-02', grossTotal: '2896.71', tenders: [{ name: 'Cash', amount: '2396.71' }], v1Status: 'failed' }];

let host: HTMLDivElement;
let root: Root;
const deps = () => ({
  postClose: vi.fn(async (_b: unknown) => ({ ok: true as boolean, dayCloseId: 'z2', zNo: 2, slip: SLIP, error: '' })),
  postBacklog: vi.fn(async (_b: unknown) => ({ ok: true as boolean, dayCloseId: 'z2', zNo: 2, slip: SLIP, error: '' })),
  postResend: vi.fn(async (_d: string) => ({ ok: true as boolean })),
  print: vi.fn(async (_l: string[], _o: { copies: number }) => 'printed' as const),
  newId: () => RUN_ID,
});
let d: ReturnType<typeof deps>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  d = deps();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(over: Record<string, unknown> = {}) {
  let mod: { TillPanel?: unknown };
  try {
    mod = await import(/* @vite-ignore */ TILL_MODULE);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/_till/TillPanel.tsx cannot be loaded (T-531 not built): ${String((e as Error).message).slice(0, 100)}`);
  }
  if (typeof mod.TillPanel !== 'function') throw new Error('MISSING EXPORT: TillPanel (T-531 not built).');
  await act(async () => {
    root.render(
      createElement(mod.TillPanel as never, {
        reading: READING, history: HISTORY, online: true, isManager: false, layout: { width: 58, font: 'normal' }, store: { name: 'Shareat Lipa' }, cashierName: 'Cara Counter',
        tillCountsHref: '/till?storeId=lipa', deps: d, ...over,
      } as never),
    );
  });
}
const buttons = () => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[];
const button = (name: string) => buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
const click = async (el: Element | undefined) => {
  expect(el, 'element to click exists').toBeDefined();
  await act(async () => (el as HTMLElement).click());
};
const field = (label: string) =>
  (host.querySelector(`input[aria-label="${label}"]`) ?? (Array.from(host.querySelectorAll('label')).find((l) => l.textContent?.trim() === label) as HTMLLabelElement | undefined)?.control ?? null) as HTMLInputElement | null;
async function type(label: string, value: string) {
  const el = field(label);
  expect(el, `a field labelled ${label}`).not.toBeNull();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const NL = String.fromCharCode(10);

describe('the reading so far (R6 X-reading)', () => {
  it('shows receipts, gross, discounts by kind, tenders, the to-check count and the late count', async () => {
    await render();
    const text = host.textContent ?? '';
    for (const s of ['Reading so far', '2,896.71', '128.29', '50.00', 'Cash', '2,396.71', 'GCash', '500.00']) expect(text).toContain(s);
    expect(text).toMatch(/to check/i);
    expect(text).toMatch(/late/i);
    expect(text).not.toContain('Spans two dates');
  });
  it('says "Spans two dates" only when the window does', async () => {
    await render({ reading: { ...READING, spansTwoDates: true } });
    expect(host.textContent).toContain('Spans two dates');
  });
  it('Print X sends the X-READING lines to the printer once', async () => {
    await render();
    await click(button('Print X'));
    expect(d.print).toHaveBeenCalledTimes(1);
    const text = d.print.mock.calls[0]![0].join(NL);
    expect(text).toContain('X-READING');
    // 58 mm Font A is 32 columns, where the sentence wraps over two centred lines (the print test pins exactly that), so compare it with the line breaks folded.
    expect(text.replace(/\s+/g, ' ')).toContain('Reading so far - the day is NOT closed');
    expect(text).toContain('Cash control, not a BIR document');
  });
  it('a link "Till counts and handover" goes to the ERP till screen (row 319): no till UI of its own', async () => {
    await render();
    const a = Array.from(host.querySelectorAll('a')).find((x) => x.textContent?.trim() === 'Till counts and handover');
    expect(a?.getAttribute('href')).toBe('/till?storeId=lipa');
  });
});

describe('Close day (Z)', () => {
  it('offline: the button is disabled and the sentence is shown; online: enabled', async () => {
    await render({ online: false });
    expect(button('Close day (Z)')!.disabled).toBe(true);
    expect(host.textContent).toContain('Closing the day needs the internet.');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ online: true });
    expect(button('Close day (Z)')!.disabled).toBe(false);
    expect(host.textContent).not.toContain('Closing the day needs the internet.');
  });

  it('the confirm sheet shows the X figures and an Employee ID + PIN keypad; Close day posts { closeId, approval } once and prints the Z-slip, with Reprint', async () => {
    await render();
    await click(button('Close day (Z)'));
    expect(host.textContent).toContain('2,896.71');
    await type('Employee ID', 'SE-007');
    await type('PIN', PIN);
    await click(button('Close day'));
    expect(d.postClose).toHaveBeenCalledTimes(1);
    expect(d.postClose.mock.calls[0]![0]).toEqual({ closeId: RUN_ID, approval: { employeeId: 'SE-007', pin: PIN } });
    expect(d.print).toHaveBeenCalledTimes(1);
    expect(d.print.mock.calls[0]![0]).toEqual(SLIP);
    expect(host.textContent).toContain('Z-0001');
    await click(button('Reprint'));
    expect(d.print).toHaveBeenCalledTimes(2);
    expect(d.print.mock.calls[1]![0]).toEqual(SLIP);
  });

  it('the PIN is not left on the screen after the close: not in any input value, not in the text', async () => {
    await render();
    await click(button('Close day (Z)'));
    await type('Employee ID', 'SE-007');
    await type('PIN', PIN);
    await click(button('Close day'));
    expect(host.textContent).not.toContain(PIN);
    expect(Array.from(host.querySelectorAll('input')).map((i) => i.value)).not.toContain(PIN);
    expect(host.innerHTML).not.toContain(PIN);
  });

  it('a refusal is shown in its own sentence and nothing is printed', async () => {
    d.postClose.mockResolvedValueOnce({ ok: false, error: 'There are no sales to close since the last Z.' } as never);
    await render();
    await click(button('Close day (Z)'));
    await type('Employee ID', 'SE-007');
    await type('PIN', PIN);
    await click(button('Close day'));
    expect(host.textContent).toContain('There are no sales to close since the last Z.');
    expect(d.print).not.toHaveBeenCalled();
  });
});

describe('R11 - more than 2 days: Close day by day', () => {
  const REFUSAL = 'This close would cover more than 2 days. Call a manager.';
  const tooMany = () => d.postClose.mockResolvedValueOnce({ ok: false, error: REFUSAL } as never);

  it('the refusal sentence is shown with a "Close day by day" button that only a manager can use (disabled for a cashier)', async () => {
    tooMany();
    await render({ isManager: false });
    await click(button('Close day (Z)'));
    await type('Employee ID', 'SE-007');
    await type('PIN', PIN);
    await click(button('Close day'));
    expect(host.textContent).toContain(REFUSAL);
    expect(button('Close day by day'), 'the button is there').toBeDefined();
    expect(button('Close day by day')!.disabled).toBe(true);
  });

  it('a manager can use it: it posts { closeRunId, approval } to postBacklog, not to postClose again', async () => {
    tooMany();
    await render({ isManager: true });
    await click(button('Close day (Z)'));
    await type('Employee ID', 'SE-009');
    await type('PIN', PIN);
    await click(button('Close day'));
    expect(button('Close day by day')!.disabled).toBe(false);
    await click(button('Close day by day'));
    await type('Employee ID', 'SE-009');
    await type('PIN', PIN);
    await click(button('Close day'));
    expect(d.postBacklog).toHaveBeenCalledTimes(1);
    expect(d.postBacklog.mock.calls[0]![0]).toMatchObject({ approval: { employeeId: 'SE-009', pin: PIN } });
    expect(typeof (d.postBacklog.mock.calls[0]![0] as { closeRunId: string }).closeRunId).toBe('string');
    expect(d.postClose).toHaveBeenCalledTimes(1);
  });
});

describe('History and Resend', () => {
  it('lists the Z (number, business date, gross) and says "Not yet sent to v1. Tap Resend." for a failed send; Resend is offered to a manager only', async () => {
    await render({ isManager: false });
    const text = host.textContent ?? '';
    for (const s of ['Z-0001', '2026-11-02', '2,896.71', 'Not yet sent to v1. Tap Resend.']) expect(text).toContain(s);
    expect(button('Resend')?.disabled ?? true).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ isManager: true });
    expect(button('Resend')!.disabled).toBe(false);
    await click(button('Resend'));
    expect(d.postResend).toHaveBeenCalledWith('2026-11-02');
  });

  it('a sent Z shows no "Not yet sent" line', async () => {
    await render({ history: [{ ...HISTORY[0]!, v1Status: 'sent' }] });
    expect(host.textContent).not.toContain('Not yet sent to v1');
  });

  it('Reprint of a past Z prints that Z\'s slip again', async () => {
    await render({ history: [{ ...HISTORY[0]!, v1Status: 'sent', slip: SLIP }] });
    await click(button('Reprint'));
    expect(d.print).toHaveBeenCalledTimes(1);
    expect(d.print.mock.calls[0]![0].join(NL)).toContain('Z-READING');
  });
});
