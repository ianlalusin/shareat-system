// @vitest-environment happy-dom
/**
 * T-527 audit fixes 2, 3 and 6, rendered for real in happy-dom (this file only):
 *   2. the picker hides packages on take-out, including when ADDING to a take-out table (the dialog's own wiring);
 *   3. a refusal is told by the SHELL, on any tab, with the Orders tab not mounted;
 *   6. the real `Orders` container with no pairing draws no write control (not only OrdersView).
 */
import { createElement, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, MENU, SNAPSHOT, id, PERSON } from './helpers/t527-menu';

const h = vi.hoisted(() => ({
  handler: null as null | ((sent: unknown[], results: unknown[]) => void),
  pending: [] as unknown[],
  body: null as unknown,
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...r }: { href: string; children: ReactNode }) => createElement('a', { href, ...r }, children) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/pos', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock('@/app/sign-in/actions', () => ({ signOutAction: vi.fn() }));
vi.mock('@/app/pos/_shell/use-pos-state', () => ({ usePosState: () => ({ body: h.body, failures: 0, online: true }) }));
vi.mock('@/app/pos/_shell/use-device-sync', () => {
  const setResultsHandler = (fn: ((sent: unknown[], results: unknown[]) => void) | null) => {
    h.handler = fn;
  };
  return {
    useDeviceSync: () => ({
      offlineActor: null, setOfflineActor: () => undefined, pending: 0, sending: false, conflicts: 0, clearConflicts: () => undefined, needsInternet: false, unpaired: false,
      pendingEvents: h.pending, ordersSnapshot: null, requestDrain: () => undefined, setResultsHandler,
    }),
  };
});
vi.mock('@/app/pos/_shell/SwitchCashierDialog', () => ({ SwitchCashierDialog: () => null }));

import { OrderDialog } from '@/app/pos/_orders/OrderDialogs';
import { Orders } from '@/app/pos/_orders/Orders';
import { PosContext, type PosContextValue } from '@/app/pos/_shell/pos-context';
import { PosShell } from '@/app/pos/_shell/PosShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = id(600);
const T = '2026-11-07T09:00:00.000Z';
const STAND = { sessionId: A, standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 2, headsServer: null, openedAtDevice: T };
const WRITE_CONTROLS = /Seat a party|Take-out|Add items|Cancel|Fewer heads|More heads|Pay/;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  h.handler = null;
  h.pending = [];
  h.body = null;
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('audit 2 - the picker on take-out', () => {
  const noop = async () => null;
  const html = (mode: Parameters<typeof OrderDialog>[0]['mode']) =>
    renderToStaticMarkup(createElement(OrderDialog, { mode, menu: MENU, stands: SNAPSHOT.stands, tiles: [], onClose: () => undefined, onSend: noop }));

  it('seating a dine-in party and adding to a dine-in table show the package; take-out and adding to a take-out table do not', () => {
    expect(html({ kind: 'seat' })).toContain('Unli Grill');
    expect(html({ kind: 'add', sessionId: A, label: 'Stand 5', heads: 2, packageOpen: false, takeOut: false })).toContain('Unli Grill');
    expect(html({ kind: 'take_out' })).not.toContain('Unli Grill');
    expect(html({ kind: 'add', sessionId: A, label: 'Take-out', heads: 0, packageOpen: false, takeOut: true })).not.toContain('Unli Grill');
    expect(html({ kind: 'add', sessionId: A, label: 'Take-out', heads: 0, packageOpen: false, takeOut: true })).toContain('Pork belly'); // the rest of the menu is there
  });
});

describe('audit 3 - the shell tells a refusal on every tab', () => {
  it('with no Orders tab mounted, a quarantined result shows the one sentence naming the stand, and OK dismisses it', async () => {
    const heads = { seq: 3, kind: 'heads.set', personId: PERSON, occurredAtDevice: T, payload: { sessionId: A, headsCashier: 1 } };
    h.pending = [heads];
    h.body = { stateVersion: 1, openStands: [STAND], kitchenQueue: null, refillQueue: null };
    await act(async () => {
      root.render(
        createElement(PosShell, {
          person: { personId: 'p1', displayName: 'Carla Cashier' }, heldPos: ['record_sale'], stores: [{ id: 's1', name: 'Lipa' }], pairedStoreId: 's1', erpHref: null,
          children: createElement('p', null, 'Kitchen tab body'),
        }),
      );
    });
    expect(host.textContent).toContain('Kitchen tab body');
    expect(h.handler, 'the shell registered the results handler').toBeTypeOf('function');
    await act(async () => h.handler!([heads], [{ seq: 3, status: 'applied' }]));
    expect(host.textContent).not.toContain('was refused');
    await act(async () => h.handler!([heads], [{ seq: 3, status: 'quarantined', error: 'pos: below senior count' }]));
    expect(host.textContent).toContain('A change to Stand 5 was refused. A manager will see it.');
    const ok = [...host.querySelectorAll('button')].find((b) => b.textContent === 'OK')!;
    await act(async () => ok.click());
    expect(host.textContent).not.toContain('was refused');
  });
});

describe('audit 6 - the real Orders container', () => {
  const ctx = (paired: boolean): PosContextValue => ({
    storeId: 's1', paired, personId: PERSON, offlineActorPersonId: null, online: true, openStands: [STAND], stateVersion: 1, pendingEvents: [],
    ordersSnapshot: { stands: SNAPSHOT.stands, menu: SNAPSHOT.menu }, bodiesRef: { current: {} }, requestDrain: () => undefined, setResultsHandler: () => undefined,
  });
  const show = async (paired: boolean) => {
    await act(async () => root.render(createElement(PosContext.Provider, { value: ctx(paired) }, createElement(Orders))));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click()); // open the table panel
  };

  it('with no pairing it draws the tiles, the panel and the note, and no Seat, Take-out, Add, heads, cancel or Pay control', async () => {
    await show(false);
    expect(host.textContent).toContain('Stand 5');
    expect(host.textContent).toContain('Orders are taken on the store tablet.');
    expect(host.querySelector('aside')).toBeTruthy(); // the panel is open
    expect(host.textContent).not.toMatch(WRITE_CONTROLS);
    expect([...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent)).not.toContainEqual(expect.stringMatching(WRITE_CONTROLS));
  });

  it('control: the same container on a paired tablet draws them', async () => {
    await show(true);
    for (const word of ['Seat a party', 'Take-out', 'Add items']) expect(host.textContent, word).toContain(word);
    expect(host.querySelector('[aria-label="Fewer heads"]')).toBeTruthy();
    expect(host.textContent).not.toContain('Orders are taken on the store tablet.');
  });
});
