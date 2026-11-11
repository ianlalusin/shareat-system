// @vitest-environment happy-dom
/**
 * T-527b - what the render of the Orders screen found:
 *   2. "Items so far": exact running sum (no VAT, no discounts, no floats) and the seat flow is a panel, not a full-screen dialog;
 *   1. a sold-out dish is shown greyed and cannot be tapped (the snapshot side is packages/domain/tests/integration/t527b-snapshot-sold-out.test.ts);
 *   3. a heads change keeps the order of the lines and shows the sending dot on the package line;
 *   4. a cancelled line stays struck through until the server confirms; a refused cancel restores it;
 *   5. the Queued chip only while pending; unconfirmed heads are quiet text, and only a server count that differs is a pill.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreMenuV2 } from '@shareat/domain';
import type { PosEvent } from '@/lib/pos-device';
import { cartRows, itemsSoFarSum } from '@/app/pos/_orders/cart-sum';
import { ItemsSoFar } from '@/app/pos/_orders/ItemsSoFar';
import { OrderDialog } from '@/app/pos/_orders/OrderDialogs';
import { OrdersView } from '@/app/pos/_orders/OrdersView';
import { makeIdGenerator } from '@/app/pos/_orders/ids';
import { projectOrders, refusalNotices, type GhostLine, type ServerLine } from '@/app/pos/_orders/project';
import { stillSettling, type Settling } from '@/app/pos/_orders/settle';
import { IDS, MENU, PERSON, SNAPSHOT, id } from './helpers/t527-menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = '2026-11-07T09:00:00.000Z';
const T1 = '2026-11-07T09:05:00.000Z';
const T2 = '2026-11-07T09:10:00.000Z';
const A = id(700);

describe('Items so far - the sum', () => {
  it('per-head package x heads plus a la carte with option deltas, exact', () => {
    const cart = [
      { itemId: IDS.unli, variantId: IDS.unliV, qty: 1 },
      { itemId: IDS.pork, variantId: IDS.porkV, qty: 2, optionValueIds: [IDS.spicy] },
    ];
    const rows = cartRows(cart, MENU, 3);
    expect(rows.map((r) => [r.qty, r.unit, r.total])).toEqual([[3, '449.00', '1347.00'], [2, '260.00', '520.00']]);
    expect(itemsSoFarSum(rows)).toBe('1867.00');
  });

  it('no floating point: ten-centavo and twenty-centavo prices add to exactly 0.30', () => {
    const menu = structuredClone(MENU) as StoreMenuV2;
    const price = (itemId: string, amount: string) => {
      const v = menu.items.find((i) => i.id === itemId)!.variants[0]!;
      v.channels.store = { orderable: true, amount, bundleHeads: null, extraHeadAmount: null };
    };
    price(IDS.plain, '0.10');
    price(IDS.extraRice, '0.20');
    const rows = cartRows([{ itemId: IDS.plain, qty: 1 }, { itemId: IDS.extraRice, qty: 1 }], menu, null);
    expect(itemsSoFarSum(rows)).toBe('0.30');
  });

  it('a bundle is its flat price plus the extra heads, shown as one line', () => {
    const menu = structuredClone(MENU) as StoreMenuV2;
    menu.items.find((i) => i.id === IDS.unli)!.variants[0]!.channels.store = { orderable: true, amount: '2000.00', bundleHeads: 4, extraHeadAmount: '450.00' };
    const rows = cartRows([{ itemId: IDS.unli, variantId: IDS.unliV, qty: 1 }], menu, 6);
    expect(rows[0]).toMatchObject({ qty: 1, unit: '2000.00', total: '2900.00', bundleNote: 'up to 4 heads' });
  });

  it('an empty cart sums to 0.00; a package with no heads known counts one', () => {
    expect(itemsSoFarSum(cartRows([], MENU, 2))).toBe('0.00');
    expect(cartRows([{ itemId: IDS.unli, variantId: IDS.unliV, qty: 1 }], MENU, null)[0]).toMatchObject({ qty: 1, total: '449.00' });
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const clickByLabel = async (label: string) => act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());

describe('Items so far - the panel', () => {
  it('shows qty x name, options, qty x display price and a sum headed "Items so far" that says it is not the bill', () => {
    const html = renderToStaticMarkup(
      createElement(ItemsSoFar, { cart: [{ itemId: IDS.pork, variantId: IDS.porkV, qty: 2, optionValueIds: [IDS.spicy], note: 'no chili' }], menu: MENU, heads: 2, onChange: () => undefined }),
    );
    expect(html).toContain('Pork belly');
    expect(html).toContain('Spicy');
    expect(html).toContain('Note: no chili');
    expect(html).toContain('260.00');
    expect(html).toContain('Items so far');
    expect(html).toContain('520.00');
    expect(html).toContain('Not the bill');
    expect(html).not.toMatch(/VAT \d|discount applied/i);
  });

  it('plus, minus and remove change the cart', async () => {
    const calls: unknown[][] = [];
    const cart = [{ itemId: IDS.pork, variantId: IDS.porkV, qty: 2 }, { itemId: IDS.plain, qty: 1 }];
    await act(async () => root.render(createElement(ItemsSoFar, { cart, menu: MENU, heads: 2, onChange: (c) => void calls.push(c) })));
    await clickByLabel('More Pork belly');
    await clickByLabel('Fewer Pork belly');
    await clickByLabel('Remove Plain rice');
    expect(calls[0]).toMatchObject([{ qty: 3 }, { qty: 1 }]);
    expect(calls[1]).toMatchObject([{ qty: 1 }, { qty: 1 }]);
    expect(calls[2]).toHaveLength(1);
  });
});

describe('the seat flow is a panel under the shell header', () => {
  const mount = (mode: Parameters<typeof OrderDialog>[0]['mode']) =>
    act(async () => root.render(createElement(OrderDialog, { mode, menu: MENU, stands: SNAPSHOT.stands, tiles: [], onClose: () => undefined, onSend: async () => null })));

  it('is not a dialog, so the status pill and tabs stay visible; the summary sits beside the picker', async () => {
    await mount({ kind: 'seat' });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('aside[aria-label="New order summary"]')).toBeTruthy();
    expect(host.textContent).toContain('Items so far');
  });

  it('a sold-out dish shows greyed, labelled "Sold out", and tapping it adds nothing', async () => {
    await mount({ kind: 'seat' });
    const drinks = [...host.querySelectorAll('nav button')].find((b) => b.textContent === 'Drinks')!;
    await act(async () => (drinks as HTMLButtonElement).click());
    const cola = [...host.querySelectorAll<HTMLButtonElement>('ul button')].find((b) => b.textContent?.startsWith('Cola'))!;
    expect(cola.textContent).toContain('Sold out');
    expect(cola.disabled).toBe(true);
    await act(async () => cola.click());
    expect(host.querySelector('aside')!.textContent).toContain('Nothing picked yet');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const ev = (seq: number, kind: PosEvent['kind'], payload: Record<string, unknown>): PosEvent => ({ seq, kind, personId: PERSON, occurredAtDevice: T2, payload });
const L = { pkg: id(710), pork: id(711), cola: id(712), plain: id(713) };
const sl = (lineId: string, kind: string, name: string, qty: number, addedAtDevice: string, extra: Partial<ServerLine> = {}): ServerLine => ({
  id: lineId, kind, name, qty, unitPrice: '100.00', kitchenStatus: 'queued', bundleHeads: null, addedAtDevice, ...extra,
});
const server = (lines: ServerLine[], o: { heads?: number; headsServer?: number | null; mode?: string } = {}) => ({
  openStands: [{ sessionId: A, standId: IDS.stand5, standNumber: 5, mode: o.mode ?? 'dine_in', headsCashier: o.heads ?? 4, headsServer: o.headsServer ?? null, openedAtDevice: T0 }],
  sessions: { [A]: { session: { id: A, mode: o.mode ?? 'dine_in', standId: IDS.stand5, status: 'open', headsCashier: o.heads ?? 4, headsServer: o.headsServer ?? null }, lines } },
});
const ids = (v: ReturnType<typeof projectOrders>) => v.sessions[A]!.lines.map((l) => l.id);

describe('heads change - the order of lines is stable and the package line shows it is sending', () => {
  const before = server([sl(L.pkg, 'package', 'Unli Grill', 4, T0), sl(L.pork, 'item', 'Pork belly', 2, T1), sl(L.cola, 'item', 'Cola', 1, T2)]);

  it('lines are ordered by addedAtDevice then lineId, whatever order the server body or the outbox gives them', () => {
    const shuffled = server([sl(L.cola, 'item', 'Cola', 1, T2), sl(L.pork, 'item', 'Pork belly', 2, T1), sl(L.pkg, 'package', 'Unli Grill', 4, T0)]);
    expect(ids(projectOrders(shuffled, [], SNAPSHOT))).toEqual([L.pkg, L.pork, L.cola]);
    const sameTime = server([sl(id(799), 'item', 'B', 1, T0), sl(id(798), 'item', 'A', 1, T0)]);
    expect(ids(projectOrders(sameTime, [], SNAPSHOT))).toEqual([id(798), id(799)]);
  });

  it('while heads.set is pending: same order, package line shows the new heads and the sending dot, other lines untouched', () => {
    const view = projectOrders(before, [ev(1, 'heads.set', { sessionId: A, headsCashier: 6 })], SNAPSHOT);
    expect(ids(view)).toEqual([L.pkg, L.pork, L.cola]);
    const [pkg, pork] = view.sessions[A]!.lines;
    expect(pkg).toMatchObject({ qty: 6, pending: true });
    expect(pork).toMatchObject({ qty: 2, pending: false });
  });

  it('when the server answers with the package line re-made (new id, same addedAtDevice) the order does not change', () => {
    const after = server([sl(id(720), 'package', 'Unli Grill', 6, T0), sl(L.pork, 'item', 'Pork belly', 2, T1), sl(L.cola, 'item', 'Cola', 1, T2)], { heads: 6 });
    expect(ids(projectOrders(after, [], SNAPSHOT))).toEqual([id(720), L.pork, L.cola]);
  });

  it('a pending line and the same line from the server have the same place', () => {
    const add = ev(2, 'lines.added', { sessionId: A, lines: [{ lineId: L.plain, menuItemId: IDS.plain, variantId: IDS.plainV, qty: 1, addedAtDevice: T1 }] });
    const pendingView = projectOrders(before, [add], SNAPSHOT);
    const served = server([...before.sessions[A]!.lines, sl(L.plain, 'item', 'Plain rice', 1, T1)]);
    expect(ids(projectOrders(served, [], SNAPSHOT))).toEqual(ids(pendingView));
  });

  it('a bundle line is never rewritten to the heads', () => {
    const bundle = server([sl(L.pkg, 'package', 'Barkada (up to 4)', 1, T0, { bundleHeads: 4 })], { heads: 4 });
    const view = projectOrders(bundle, [ev(1, 'heads.set', { sessionId: A, headsCashier: 6 })], SNAPSHOT);
    expect(view.sessions[A]!.lines[0]).toMatchObject({ qty: 1, pending: true });
  });
});

describe('a cancelled line stays until the server confirms', () => {
  const body = server([sl(L.pkg, 'package', 'Unli Grill', 4, T0), sl(L.pork, 'item', 'Pork belly', 2, T1)]);
  const cancel = ev(5, 'line.cancelled', { lineId: L.pork, reason: 'Wrong item' });
  const gone = server([sl(L.pkg, 'package', 'Unli Grill', 4, T0)]); // the server body after it applied the cancel
  const ghost: GhostLine[] = [{ sessionId: A, line: body.sessions[A]!.lines[1]! }];

  it('pending cancel: the line stays, struck through, with the sending dot', () => {
    const line = projectOrders(body, [cancel], SNAPSHOT).sessions[A]!.lines[1]!;
    expect(line).toMatchObject({ id: L.pork, cancelled: true, pending: true });
  });

  it('the server body has already dropped the line but the cancel is still settling: the last-seen line is kept, struck through', () => {
    const view = projectOrders(gone, [cancel], SNAPSHOT, ghost);
    expect(ids(view)).toEqual([L.pkg, L.pork]);
    expect(view.sessions[A]!.lines[1]).toMatchObject({ cancelled: true, pending: true });
  });

  it('confirmed = settle has let go AND the body no longer holds the line: the line is gone', () => {
    const settling: Settling = { event: cancel, sessionId: A, versionAtDrop: 4, droppedAtMs: 1_000 };
    const ctx = (version: number, landed: number) => ({ version, landed: { [A]: landed }, nowMs: 2_000 });
    expect(stillSettling([settling], ctx(5, 4))).toHaveLength(1); // poll moved, body not yet: still shown
    expect(stillSettling([settling], ctx(5, 5))).toHaveLength(0); // both landed
    expect(ids(projectOrders(gone, [], SNAPSHOT, ghost))).toEqual([L.pkg]); // no cancel event applied any more: nothing is brought back
  });
});

describe('the heads text, the pill and the chips', () => {
  const tile = (v: ReturnType<typeof projectOrders>) => v.tiles[0]!;
  const pkg = sl(L.pkg, 'package', 'Unli Grill', 4, T0);

  it('an unconfirmed dine-in package table (server count null) is quiet text "Heads not checked", never a pill', () => {
    const t = tile(projectOrders(server([pkg]), [], SNAPSHOT));
    expect(t).toMatchObject({ needsHeads: true, headsMismatch: false });
    expect(tile(projectOrders(server([sl(L.pork, 'item', 'Pork belly', 1, T0)]), [], SNAPSHOT)).needsHeads).toBe(false); // a la carte only
    expect(tile(projectOrders(server([pkg], { mode: 'take_out', heads: 0 }), [], SNAPSHOT)).needsHeads).toBe(false);
    const html = renderTiles([t], { [A]: { headsCashier: 4, headsServer: null, loaded: true, lines: [] } });
    expect(html).toContain('Heads not checked');
    expect(html).not.toContain('Heads 4 vs');
    expect(html).not.toContain('Heads?');
  });

  it('the amber pill shows only when the server counted a different number: "Heads 4 vs 5"', () => {
    const differs = tile(projectOrders(server([pkg], { heads: 4, headsServer: 5 }), [], SNAPSHOT));
    expect(differs).toMatchObject({ headsMismatch: true, needsHeads: false });
    expect(tile(projectOrders(server([pkg], { heads: 4, headsServer: 4 }), [], SNAPSHOT))).toMatchObject({ headsMismatch: false, needsHeads: false });
    expect(tile(projectOrders(server([pkg], { heads: 4, headsServer: null }), [], SNAPSHOT)).headsMismatch).toBe(false);
    const html = renderTiles([differs], { [A]: { headsCashier: 4, headsServer: 5, loaded: true, lines: [] } });
    expect(html).toContain('Heads 4 vs 5');
    expect(html).not.toContain('Heads not checked');
  });

  const renderTiles = (tiles: ReturnType<typeof projectOrders>['tiles'], sessions: ReturnType<typeof projectOrders>['sessions']) =>
    renderToStaticMarkup(
      createElement(OrdersView, {
        readOnly: false, tiles, sessions, selectedSessionId: null, nowMs: Date.parse(T0) + 60_000,
        onSeat: () => undefined, onTakeOut: () => undefined, onSelect: () => undefined, onHeads: () => undefined, onAddItems: () => undefined, onCancelLine: () => undefined,
      }),
    );
  const renderLines = (lines: ReturnType<typeof projectOrders>['sessions'][string]['lines']) =>
    renderToStaticMarkup(
      createElement(OrdersView, {
        readOnly: false,
        tiles: [{ sessionId: A, standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 2, headsServer: null, openedAtDevice: T0, packageName: null, needsHeads: false, headsMismatch: false, pending: false }],
        sessions: { [A]: { headsCashier: 2, headsServer: null, loaded: true, lines } },
        selectedSessionId: A,
        nowMs: Date.parse(T0) + 60_000,
        onSeat: () => undefined,
        onTakeOut: () => undefined,
        onSelect: () => undefined,
        onHeads: () => undefined,
        onAddItems: () => undefined,
        onCancelLine: () => undefined,
      }),
    );
  const base = { id: L.pork, name: 'Pork belly', qty: 1, unitPrice: '100.00', note: null, optionNames: [], addedAtDevice: T0 };

  it('Queued shows only on a line with a pending event; a served line says Served; a cancelled one says Cancelling', () => {
    expect(renderLines([{ ...base, kitchenStatus: 'queued', pending: false, cancelled: false }])).not.toContain('Queued');
    const pending = renderLines([{ ...base, kitchenStatus: 'queued', pending: true, cancelled: false }]);
    expect(pending).toContain('Queued');
    expect(pending).toContain('Sending');
    expect(renderLines([{ ...base, kitchenStatus: 'served', pending: false, cancelled: false }])).toContain('Served');
    const c = renderLines([{ ...base, kitchenStatus: 'queued', pending: true, cancelled: true }]);
    expect(c).toContain('Cancelling');
    expect(c).toContain('line-through');
  });
});

describe('a served package line is never rewritten by a heads change', () => {
  const served = server([sl(L.pkg, 'package', 'Unli Grill', 4, T0, { kitchenStatus: 'served' }), sl(L.pork, 'item', 'Pork belly', 2, T1)], { heads: 4 });

  it('more heads: the served line stays at 4, and a pending extra line shows the difference', () => {
    const view = projectOrders(served, [ev(1, 'heads.set', { sessionId: A, headsCashier: 6 })], SNAPSHOT);
    const lines = view.sessions[A]!.lines;
    expect(lines.find((l) => l.id === L.pkg)).toMatchObject({ qty: 4, kitchenStatus: 'served', pending: false });
    expect(lines.filter((l) => l.extraHeads)).toMatchObject([{ qty: 2, name: 'Unli Grill', pending: true, kitchenStatus: 'queued' }]);
  });

  it('billed heads are the larger of the cashier and server counts', () => {
    const view = projectOrders(server([sl(L.pkg, 'package', 'Unli Grill', 4, T0, { kitchenStatus: 'served' })], { heads: 4, headsServer: 7 }), [ev(1, 'heads.set', { sessionId: A, headsCashier: 6 })], SNAPSHOT);
    expect(view.sessions[A]!.lines.filter((l) => l.extraHeads)).toMatchObject([{ qty: 3 }]); // max(6, 7) = 7, covered 4
    const unserved = projectOrders(server([sl(L.pkg, 'package', 'Unli Grill', 4, T0)], { heads: 4, headsServer: 7 }), [ev(1, 'heads.set', { sessionId: A, headsCashier: 6 })], SNAPSHOT);
    expect(unserved.sessions[A]!.lines[0]).toMatchObject({ qty: 7, pending: true });
  });

  it('fewer heads, or no pending change: no extra line', () => {
    expect(projectOrders(served, [ev(1, 'heads.set', { sessionId: A, headsCashier: 3 })], SNAPSHOT).sessions[A]!.lines.some((l) => l.extraHeads)).toBe(false);
    expect(projectOrders(served, [], SNAPSHOT).sessions[A]!.lines.some((l) => l.extraHeads)).toBe(false);
  });
});

describe('device ids sort in creation order', () => {
  it('10 ids made in one millisecond sort in the order they were made, and stay valid uuids', () => {
    const next = makeIdGenerator(() => 1_794_000_000_000);
    const made = Array.from({ length: 10 }, () => next());
    expect([...made].sort()).toEqual(made);
    for (const m of made) expect(m).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(made).size).toBe(10);
  });

  it('ids made later sort later, a clock that steps back never goes backwards, and 4096 in one ms borrow the next ms', () => {
    let t = 1_794_000_000_000;
    const next = makeIdGenerator(() => t);
    const a = next();
    t += 5;
    const b = next();
    t -= 100; // the clock went back
    const c = next();
    expect([a, b, c].sort()).toEqual([a, b, c]);
    const burst = Array.from({ length: 4200 }, () => next());
    expect([...burst].sort()).toEqual(burst);
    expect(c < burst[0]!).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the Orders container: cancels settle through the real path', () => {
  const cancel = { seq: 9, kind: 'line.cancelled', personId: PERSON, occurredAtDevice: T2, payload: { lineId: L.pork, reason: 'Wrong item' } } as PosEvent;
  const STAND = { sessionId: A, standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 4, headsServer: null, openedAtDevice: T0 };
  const bodyOf = (lines: ServerLine[]) => ({ session: { id: A, mode: 'dine_in', standId: IDS.stand5, status: 'open', headsCashier: 4, headsServer: null }, lines });
  const both = [sl(L.pkg, 'package', 'Unli Grill', 4, T0), sl(L.pork, 'item', 'Pork belly', 2, T1)];
  let answer: ServerLine[];
  const ctx = (o: { version: number; pending: PosEvent[]; stands?: unknown[] }) => ({
    storeId: 's1', paired: true, personId: PERSON, offlineActorPersonId: null, online: true, openStands: o.stands ?? [STAND], stateVersion: o.version, pendingEvents: o.pending,
    ordersSnapshot: { stands: SNAPSHOT.stands, menu: SNAPSHOT.menu }, bodiesRef: { current: {} }, requestDrain: () => undefined, setResultsHandler: () => undefined,
  });
  const show = async (c: ReturnType<typeof ctx>) => {
    const { PosContext } = await import('@/app/pos/_shell/pos-context');
    const { Orders } = await import('@/app/pos/_orders/Orders');
    await act(async () => root.render(createElement(PosContext.Provider, { value: c as never }, createElement(Orders))));
  };
  const panel = () => host.querySelector('aside')?.textContent ?? '';
  beforeEach(() => {
    answer = both;
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => bodyOf(answer) }));
  });
  const open = async () => {
    await show(ctx({ version: 1, pending: [] }));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click());
  };

  it('a ghost comes from lastSeen when the server body drops a line mid-cancel, and goes away when the server confirms', async () => {
    await open();
    expect(panel()).toContain('Pork belly');
    answer = [both[0]!]; // the server applied the cancel
    await show(ctx({ version: 2, pending: [cancel] }));
    expect(panel()).toContain('Pork belly'); // kept from lastSeen
    expect(panel()).toContain('Cancelling');
    await show(ctx({ version: 2, pending: [] })); // the outbox let the event go: it settles
    expect(panel()).toContain('Cancelling');
    await show(ctx({ version: 3, pending: [] })); // the poll moved and the body for it landed: confirmed
    expect(panel()).not.toContain('Pork belly');
  });

  it('a REFUSED cancel (quarantined) is struck while settling, then the line comes back, and the refusal sentence names the stand', async () => {
    await open();
    await show(ctx({ version: 1, pending: [cancel] })); // the server body still holds the line: it never applied it
    expect(panel()).toContain('Cancelling');
    const view = projectOrders({ openStands: [STAND], sessions: { [A]: bodyOf(both) } }, [cancel], SNAPSHOT);
    expect(refusalNotices([cancel], [{ seq: 9, status: 'quarantined', error: 'pos: line served' }], view)).toEqual(['A change to Stand 5 was refused. A manager will see it.']);
    await show(ctx({ version: 1, pending: [] })); // dropped from the outbox as quarantined
    expect(panel()).toContain('Cancelling'); // still shown while it settles
    await show(ctx({ version: 2, pending: [] })); // poll and body landed: the server still holds the line
    expect(panel()).toContain('Pork belly');
    expect(panel()).not.toContain('Cancelling');
  });

  it('a table that leaves the open list loses its last-seen lines: no ghost from it later', async () => {
    await open();
    await show(ctx({ version: 2, pending: [], stands: [] }));
    answer = [both[0]!];
    await show(ctx({ version: 3, pending: [cancel] }));
    expect(host.textContent).not.toContain('Pork belly');
  });
});

describe('the seat/add panel keyboard', () => {
  const esc = (target: EventTarget = document) => act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  const panel = (onClose: () => void, onSend: () => Promise<string | null> = async () => null, mode: Parameters<typeof OrderDialog>[0]['mode'] = { kind: 'seat' }) =>
    act(async () => root.render(createElement(OrderDialog, { mode, menu: MENU, stands: SNAPSHOT.stands, tiles: [], onClose, onSend })));
  const category = (name: string) => act(async () => ([...host.querySelectorAll('nav button')].find((b) => b.textContent === name) as HTMLButtonElement).click());
  const tapItem = (name: string) => act(async () => [...host.querySelectorAll<HTMLButtonElement>('ul button')].find((b) => b.textContent?.startsWith(name))!.click());

  it('focus moves to the panel heading when it opens, and the heading is an h2 (the page already has its h1)', async () => {
    await panel(() => undefined);
    const heading = host.querySelector('h2')!;
    expect(heading.textContent).toBe('Seat a party');
    expect(document.activeElement).toBe(heading);
    expect(host.querySelector('h1')).toBeNull();
  });

  it('Escape closes it when nothing would be lost, like the Cancel button', async () => {
    const onClose = vi.fn();
    await panel(onClose);
    await esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')!.click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('with items picked, Escape does nothing; Cancel is the way out', async () => {
    const onClose = vi.fn();
    await panel(onClose, async () => null, { kind: 'take_out' });
    await category('Grill');
    await tapItem('Plain rice'); // one variant, no options: added at once
    expect(host.querySelector('aside')!.textContent).toContain('Plain rice');
    await esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape closes the choice sheet first, and the panel only on the next Escape', async () => {
    const onClose = vi.fn();
    await panel(onClose);
    await category('Grill');
    await tapItem('Pork belly'); // has a sauce group: opens its choice sheet
    expect(host.querySelector('section[aria-label="Choose Pork belly"]')).toBeTruthy();
    await esc();
    expect(host.querySelector('section[aria-label="Choose Pork belly"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('while saving (busy), Escape does nothing', async () => {
    const onClose = vi.fn();
    let release: (v: string | null) => void = () => undefined;
    await panel(onClose, () => new Promise<string | null>((r) => (release = r)));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Stand 4"]')!.click());
    await act(async () => void [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Start order'))!.click());
    await esc();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => release(null));
  });

  it('in the real Orders container: Seat a party opens the panel, Escape closes it, and focus is back on Seat a party', async () => {
    const { PosContext } = await import('@/app/pos/_shell/pos-context');
    const { Orders } = await import('@/app/pos/_orders/Orders');
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const c = {
      storeId: 's1', paired: true, personId: PERSON, offlineActorPersonId: null, online: true, openStands: [], stateVersion: 1, pendingEvents: [],
      ordersSnapshot: { stands: SNAPSHOT.stands, menu: SNAPSHOT.menu }, bodiesRef: { current: {} }, requestDrain: () => undefined, setResultsHandler: () => undefined,
    };
    await act(async () => root.render(createElement(PosContext.Provider, { value: c as never }, createElement(Orders))));
    const seat = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Seat a party')!;
    seat.focus();
    await act(async () => seat.click());
    expect(host.querySelector('aside[aria-label="New order summary"]')).toBeTruthy();
    await esc();
    expect(host.querySelector('aside[aria-label="New order summary"]')).toBeNull();
    expect(document.activeElement).toBe(seat);
  });
});
