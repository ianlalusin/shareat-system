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
    expect(button(/^Finish/)!.disabled).toBe(true);
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

  describe('after Finish: an on-screen receipt with Reprint and Done', () => {
    const pay = async () => {
      await render();
      await fillSenior();
      await click(tender('Cash'));
      await keys('2100');
      await click(button(/^Finish/));
    };
    const shown = () => host.querySelector('[aria-label="Receipt"]') as HTMLElement | null;

    it('shows the same lines that were printed, in monospace, and waits for Done (the sale is already saved)', async () => {
      await pay();
      expect(d.enqueue).toHaveBeenCalledTimes(1);
      const printed = d.print.mock.calls[0]![0];
      const view = shown()!;
      expect(view, 'a receipt view').toBeTruthy();
      expect(view.tagName).toBe('PRE');
      expect(view.textContent).toBe(printed.join('\n'));
      expect(view.textContent).toContain('T1-004231');
      expect(tokens(view)).toContain('font-mono');
      expect(onPaid, 'the panel stays until Done').not.toHaveBeenCalled();
      expect(button('Reprint')).toBeTruthy();
      expect(button('Done')).toBeTruthy();
    });

    it('Reprint prints the lines again marked REPRINT and leaves the screen up', async () => {
      await pay();
      await click(button('Reprint'));
      expect(d.print).toHaveBeenCalledTimes(2);
      expect(d.print.mock.calls[1]![0].some((l: string) => l.includes('REPRINT'))).toBe(true);
      expect(d.enqueue, 'a reprint never sells again').toHaveBeenCalledTimes(1);
      expect(onPaid).not.toHaveBeenCalled();
    });

    it('Done hands the receipt back and returns to Orders, once', async () => {
      await pay();
      await click(button('Done'));
      expect(onPaid).toHaveBeenCalledTimes(1);
      expect(onPaid.mock.calls[0]![0]).toMatchObject({ receiptNo: 'T1-004231', print: 'printed', notice: null });
    });

    it('a failed print says so on the receipt view and a good Reprint clears it', async () => {
      d.print.mockResolvedValueOnce('failed' as never);
      await pay();
      expect(host.textContent).toContain('Receipt did not print. Tap Reprint.');
      await click(button('Reprint'));
      expect(host.textContent).not.toContain('Receipt did not print. Tap Reprint.');
    });

    it('Finish tapped twice in the same moment saves exactly one sale (one number reserved, one enqueue, one print)', async () => {
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
    });

    it('Done tapped twice in the same moment hands the receipt back exactly once', async () => {
      await pay();
      const done = button('Done')!;
      await act(async () => {
        done.click();
        done.click();
      });
      expect(onPaid).toHaveBeenCalledTimes(1);
    });

    it('the receipt dialog opens with focus on Done, not on the close X', async () => {
      await pay();
      expect(document.activeElement).toBe(button('Done'));
    });

    it('control: before Finish there is no receipt view', async () => {
      await render();
      expect(shown()).toBeNull();
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
