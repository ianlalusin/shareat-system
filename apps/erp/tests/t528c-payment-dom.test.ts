// @vitest-environment happy-dom
/**
 * T-528c (BUILDER, tests first) - the fixes a render of the Payment screen found. docs/tasks/528-pos-payment-screen.md + the render critique.
 * Rendered for real in happy-dom (no layout engine, so "fits one screen" is proven by STRUCTURE: which element scrolls and which is pinned).
 *   P1-1  one screen: the right column is a fixed-height column; only the payment rows scroll; the Change line and Finish are a pinned footer; the bill scrolls on its own.
 *   P1-2  the reason Pay is blocked is a button right above Finish, body size, warning tone; tapping it moves focus to the field that needs fixing.
 *   P1-3  the on-screen bill shows "Less: SC/PWD discount".
 *   P2    peso formatting in rows, a labelled reference field, Split prepares exactly one row, an icon Remove that never wraps the label, an on-screen receipt.
 * Markers (data-region): bill-scroll, bill-totals, payments-scroll, pay-footer.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentPanel, type PaymentPanelProps } from '@/app/pos/_payment/PaymentPanel';
import type { BillLineRow, ProjectedBill } from '@/app/pos/_payment/bill';
import { ReceiptScreen } from '@/app/pos/_payment/ReceiptScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T_CASH = id(901);
const T_GCASH = id(902);
const TENDERS = [
  { id: T_CASH, name: 'Cash', kind: 'cash' },
  { id: T_GCASH, name: 'GCash', kind: 'wallet' },
];
const disc = (n: number, o: Partial<BillLineRow['discounts'][number]> = {}): BillLineRow['discounts'][number] => ({
  id: id(n), kind: 'senior', valueType: 'percent', value: '0', qty: 1, dinerNo: 1, presetId: null, pending: false, removable: true, label: 'Senior', ...o,
});
/** The payment.png bill: 2,264.00 less 171.58 = 2,092.42, a senior (diner 1) on the package and on one corn. */
const lines = (over: { rice?: Partial<BillLineRow['discounts'][number]> } = {}): BillLineRow[] => [
  { lineId: id(11), name: 'Unli Samgyup + Cheese', kind: 'package', qty: 4, bundleHeads: null, unitPrice: '449.00', pending: false, discounts: [disc(21)] },
  { lineId: id(12), name: 'Iced tea pitcher', kind: 'item', qty: 1, bundleHeads: null, unitPrice: '120.00', pending: false, discounts: [] },
  { lineId: id(13), name: 'Cheese corn', kind: 'item', qty: 2, bundleHeads: null, unitPrice: '99.00', pending: false, discounts: [disc(22)] },
  { lineId: id(14), name: 'Kimchi fried rice', kind: 'item', qty: 1, bundleHeads: null, unitPrice: '150.00', pending: false, discounts: [disc(23, { kind: 'preset', value: '10', dinerNo: null, label: 'Promo 10%', ...over.rice })] },
];
const bill = (l: BillLineRow[] = lines()): ProjectedBill => ({ lines: l, problem: null, notices: [], needsExtraFor: [] });
const noSenior = (): BillLineRow[] => lines().map((l) => ({ ...l, discounts: l.discounts.filter((x) => x.kind !== 'senior') }));

let host: HTMLDivElement;
let root: Root;
let scrollSpy: ReturnType<typeof vi.fn>;
const deps = () => ({
  reserveTerminalSeq: vi.fn(async () => 4231),
  newId: () => id(99),
  enqueue: vi.fn(async (e: unknown) => ({ seq: 1, ...(e as object) })),
  requestDrain: vi.fn(),
  print: vi.fn(async (_l: string[], _o: { copies: number }) => 'printed' as const),
});
let d: ReturnType<typeof deps>;
let onPaid: ReturnType<typeof vi.fn>;
let sendEvent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  scrollSpy = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy;
  d = deps();
  onPaid = vi.fn();
  sendEvent = vi.fn(async () => null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = async (l: BillLineRow[] = lines(), over: Partial<PaymentPanelProps> = {}) => {
  await act(async () => {
    root.render(
      createElement(PaymentPanel, {
        sessionId: id(31), label: 'Stand 7', heads: 4, isTakeOut: false, bill: bill(l), presets: [], tenders: TENDERS,
        rules: { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 }, vatRegistered: true, terminalNo: 1, storeName: 'Shareat Lipa', cashierName: 'Joy', personId: id(40),
        online: true, layout: { width: 58, font: 'normal' }, deps: d, sendEvent, newId: () => id(98), onBack: () => undefined, onPaid, ...over,
      } as PaymentPanelProps),
    );
  });
};

const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const scrolls = (el: Element) => tokens(el).some((t) => t.endsWith('overflow-y-auto') || t.endsWith('overflow-auto'));
const region = (name: string) => host.querySelector(`[data-region="${name}"]`) as HTMLElement | null;
const button = (text: RegExp | string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find((b) => (typeof text === 'string' ? (b.textContent ?? '').trim() === text : text.test(b.textContent ?? ''))) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined | null) => {
  expect(el, 'the control exists').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const tender = (name: string) => button(new RegExp(`^${name}`), host.querySelector('[aria-label="Pay with"]')!);
const keys = async (s: string) => {
  const pad = host.querySelector('[aria-label="Amount keypad"]')!;
  for (const k of s) await click([...pad.querySelectorAll('button')].find((b) => b.textContent === k));
};
const type = async (label: string, value: string) => {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  expect(input, label).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const rows = () => [...host.querySelectorAll('ul[aria-label="Payments"] > li')];
const amountOf = (li: Element) => li.querySelector('[data-amount]')!.textContent!;
const status = () => region('pay-footer')!.querySelector('[role="status"]')!.textContent ?? '';
const fillSenior = async () => {
  await type('Name for Senior #1', 'Lolita R.');
  await type('ID number for Senior #1', 'OSCA 04-1187');
};

describe('P1-1: the whole payment fits one screen', () => {
  it('the panel is a fixed-height two-column layout: its own height at lg and up, no growth with the content', async () => {
    await render();
    const section = host.querySelector('section')!;
    expect(tokens(section).some((t) => /^lg:h-\[/.test(t)), 'a height at lg').toBe(true);
    expect(tokens(section)).toContain('lg:overflow-hidden');
  });

  it('the Change/Balance line and the Finish button live in a pinned footer that is not inside any scrolling element', async () => {
    await render();
    const footer = region('pay-footer')!;
    expect(footer, 'a pay-footer region').toBeTruthy();
    expect(status()).toMatch(/Balance|Change/);
    expect(button(/^Finish/, footer), 'Finish is in the footer').toBeTruthy();
    const section = host.querySelector('section')!;
    for (let el: Element | null = footer; el && el !== section; el = el.parentElement) expect(scrolls(el), `${el.tagName} must not scroll`).toBe(false);
  });

  it('only the payment rows scroll on the right: the scroll region holds the rows and nothing pinned', async () => {
    await render();
    const scroller = region('payments-scroll')!;
    expect(scroller, 'a payments-scroll region').toBeTruthy();
    expect(scrolls(scroller)).toBe(true);
    expect(scroller.querySelector('ul[aria-label="Payments"]')).toBeTruthy();
    expect(button(/^Finish/, scroller), 'Finish is not in the scroll region').toBeUndefined();
    expect(scroller.querySelector('[aria-label="Amount keypad"]'), 'the keypad is not in the scroll region').toBeNull();
    expect(scroller.querySelector('[aria-label="Pay with"]'), 'the tender buttons are not in the scroll region').toBeNull();
    expect(scroller.contains(region('pay-footer')!)).toBe(false);
  });

  it('the bill scrolls independently of the payments, and its Due total stays pinned below it', async () => {
    await render();
    const billScroll = region('bill-scroll')!;
    const payScroll = region('payments-scroll')!;
    expect(billScroll && scrolls(billScroll)).toBe(true);
    expect(billScroll.contains(payScroll) || payScroll.contains(billScroll)).toBe(false);
    expect(billScroll.querySelector('ul[aria-label="Bill lines"]')).toBeTruthy();
    const totals = region('bill-totals')!;
    expect(totals.textContent).toMatch(/Due/);
    expect(billScroll.contains(totals), 'the totals are pinned, not inside the scrolling lines').toBe(false);
  });

  it('control: with 12 payment rows the footer is still outside the scroll region', async () => {
    await render(noSenior());
    for (let i = 0; i < 12; i++) await click(tender('Cash'));
    expect(rows()).toHaveLength(12);
    expect(region('payments-scroll')!.contains(button(/^Finish/)!)).toBe(false);
    expect(region('pay-footer')!.contains(button(/^Finish/)!)).toBe(true);
  });
});

describe('P1-2: why Pay is blocked sits right above Pay and takes you to the field', () => {
  const reason = () => button(/Add the name and ID for Senior #1/, region('pay-footer')!);

  it('the reason is a body-size, warning-tone button in the footer, directly before the Finish button', async () => {
    await render();
    const r = reason();
    expect(r, 'a button with the blocker sentence').toBeTruthy();
    const finish = button(/^Finish/)!;
    expect(r!.compareDocumentPosition(finish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tokens(r!)).toContain('text-base');
    expect(tokens(r!).some((t) => /warning/.test(t))).toBe(true);
    expect(tokens(r!).some((t) => t === 'text-xs' || t === 'text-sm')).toBe(false);
  });

  it('tapping it moves focus to the Senior #1 name input and scrolls it into view', async () => {
    await render();
    await click(reason());
    const name = host.querySelector('input[aria-label="Name for Senior #1"]')!;
    expect(document.activeElement).toBe(name);
    expect(scrollSpy.mock.contexts).toContain(name);
  });

  it('with the name typed, it names the ID and focuses the ID input', async () => {
    await render();
    await type('Name for Senior #1', 'Lolita R.');
    await click(reason());
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="ID number for Senior #1"]'));
  });

  it('with the card details in, the next reason is the payment and tapping it focuses the first way to pay', async () => {
    await render();
    await fillSenior();
    const r = button(/Add a payment/, region('pay-footer')!);
    expect(r).toBeTruthy();
    await click(r);
    expect(document.activeElement).toBe(tender('Cash'));
  });

  it('a wallet row with no reference: the reason focuses that reference input', async () => {
    await render();
    await fillSenior();
    await click(tender('GCash'));
    const r = [...region('pay-footer')!.querySelectorAll('button')].find((b) => /reference/i.test(b.textContent ?? ''));
    expect(r, 'the reference sentence is the reason').toBeTruthy();
    await click(r);
    expect(document.activeElement).toBe(host.querySelector('ul[aria-label="Payments"] input'));
  });

  it('control: nothing blocks Pay, so there is no reason button and Finish is enabled', async () => {
    await render();
    await fillSenior();
    await click(tender('Cash'));
    const footer = region('pay-footer')!;
    expect([...footer.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter((t) => !/^Finish/.test(t))).toEqual([]);
    expect(button(/^Finish/, footer)!.disabled).toBe(false);
  });
});

describe('P2: peso formatting, the reference label, Split, Remove, the receipt', () => {
  it('every payment-row amount is a peso figure with a thousands comma: ₱1,600.00, never ₱1600', async () => {
    await render();
    await fillSenior();
    await click(tender('Cash'));
    expect(amountOf(rows()[0]!)).toBe('₱2,092.42');
    await keys('1600');
    expect(amountOf(rows()[0]!), 'while typing').toBe('₱1,600');
    await click(button(/Split: add another payment/));
    await click(tender('GCash'));
    expect(rows()).toHaveLength(2);
    const all = rows().map(amountOf);
    expect(all).toEqual(['₱1,600.00', '₱492.42']);
    for (const a of all) expect(a).not.toMatch(/₱\d{4,}/);
  });

  it('Due, Balance and Change use the same peso format', async () => {
    await render();
    await fillSenior();
    expect(host.querySelector('[data-region="bill-totals"]')!.textContent).toContain('₱2,092.42');
    expect(status()).toContain('₱2,092.42');
    await click(tender('Cash'));
    await keys('2100');
    expect(status()).toContain('₱7.58');
    await keys('0');
    expect(status(), 'a big change is still grouped').toContain('₱18,907.58');
  });

  it('the wallet reference input has a visible "Reference no." label tied to its input, inside its own payment row', async () => {
    await render();
    await click(tender('GCash'));
    const li = rows()[0]!;
    const input = li.querySelector('input')!;
    expect(input.id, 'the input has an id').toBeTruthy();
    const label = li.querySelector(`label[for="${input.id}"]`)!;
    expect(label, 'a <label for> inside the same row').toBeTruthy();
    expect(label.textContent!.trim()).toBe('Reference no.');
    expect(tokens(label)).not.toContain('sr-only');
  });

  it('Split then a tender makes exactly ONE row: Split prepares an empty row with the balance and the tender fills it', async () => {
    await render(noSenior());
    await click(button(/Split: add another payment/));
    expect(rows()).toHaveLength(1);
    expect(amountOf(rows()[0]!)).toBe('₱2,249.00');
    expect(rows()[0]!.textContent, 'no tender chosen yet').not.toMatch(/Cash|GCash/);
    await click(tender('GCash'));
    expect(rows(), 'choosing the tender fills the prepared row, it adds none').toHaveLength(1);
    expect(rows()[0]!.textContent).toContain('GCash');
    expect(rows()[0]!.querySelector('input'), 'a wallet row now asks for its reference').toBeTruthy();
    expect(amountOf(rows()[0]!)).toBe('₱2,249.00');
  });

  it('Split cannot be tapped twice: while a prepared row waits for its tender the button is off, and Pay says why', async () => {
    await render(noSenior());
    await click(tender('Cash'));
    await keys('500');
    await click(button(/Split: add another payment/));
    expect(rows()).toHaveLength(2);
    expect(button(/Split: add another payment/)!.disabled).toBe(true);
    expect(region('pay-footer')!.textContent).toMatch(/Pick a way to pay/);
    expect(([...region('pay-footer')!.querySelectorAll('button')].pop() as HTMLButtonElement).disabled, 'the last footer button is Finish').toBe(true);
    await click(tender('Cash'));
    expect(rows()).toHaveLength(2);
    await keys('100');
    expect(button(/Split: add another payment/)!.disabled, 'with the row filled and a balance left, Split can prepare the next one').toBe(false);
  });

  it('control: a tender tapped with no prepared row still adds one row, as before', async () => {
    await render(noSenior());
    await click(tender('Cash'));
    await click(tender('GCash'));
    expect(rows()).toHaveLength(2);
  });

  it('Remove on a discount is an icon button (aria-label "Remove <label>", 48 px) and the long label truncates instead of wrapping', async () => {
    const long = 'Custom ₱12.50 off the whole birthday celebration set menu';
    await render(lines({ rice: { label: long } }));
    const remove = host.querySelector(`button[aria-label="Remove ${long}"]`) as HTMLButtonElement;
    expect(remove, 'aria-label is "Remove <label>"').toBeTruthy();
    expect((remove.textContent ?? '').trim(), 'an icon, no word that can wrap').toBe('');
    expect(remove.querySelector('svg')).toBeTruthy();
    expect(tokens(remove)).toContain('min-h-12');
    expect(tokens(remove)).toContain('min-w-12');
    const labelEl = [...host.querySelectorAll('li *')].find((e) => e.children.length === 0 && e.textContent === long)!;
    expect(labelEl, 'the label is a leaf element').toBeTruthy();
    expect(tokens(labelEl)).toContain('truncate');
    await click(remove);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent.mock.calls[0]![0]).toMatchObject({ kind: 'discount.removed', payload: { discountId: id(23) } });
  });

  describe('after Finish (T-528d): the panel hands the saved sale to Orders at once; Orders owns the receipt screen', () => {
    const pay = async () => {
      await render();
      await fillSenior();
      await click(tender('Cash'));
      await keys('2100');
      await click(button(/^Finish/));
    };

    it('onPaid fires once with the receipt number, the print outcome, the view, the layout and the printed lines; the panel draws no receipt dialog of its own', async () => {
      await pay();
      expect(d.enqueue).toHaveBeenCalledTimes(1);
      expect(onPaid).toHaveBeenCalledTimes(1);
      const done = onPaid.mock.calls[0]![0];
      expect(done).toMatchObject({ receiptNo: 'T1-004231', print: 'printed', notice: null, layout: { width: 58, font: 'normal' } });
      expect(done.lines).toEqual(d.print.mock.calls[0]![0]);
      expect(done.view.receiptNo).toBe('T1-004231');
      expect(host.querySelector('[aria-label="Receipt"]'), 'the receipt screen is Orders\' now, so it outlives this panel').toBeNull();
    });

    it('Finish tapped twice in the same moment saves exactly one sale (one number reserved, one enqueue, one print, one hand-back)', async () => {
      await render();
      await fillSenior();
      await click(tender('Cash'));
      await keys('2100');
      const finish = button(/^Finish/)!;
      await act(async () => {
        finish.click();
        finish.click();
      });
      expect(d.reserveTerminalSeq).toHaveBeenCalledTimes(1);
      expect(d.enqueue).toHaveBeenCalledTimes(1);
      expect(d.print).toHaveBeenCalledTimes(1);
      expect(onPaid).toHaveBeenCalledTimes(1);
    });

    it('a print that failed travels in the hand-back as the notice', async () => {
      d.print.mockResolvedValueOnce('failed' as never);
      await pay();
      expect(onPaid.mock.calls[0]![0]).toMatchObject({ print: 'failed', notice: 'Receipt did not print. Tap Reprint.' });
    });

    it('control: a refused save hands nothing back and Finish can be tried again', async () => {
      d.enqueue.mockRejectedValueOnce(new Error('IndexedDB full') as never);
      await pay();
      expect(onPaid).not.toHaveBeenCalled();
      expect(host.textContent).toContain('This tablet could not save the sale. Nothing was charged. Try again.');
      await click(button(/^Finish/));
      expect(onPaid).toHaveBeenCalledTimes(1);
    });
  });
});

describe('P1-3: the on-screen bill adds up', () => {
  it('shows "Less: SC/PWD discount" after VAT-exempt, with the statutory 20% amounts only (97.86), and still shows VAT removed (58.72)', async () => {
    await render();
    const text = host.textContent ?? '';
    const at = (s: string) => text.indexOf(s);
    expect(at('VAT-exempt')).toBeGreaterThan(-1);
    expect(at('Less: SC/PWD discount')).toBeGreaterThan(at('VAT-exempt'));
    expect(text).toMatch(/Less: SC\/PWD discount\s*[−-]?97\.86/);
    expect(text).toMatch(/VAT removed for SC\/PWD\s*58\.72/);
  });

  it('control: a bill with no senior/PWD shows no such line', async () => {
    await render(noSenior());
    expect(host.textContent).not.toContain('Less: SC/PWD discount');
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// T-528d: the receipt screen (its own component, hosted by Orders), the rebalanced one-screen layout, Split's focus, the Finish label, the scroll position
// ---------------------------------------------------------------------------------------------------------------------

describe('T-528d: the receipt screen', () => {
  const show = async (over: Partial<Parameters<typeof ReceiptScreen>[0]> = {}) => {
    const onReprint = vi.fn();
    const onDone = vi.fn();
    await act(async () => {
      root.render(createElement(ReceiptScreen, { lines: ['SHAREAT LIPA', 'RECEIPT:  T1-000001'], receiptNo: 'T1-000001', notice: null, onReprint, onDone, ...over }));
    });
    return { onReprint, onDone };
  };
  const view = () => host.querySelector('[aria-label="Receipt"]') as HTMLElement | null;

  it('shows the printed lines in monospace, with Reprint and Done', async () => {
    await show();
    expect(view()!.tagName).toBe('PRE');
    expect(view()!.textContent).toBe('SHAREAT LIPA\nRECEIPT:  T1-000001');
    expect(tokens(view()!)).toContain('font-mono');
    expect(button('Reprint')).toBeTruthy();
    expect(button('Done')).toBeTruthy();
  });

  it('opens with focus on Done, not on the close X', async () => {
    await show();
    expect(document.activeElement).toBe(button('Done'));
  });

  it('Reprint and Done each report one tap; a failed print is shown as the notice', async () => {
    const { onReprint, onDone } = await show({ notice: 'Receipt did not print. Tap Reprint.' });
    expect(host.textContent).toContain('Receipt did not print. Tap Reprint.');
    await click(button('Reprint'));
    expect(onReprint).toHaveBeenCalledTimes(1);
    await click(button('Done'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('T-528d P1: the rebalanced one-screen layout (structure; happy-dom has no layout engine)', () => {
  it('the amount pad is two rows tall (seven columns), every key at least 3rem, Del and Clear included', async () => {
    await render();
    const pad = host.querySelector('[aria-label="Amount keypad"]')!;
    expect(tokens(pad)).toContain('grid-cols-7');
    const keysEls = [...pad.querySelectorAll('button')];
    expect(keysEls.map((b) => b.textContent)).toEqual(expect.arrayContaining(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'Del', 'Clear']));
    const cells = keysEls.reduce((n, b) => n + (tokens(b).includes('col-span-2') ? 2 : 1), 0);
    expect(cells / 7, 'rows = cells / columns').toBe(2);
    for (const b of keysEls) expect(tokens(b).includes('min-h-12') && tokens(b).includes('min-w-12'), b.textContent ?? '').toBe(true);
  });

  it('the bill header is ONE row (title, Discount every line, Back) and each bill line is tight: py-1, not py-2', async () => {
    await render();
    const back = button('Back')!;
    const all = button(/Discount every line/)!;
    expect(back.parentElement, 'Back, the discount-all button and the title share one row').toBe(all.parentElement);
    expect(back.parentElement!.parentElement!.querySelector('h2'), 'the title is on the same row').toBeTruthy();
    const li = host.querySelector('ul[aria-label="Bill lines"] > li')!;
    expect(tokens(li)).toContain('py-1');
    expect(tokens(li)).not.toContain('py-2');
  });

  it('a payment row is one 3rem line with a dashed divider, not a padded card; the wallet reference sits on the same row as its label', async () => {
    await render();
    await click(tender('GCash'));
    const li = rows()[0]!;
    expect(tokens(li)).not.toContain('p-2');
    expect(tokens(li)).toContain('border-dashed');
    const input = li.querySelector('input')!;
    const label = li.querySelector(`label[for="${input.id}"]`)!;
    expect(label.parentElement, 'label and input share one flex row').toBe(input.parentElement);
    expect(tokens(label.parentElement!)).toContain('flex');
  });

  it('the pinned footer is compact: the Finish button is 3.5rem (min-h-14), the change line has no tall padding', async () => {
    await render();
    const finish = button(/^Finish/)!;
    expect(tokens(finish)).toContain('min-h-14');
    expect(tokens(region('pay-footer')!.querySelector('[role="status"]')!)).toContain('py-1.5');
  });

  it('the panel measures itself again when what is above it changes size (a resize observer, fonts) and trims any page overflow', async () => {
    const seen: string[] = [];
    const RO = globalThis.ResizeObserver;
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(_cb: unknown) {
        seen.push('created');
      }
      observe() {
        seen.push('observe');
      }
      disconnect() {
        seen.push('disconnect');
      }
      unobserve() {}
    };
    try {
      await render();
      expect(seen).toContain('observe');
      await act(async () => root.unmount());
      expect(seen).toContain('disconnect');
      root = createRoot(host);
    } finally {
      (globalThis as { ResizeObserver: unknown }).ResizeObserver = RO;
    }
  });
});

describe('T-528d P1: Split brings its row into view and puts focus on the tender choice', () => {
  it('after Split the new row scrolls into view inside the payments box and focus is on the first tender button', async () => {
    await render(noSenior());
    await click(tender('Cash'));
    await keys('500');
    await click(button(/Split: add another payment/));
    const fresh = rows()[1]!;
    expect(scrollSpy.mock.contexts, 'the new row was scrolled into view').toContain(fresh);
    expect(document.activeElement).toBe(tender('Cash'));
  });

  it('control: choosing a tender with no Split does not scroll a row or steal focus from the tender button', async () => {
    await render(noSenior());
    scrollSpy.mockClear();
    await click(tender('Cash'));
    expect(scrollSpy.mock.contexts.filter((c) => (c as Element).tagName === 'LI')).toEqual([]);
  });
});

describe('T-528d P2: the Finish label while a row has no tender', () => {
  it('says "Pick a way to pay", never "TENDER", and Finish is off', async () => {
    await render(noSenior());
    await click(tender('GCash'));
    await keys('500');
    await click(button(/Split: add another payment/));
    const finish = button(/^Finish|Pick a way to pay/, region('pay-footer')!)!;
    expect(finish.textContent).toBe('Pick a way to pay');
    expect(finish.textContent).not.toMatch(/TENDER/i);
    expect(finish.disabled).toBe(true);
  });

  it('control: once the row has its tender the label is Finish with the tenders again', async () => {
    await render(noSenior());
    await click(tender('GCash'));
    await keys('500');
    await click(button(/Split: add another payment/));
    await click(tender('Cash'));
    expect(button(/^Finish/)!.textContent).toMatch(/^Finish · GCASH ₱[\d,.]+ \+ CASH ₱[\d,.]+ · print$/);
  });
});

describe('T-528d P2: scroll positions and the clipped label', () => {
  it('the bill box opens scrolled to the top, whatever the browser remembers', async () => {
    await render();
    expect(region('bill-scroll')!.scrollTop).toBe(0);
    expect(tokens(region('bill-scroll')!).some((t) => t.includes('overflow-anchor'))).toBe(true);
  });

  it('the wallet reference input leaves room above it when focused (scroll margin), so its label is never cut off', async () => {
    await render();
    await click(tender('GCash'));
    const input = rows()[0]!.querySelector('input')!;
    expect(tokens(input).some((t) => /^scroll-mt-/.test(t))).toBe(true);
    expect(tokens(region('payments-scroll')!).some((t) => /^scroll-pt-|^pt-/.test(t))).toBe(true);
  });

  it('opening a reference field scrolls the whole payment row into view', async () => {
    await render();
    await click(tender('GCash'));
    scrollSpy.mockClear();
    const input = rows()[0]!.querySelector('input') as HTMLInputElement;
    await act(async () => input.focus());
    expect(scrollSpy.mock.contexts).toContain(rows()[0]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// T-528e (the second render): bill room, a fixed reason slot, scroll reset on load, the receipt's last lines, one selected style
// ---------------------------------------------------------------------------------------------------------------------
describe('T-528e: the bill gets the room', () => {
  it('the lines region is the flexible one (flex-1 min-h-0) and the VAT block is no longer inside it', async () => {
    await render();
    const scroller = region('bill-scroll')!;
    expect(tokens(scroller)).toContain('flex-1');
    expect(tokens(scroller)).toContain('min-h-0');
    expect(scroller.querySelector('[aria-label="VAT breakdown"]'), 'the VAT block does not use the lines room').toBeNull();
  });

  it('on screen the VAT breakdown is a one-line "VAT details" disclosure under Due, closed by default, holding the full block', async () => {
    await render();
    const totals = region('bill-totals')!;
    const details = totals.querySelector('details')!;
    expect(details, 'a disclosure in the pinned totals').toBeTruthy();
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.querySelector('summary')!.textContent!.trim()).toBe('VAT details');
    const due = [...totals.querySelectorAll('p')].find((x) => /^Due/.test(x.textContent ?? ''))!;
    expect(due.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING, 'under Due').toBeTruthy();
    for (const word of ['VATable', 'VAT (12%)', 'VAT-exempt', 'Less: SC/PWD discount', 'VAT removed for SC/PWD']) expect(details.textContent, word).toContain(word);
    expect(tokens(details.querySelector('summary')!)).toContain('min-h-12');
  });

  it('control: the printed receipt still carries the full VAT block (the disclosure is screen only)', async () => {
    await render();
    await fillSenior();
    await click(tender('Cash'));
    await click(button(/^Finish/));
    const printed = onPaid.mock.calls[0]![0].lines as string[];
    for (const word of ['VATABLE SALES', 'VAT-EXEMPT SALES', 'Less: SC/PWD discount', 'VAT (12%)']) expect(printed.some((l) => l.includes(word)), word).toBe(true);
  });
});

describe('T-528e: the reason line has a fixed slot', () => {
  const slot = () => region('pay-footer')!.querySelector('[data-region="pay-reason-slot"]') as HTMLElement | null;

  it('the slot is always there at the same height class, with the reason in it when blocked and empty when not', async () => {
    await render();
    const blocked = slot()!;
    expect(blocked, 'a slot while blocked').toBeTruthy();
    expect(tokens(blocked)).toContain('min-h-12');
    expect(blocked.textContent).toMatch(/Add the name and ID for Senior #1/);
    const blockedClass = blocked.getAttribute('class');
    await fillSenior();
    await click(tender('Cash'));
    const clear = slot()!;
    expect(clear, 'the slot is still there when nothing blocks Pay').toBeTruthy();
    expect(clear.getAttribute('class'), 'the same classes, so nothing moves').toBe(blockedClass);
    expect(clear.textContent).toBe('');
    expect(clear.children).toHaveLength(0);
  });

  it('the slot sits between the change line and Finish', async () => {
    await render();
    const status = region('pay-footer')!.querySelector('[role="status"]')!;
    const finish = button(/^Finish/)!;
    expect(status.compareDocumentPosition(slot()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot()!.compareDocumentPosition(finish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('T-528e: the bill box resets to the top when the session or its lines first load', () => {
  const spyScrollTop = () => {
    const writes: { el: Element; v: number }[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const saved = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set(this: Element, v: number) {
        writes.push({ el: this, v });
      },
    });
    const restore = () => {
      if (saved) Object.defineProperty(proto, 'scrollTop', saved);
      else delete proto.scrollTop;
    };
    return { writes, restore };
  };

  it('scrollTop = 0 is written on mount and again when the lines arrive (not only on mount); overflow-anchor is off on the scroller at every width', async () => {
    const { writes, restore } = spyScrollTop();
    try {
      await render([]);
      const scroller = region('bill-scroll')!;
      const onMount = writes.filter((w) => w.el === scroller && w.v === 0).length;
      expect(onMount).toBeGreaterThanOrEqual(1);
      await render(lines());
      expect(writes.filter((w) => w.el === scroller && w.v === 0).length, 'written again when the lines load').toBeGreaterThan(onMount);
      const afterLoad = writes.length;
      await render(lines()); // an ordinary re-render does not yank the cashier back to the top
      expect(writes.length).toBe(afterLoad);
      expect(tokens(scroller).some((t) => t.includes('overflow-anchor:none'))).toBe(true);
      expect(tokens(scroller).some((t) => t.startsWith('lg:') && t.includes('overflow-anchor'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('a different table loading resets it too', async () => {
    const { writes, restore } = spyScrollTop();
    try {
      await render(lines(), { sessionId: id(31) });
      const n = writes.length;
      await render(lines(), { sessionId: id(32) });
      expect(writes.length).toBeGreaterThan(n);
    } finally {
      restore();
    }
  });
});

describe('T-528e: the receipt screen keeps its last lines clear of its scrollbar', () => {
  it('the receipt text has bottom padding and a right gutter, so no line sits under a scrollbar', async () => {
    await act(async () => {
      root.render(createElement(ReceiptScreen, { lines: ['a', 'b'], receiptNo: 'T1-000001', notice: null, onReprint: () => undefined, onDone: () => undefined }));
    });
    const pre = host.querySelector('[aria-label="Receipt"]')!;
    expect(tokens(pre).some((t) => /^pb-(4|5|6|8)$/.test(t))).toBe(true);
    expect(tokens(pre).some((t) => /^pr-(2|3|4)$/.test(t))).toBe(true);
  });
});

describe('T-528e: one selected style, with the kit focus ring as the only outline', () => {
  it('the chosen tender and the active payment row use a fill, not a coloured border that fights the focus ring', async () => {
    await render(noSenior());
    await click(tender('Cash'));
    const chosenTender = tender('Cash')!;
    const row = host.querySelector('ul[aria-label="Payments"] button[aria-pressed="true"]')!;
    for (const el of [chosenTender, row]) {
      expect(tokens(el), el.textContent ?? '').toContain('bg-warning-soft');
      expect(tokens(el).some((t) => t === 'border-brand' || t === 'border-ink')).toBe(false);
      expect(tokens(el)).toContain('focus-visible:ring-2');
      expect(tokens(el)).toContain('focus-visible:ring-ink');
    }
  });

  it('control: an idle tender has the plain surface style', async () => {
    await render(noSenior());
    await click(tender('Cash'));
    expect(tokens(tender('GCash')!)).toContain('bg-surface');
    expect(tokens(tender('GCash')!)).not.toContain('bg-warning-soft');
  });
});

describe('T-528e: the Payment panel leaves exactly the room below it that the page puts there (no page scroll)', () => {
  it('--pay-h takes off the bottom padding of EVERY box around the panel, not one rem (the page ran 16px over at 1280x800)', async () => {
    host.style.paddingBottom = '16px'; // stands in for the page wrapper (.erp-page py-4)
    document.body.style.paddingBottom = '16px'; // stands in for <main> pb-4
    try {
      await render();
      const panel = host.querySelector('section[aria-label^="Payment"]') as HTMLElement;
      expect(panel.style.getPropertyValue('--pay-h')).toBe(`${window.innerHeight - 32}px`);
    } finally {
      document.body.style.paddingBottom = '';
    }
  });
});

describe('T-528e: the on-screen receipt uses the narrow, tall dialog size', () => {
  it('ReceiptScreen opens the dialog at size "receipt" and keeps Reprint and Done in the pinned footer', async () => {
    await act(async () => {
      root.render(createElement(ReceiptScreen, { lines: ['a', 'b'], receiptNo: 'T1-000001', notice: null, onReprint: () => undefined, onDone: () => undefined }));
    });
    const dialog = host.querySelector('dialog')!;
    expect(dialog.getAttribute('data-size')).toBe('receipt');
    const footer = dialog.querySelector('.erp-dialog-footer')!;
    expect(button('Reprint', footer)).toBeTruthy();
    expect(button('Done', footer)).toBeTruthy();
    expect(footer.closest('.erp-dialog-body'), 'the footer is outside the scrolling body').toBeNull();
  });

  it('the stylesheet gives "receipt" its own width, a half-rem screen margin and a snug body, and no other size changed', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'apps', 'erp', 'src', 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/\.erp-dialog\[data-size="receipt"\]\s*\{[^}]*--erp-dialog-width:\s*26rem;[^}]*max-height:\s*calc\(100dvh - 1rem\)/);
    expect(css).toMatch(/\.erp-dialog\[data-size="receipt"\] \.erp-dialog-body\s*\{\s*padding-block:\s*0\.5rem/);
    for (const [size, width] of [['sm', '28rem'], ['lg', '64rem'], ['xl', '80rem']]) expect(css).toContain(`.erp-dialog[data-size="${size}"] { --erp-dialog-width: ${width}; }`);
  });
});
