// @vitest-environment happy-dom
/**
 * T-528d P0 (BUILDER, tests first) - the receipt screen after Finish must outlive the paid table.
 * The render found it vanished about 0.5 s after Finish when online: the Payment view lived only while the paying table was in the open list, so when the
 * paid sale drained and the poll dropped the table, the panel (and the receipt dialog inside it) unmounted before the cashier could press Reprint or Done.
 * Here the REAL Orders container is driven through Pay -> Cash -> Finish, then the poll removes the session: the receipt stays, Reprint prints again, Done returns to the grid.
 */
import { createElement, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, MENU, SNAPSHOT, id, PERSON } from './helpers/t527-menu';

const h = vi.hoisted(() => ({ printed: [] as string[][], enqueued: [] as unknown[] }));
vi.mock('next/link', () => ({ default: ({ href, children, ...r }: { href: string; children: ReactNode }) => createElement('a', { href, ...r }, children) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/pos', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock('@/lib/pos-device', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  reserveTerminalSeq: async () => 1,
  enqueue: async (e: unknown) => {
    h.enqueued.push(e);
    return { seq: h.enqueued.length, ...(e as object) };
  },
}));
vi.mock('@/lib/pos-print/adapter', () => ({
  printLines: async (lines: string[]) => {
    h.printed.push(lines);
    return 'printed';
  },
  printerMode: () => 'browser',
}));

import { Orders } from '@/app/pos/_orders/Orders';
import { PosContext, type PosContextValue } from '@/app/pos/_shell/pos-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = id(600);
const T = '2026-11-07T09:00:00.000Z';
const STAND = { sessionId: A, standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 2, headsServer: 2, openedAtDevice: T };
const T_CASH = id(901);
const BODY = {
  session: { id: A, mode: 'dine_in', standId: IDS.stand5, status: 'open', headsCashier: 2, headsServer: 2 },
  lines: [{ id: id(700), kind: 'item', name: 'Plain rice', qty: 2, unitPrice: '40.00', kitchenStatus: 'sent', bundleHeads: null, menuItemId: IDS.plain, discounts: [] }],
};
const PAYMENT = {
  store: { storeId: id(1), name: 'Shareat Lipa', terminalNo: 1, vatRegistered: false },
  tenders: [{ id: T_CASH, name: 'Cash', kind: 'cash' }],
  discountPresets: [],
  rules: { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 },
  staff: [],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  h.printed = [];
  h.enqueued = [];
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => BODY }));
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = () => undefined;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const ctx = (open: boolean, version: number): PosContextValue =>
  ({
    storeId: 's1', paired: true, personId: PERSON, offlineActorPersonId: null, online: true, openStands: open ? [STAND] : [], stateVersion: version, pendingEvents: [],
    ordersSnapshot: { stands: SNAPSHOT.stands, menu: MENU, payment: PAYMENT }, bodiesRef: { current: {} }, requestDrain: () => undefined, setResultsHandler: () => undefined,
  }) as unknown as PosContextValue;
const render = (open: boolean, version: number) => act(async () => root.render(createElement(PosContext.Provider, { value: ctx(open, version) }, createElement(Orders))));
const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));
const button = (text: RegExp | string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find((b) => (typeof text === 'string' ? (b.textContent ?? '').trim() === text : text.test(b.textContent ?? ''))) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined | null) => {
  expect(el, 'the control exists').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const receipt = () => host.querySelector('[aria-label="Receipt"]') as HTMLElement | null;

describe('T-528d P0: the receipt stays after the paid table leaves the open list', () => {
  const payAndFinish = async () => {
    await render(true, 1);
    await flush();
    await flush();
    await click(host.querySelector('button[aria-pressed]'));
    await click(button('Pay'));
    expect(host.textContent, 'the Payment screen is up').toContain('Bill · Stand 5');
    await click([...host.querySelectorAll('[aria-label="Pay with"] button')].find((b) => /^Cash/.test(b.textContent ?? '')));
    await click(button(/^Finish/));
  };

  it('Finish shows the receipt screen, and it is still there after the poll drops the session', async () => {
    await payAndFinish();
    expect(h.enqueued).toHaveLength(1);
    expect(receipt(), 'the receipt screen is up right after Finish').toBeTruthy();
    expect(receipt()!.textContent).toContain('T1-000001');
    await render(false, 2); // the paid sale drained; the poll no longer lists the table
    await flush();
    expect(receipt(), 'the receipt survives the table leaving the list').toBeTruthy();
    expect(button('Reprint')).toBeTruthy();
    expect(button('Done')).toBeTruthy();
  });

  it('Reprint after the table is gone prints the same receipt again, marked REPRINT, and sells nothing', async () => {
    await payAndFinish();
    await render(false, 2);
    await flush();
    expect(h.printed).toHaveLength(1);
    await click(button('Reprint'));
    expect(h.printed).toHaveLength(2);
    expect(h.printed[1]!.some((l) => l.includes('REPRINT'))).toBe(true);
    expect(h.printed[1]!.map((l) => l.trim()).filter((l) => l !== 'REPRINT'), 'the same lines, plus the REPRINT flag').toEqual(h.printed[0]!.map((l) => l.trim()));
    expect(h.enqueued, 'a reprint never sells again').toHaveLength(1);
    expect(receipt(), 'the screen stays up after a reprint').toBeTruthy();
  });

  it('Done closes the receipt and returns to the grid', async () => {
    await payAndFinish();
    await render(false, 2);
    await flush();
    await click(button('Done'));
    expect(receipt()).toBeNull();
    expect(host.textContent).toContain('Open orders');
    expect(host.textContent).not.toContain('Bill · Stand 5');
  });

  it('control: before Finish there is no receipt screen, and the Payment screen is showing', async () => {
    await render(true, 1);
    await flush();
    await flush();
    await click(host.querySelector('button[aria-pressed]'));
    await click(button('Pay'));
    expect(receipt()).toBeNull();
    expect(host.textContent).toContain('Bill · Stand 5');
  });
});
