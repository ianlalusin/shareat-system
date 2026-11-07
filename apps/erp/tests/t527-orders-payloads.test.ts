/**
 * T-527 (TESTER) - R3 / R5 / R6 and the Addendum: the events the Orders tab writes, the one write path, and the phone's read-only rule.
 * docs/tasks/527-pos-orders-screen.md. The payload is the T-524 input MINUS storeId and pairingId (T-525 R3); the inbox refuses any key it does not know,
 * so every shape below is compared EXACTLY (toStrictEqual: an extra key, or a key set to undefined, fails).
 *
 * ASSUMED API (the builder matches these or says why not) - apps/erp/src/app/pos/_orders/payloads.ts:
 *   type Cart = { itemId: string; variantId?: string; qty: number; note?: string; optionValueIds?: string[] }[]    (the picker's cart; a package's qty here is ignored)
 *   seatEvent({ personId, standId, heads, cart, menu: StoreMenuV2, now: Date, newId: () => string }): NewPosEvent
 *       newId is called FIRST for the sessionId, then once per cart line in order (defaults to crypto.randomUUID in the app).
 *       -> { kind: 'stand.opened', personId, occurredAtDevice: now ISO, payload: { sessionId, mode: 'dine_in', standId, headsCashier: heads, openedAtDevice: now ISO, lines } }
 *       line = { lineId, menuItemId, variantId?, qty, note?, addedAtDevice: now ISO, optionValueIds? }; a PACKAGE line has qty = heads. Keys with no value are ABSENT.
 *       heads outside 1..200 throws.
 *   takeOutEvent({ personId, cart, menu, now, newId, name? }): NewPosEvent   -> payload { sessionId, mode: 'take_out', headsCashier: 0, openedAtDevice, lines }, NO standId.
 *       A package in the cart throws (message mentions "package"). `name` becomes the FIRST line's note "For: <name>".
 *   addLinesEvent({ personId, sessionId, heads, cart, menu, now, newId }): NewPosEvent   -> { kind: 'lines.added', payload: { sessionId, lines } }; newId once per line; package qty = heads.
 *   setHeadsEvent({ personId, sessionId, heads, now }): NewPosEvent   -> { kind: 'heads.set', payload: { sessionId, headsCashier } }
 *   cancelLineEvent({ personId, lineId, reason, now }): NewPosEvent   -> { kind: 'line.cancelled', payload: { lineId, reason } }
 *   CANCEL_REASONS: string[]   starts with 'Wrong item', 'Customer changed mind', 'Duplicate' (then 'Other', which the cashier types)
 *   submitPosEvent(deps: { enqueue(e: NewPosEvent): Promise<PosEvent>; requestDrain(): void }, event: NewPosEvent): Promise<{ ok: true; event: PosEvent } | { ok: false; message: string }>
 *       enqueue first, requestDrain only AFTER it resolved; a failed enqueue returns the sentence below and never calls requestDrain.
 *   actingPersonId(offlineActor: { personId: string } | null, sessionPersonId: string): string   the offline actor when one is set, else the online person
 *   ordersAccess({ paired }: { paired: boolean }): { canWrite: boolean; note: string | null }   no pairing = read-only with the note
 *   OrdersView (apps/erp/src/app/pos/_orders/OrdersView.tsx): the presentational half of the tab, no hooks that need the shell:
 *       props { readOnly, tiles, sessions, selectedSessionId, nowMs, onSeat, onTakeOut, onSelect, onHeads(sessionId, delta), onAddItems(sessionId), onCancelLine(lineId) }
 *       tiles/sessions are projectOrders() output. Server-rendered here with renderToStaticMarkup.
 *
 * RED NOW FOR THE RIGHT REASON: neither module exists (lazy import: "MISSING MODULE ... not built").
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PosEvent } from '@/lib/pos-device';
import { IDS, MENU, NOW_ISO, PERSON, SNAPSHOT, id } from './helpers/t527-menu';

vi.mock('next/navigation', () => ({ usePathname: () => '/pos', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

async function load(mod: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- the modules under test do not exist yet
  try {
    return await import(/* @vite-ignore */ `../src/app/pos/_orders/${mod}`);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/_orders/${mod} cannot be loaded (T-527 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}
const payloads = () => load('payloads');

const NOW = new Date(NOW_ISO);
const ids = (...xs: string[]) => {
  const q = [...xs];
  return () => {
    const next = q.shift();
    if (next === undefined) throw new Error('newId called more often than the test allows');
    return next;
  };
};
const [S, L1, L2, L3] = [id(300), id(301), id(302), id(303)] as [string, string, string, string];
const noStoreKeys = (e: unknown) => expect(JSON.stringify(e)).not.toMatch(/storeId|pairingId/);

describe('seatEvent - the exact stand.opened a tablet sends (R3)', () => {
  it('package plus a la carte in the first order: one package line with qty = heads, one a la carte line with its note and options', async () => {
    const { seatEvent } = await payloads();
    const event = seatEvent({
      personId: PERSON, standId: IDS.stand4, heads: 4, now: NOW, menu: MENU, newId: ids(S, L1, L2),
      cart: [
        { itemId: IDS.unli, variantId: IDS.unliV, qty: 1 },
        { itemId: IDS.pork, variantId: IDS.porkV, qty: 2, note: 'no chili', optionValueIds: [IDS.spicy] },
      ],
    });
    expect(event).toStrictEqual({
      kind: 'stand.opened',
      personId: PERSON,
      occurredAtDevice: NOW_ISO,
      payload: {
        sessionId: S,
        mode: 'dine_in',
        standId: IDS.stand4,
        headsCashier: 4,
        openedAtDevice: NOW_ISO,
        lines: [
          { lineId: L1, menuItemId: IDS.unli, variantId: IDS.unliV, qty: 4, addedAtDevice: NOW_ISO },
          { lineId: L2, menuItemId: IDS.pork, variantId: IDS.porkV, qty: 2, note: 'no chili', addedAtDevice: NOW_ISO, optionValueIds: [IDS.spicy] },
        ],
      },
    });
    noStoreKeys(event);
  });

  it('an empty first order is allowed: lines is an empty list, and a line with no note or options has neither key', async () => {
    const { seatEvent } = await payloads();
    const bare = seatEvent({ personId: PERSON, standId: IDS.stand5, heads: 2, now: NOW, menu: MENU, newId: ids(S), cart: [] });
    expect(bare.payload).toStrictEqual({ sessionId: S, mode: 'dine_in', standId: IDS.stand5, headsCashier: 2, openedAtDevice: NOW_ISO, lines: [] });
    const one = seatEvent({ personId: PERSON, standId: IDS.stand5, heads: 2, now: NOW, menu: MENU, newId: ids(S, L1), cart: [{ itemId: IDS.plain, qty: 1 }] });
    expect((one.payload as { lines: unknown[] }).lines[0]).toStrictEqual({ lineId: L1, menuItemId: IDS.plain, qty: 1, addedAtDevice: NOW_ISO });
  });

  it('heads must be 1 to 200', async () => {
    const { seatEvent } = await payloads();
    const make = (heads: number) => seatEvent({ personId: PERSON, standId: IDS.stand5, heads, now: NOW, menu: MENU, newId: ids(S), cart: [] });
    expect(() => make(0)).toThrow();
    expect(() => make(201)).toThrow();
    expect(make(1).payload).toMatchObject({ headsCashier: 1 });
    expect(make(200).payload).toMatchObject({ headsCashier: 200 });
  });
});

describe('takeOutEvent - no stand, no package (R3)', () => {
  it('opens with mode take_out, zero heads and no standId; the optional name rides in the first line\'s note', async () => {
    const { takeOutEvent } = await payloads();
    const event = takeOutEvent({ personId: PERSON, name: 'Ana', now: NOW, menu: MENU, newId: ids(S, L1, L2), cart: [{ itemId: IDS.plain, qty: 2 }, { itemId: IDS.pork, variantId: IDS.porkV, qty: 1, optionValueIds: [IDS.garlic] }] });
    expect(event).toStrictEqual({
      kind: 'stand.opened',
      personId: PERSON,
      occurredAtDevice: NOW_ISO,
      payload: {
        sessionId: S,
        mode: 'take_out',
        headsCashier: 0,
        openedAtDevice: NOW_ISO,
        lines: [
          { lineId: L1, menuItemId: IDS.plain, qty: 2, note: 'For: Ana', addedAtDevice: NOW_ISO },
          { lineId: L2, menuItemId: IDS.pork, variantId: IDS.porkV, qty: 1, addedAtDevice: NOW_ISO, optionValueIds: [IDS.garlic] },
        ],
      },
    });
    noStoreKeys(event);
  });

  it('with no name there is no note, and a package in the cart is refused', async () => {
    const { takeOutEvent } = await payloads();
    const plain = takeOutEvent({ personId: PERSON, now: NOW, menu: MENU, newId: ids(S, L1), cart: [{ itemId: IDS.plain, qty: 1 }] });
    expect(JSON.stringify(plain)).not.toContain('For:');
    expect(() => takeOutEvent({ personId: PERSON, now: NOW, menu: MENU, newId: ids(S, L1, L2), cart: [{ itemId: IDS.unli, variantId: IDS.unliV, qty: 1 }, { itemId: IDS.plain, qty: 1 }] })).toThrow(/package/i);
  });
});

describe('addLinesEvent, setHeadsEvent, cancelLineEvent (R5)', () => {
  it('lines.added carries only sessionId and lines; a package added later still has qty = the current heads', async () => {
    const { addLinesEvent } = await payloads();
    const event = addLinesEvent({
      personId: PERSON, sessionId: S, heads: 3, now: NOW, menu: MENU, newId: ids(L1, L2),
      cart: [{ itemId: IDS.cola, variantId: IDS.colaV, qty: 2 }, { itemId: IDS.unli, variantId: IDS.unliV, qty: 1 }],
    });
    expect(event).toStrictEqual({
      kind: 'lines.added',
      personId: PERSON,
      occurredAtDevice: NOW_ISO,
      payload: {
        sessionId: S,
        lines: [
          { lineId: L1, menuItemId: IDS.cola, variantId: IDS.colaV, qty: 2, addedAtDevice: NOW_ISO },
          { lineId: L2, menuItemId: IDS.unli, variantId: IDS.unliV, qty: 3, addedAtDevice: NOW_ISO },
        ],
      },
    });
    noStoreKeys(event);
  });

  it('heads.set is { sessionId, headsCashier } and nothing else', async () => {
    const { setHeadsEvent } = await payloads();
    const event = setHeadsEvent({ personId: PERSON, sessionId: S, heads: 5, now: NOW });
    expect(event).toStrictEqual({ kind: 'heads.set', personId: PERSON, occurredAtDevice: NOW_ISO, payload: { sessionId: S, headsCashier: 5 } });
    noStoreKeys(event);
  });

  it('line.cancelled is { lineId, reason } and nothing else; the reason list is the short list from the spec', async () => {
    const { cancelLineEvent, CANCEL_REASONS } = await payloads();
    const event = cancelLineEvent({ personId: PERSON, lineId: L3, reason: 'Wrong item', now: NOW });
    expect(event).toStrictEqual({ kind: 'line.cancelled', personId: PERSON, occurredAtDevice: NOW_ISO, payload: { lineId: L3, reason: 'Wrong item' } });
    noStoreKeys(event);
    expect(CANCEL_REASONS.slice(0, 3)).toEqual(['Wrong item', 'Customer changed mind', 'Duplicate']);
  });
});

describe('submitPosEvent - the one write path (R6)', () => {
  const event = { kind: 'heads.set', personId: PERSON, occurredAtDevice: NOW_ISO, payload: { sessionId: S, headsCashier: 5 } } as const;

  it('enqueues the event, then asks for a drain once, in that order', async () => {
    const { submitPosEvent } = await payloads();
    const calls: string[] = [];
    const stored: PosEvent = { ...event, seq: 7 };
    const enqueue = vi.fn(async () => {
      calls.push('enqueue');
      return stored;
    });
    const requestDrain = vi.fn(() => void calls.push('drain'));
    const result = await submitPosEvent({ enqueue, requestDrain }, event);
    expect(result).toEqual({ ok: true, event: stored });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(event);
    expect(calls).toEqual(['enqueue', 'drain']);
  });

  it('a failed enqueue (no IndexedDB, quota) says so in the one sentence, requests no drain, and leaves the pending view exactly as it was', async () => {
    const { submitPosEvent } = await payloads();
    const { projectOrders } = await load('project');
    const pending: PosEvent[] = [{ ...event, seq: 1 }];
    const before = projectOrders({ openStands: [], sessions: {} }, pending, SNAPSHOT);
    const enqueue = vi.fn(async () => {
      throw new Error('QuotaExceededError');
    });
    const requestDrain = vi.fn();
    const result = await submitPosEvent({ enqueue, requestDrain }, event);
    expect(result).toEqual({ ok: false, message: 'This tablet could not save that. Nothing was sent. Try again.' });
    expect(requestDrain).not.toHaveBeenCalled();
    expect(projectOrders({ openStands: [], sessions: {} }, pending, SNAPSHOT)).toEqual(before);
    expect(pending).toHaveLength(1); // nothing was added to the outbox list the view reads
  });

  it('the person on an event is the offline actor when one is set, else the signed-in person', async () => {
    const { actingPersonId } = await payloads();
    expect(actingPersonId({ personId: id(77) }, PERSON)).toBe(id(77));
    expect(actingPersonId(null, PERSON)).toBe(PERSON);
  });
});

describe('phone / kitchen browser: Orders is read-only (row 447)', () => {
  it('without a pairing there is no writing and the note says why; with one there is no note', async () => {
    const { ordersAccess } = await payloads();
    expect(ordersAccess({ paired: false })).toEqual({ canWrite: false, note: 'Orders are taken on the store tablet.' });
    expect(ordersAccess({ paired: true })).toEqual({ canWrite: true, note: null });
  });

  async function render(readOnly: boolean): Promise<string> {
    const { projectOrders } = await load('project');
    const { OrdersView } = await load('OrdersView');
    const A = id(400);
    const server = {
      openStands: [{ sessionId: A, standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 4, headsServer: null, openedAtDevice: '2026-11-07T09:00:00.000Z' }],
      sessions: {
        [A]: {
          session: { id: A, mode: 'dine_in', standId: IDS.stand5, status: 'open', headsCashier: 4, headsServer: null },
          lines: [{ id: id(401), kind: 'package', name: 'Unli Grill', qty: 4, unitPrice: '449.00', kitchenStatus: 'queued', bundleHeads: null }],
        },
      },
    };
    const view = projectOrders(server, [], SNAPSHOT);
    const noop = () => undefined;
    return renderToStaticMarkup(
      createElement(OrdersView, {
        readOnly, tiles: view.tiles, sessions: view.sessions, selectedSessionId: A, nowMs: Date.parse('2026-11-07T09:45:00.000Z'),
        onSeat: noop, onTakeOut: noop, onSelect: noop, onHeads: noop, onAddItems: noop, onCancelLine: noop,
      }),
    );
  }
  const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1] ?? '', text: (m[2] ?? '').replace(/<[^>]*>/g, '').trim() }));

  it('a phone sees the tiles and the table panel and the sentence, and NO Seat, Take-out, Add, heads or cancel control', async () => {
    const html = await render(true);
    expect(html).toContain('Orders are taken on the store tablet.');
    expect(html).toContain('Unli Grill'); // the panel is still there
    expect(html).toContain('Stand 5');
    expect(html).not.toMatch(/Seat a party|Take-out|Add items|Cancel line/);
    for (const b of buttons(html)) {
      expect(b.text, b.attrs).not.toMatch(/^(\+|−|-|–)$/);
      expect(b.attrs).not.toMatch(/aria-label="[^"]*(increase|decrease|more|fewer|add|cancel|remove|seat|take)[^"]*"/i);
    }
  });

  it('the tablet has Seat a party and Take-out (60 px or taller), Add items, and a disabled Pay with the plain tooltip; it does not show the phone note', async () => {
    const html = await render(false);
    expect(html).not.toContain('Orders are taken on the store tablet.');
    for (const label of ['Seat a party', 'Take-out']) {
      const b = buttons(html).find((x) => x.text === label);
      expect(b, label).toBeTruthy();
      expect(b!.attrs, `${label} must be at least 60 px tall`).toMatch(/min-h-(1[5-9]|2\d)\b|min-h-\[(6\d|[7-9]\d)px\]|min-h-\[(3\.75|[4-9](\.\d+)?)rem\]/);
    }
    expect(html).toContain('Add items');
    expect(html).toContain('Payment comes in the next update');
    expect(html).toMatch(/<button\b[^>]*\bdisabled\b[^>]*>(?:(?!<\/button>)[\s\S])*Pay/);
  });

  it('a package table whose server head count is still unknown says Heads not checked, with no pill', async () => {
    const html = await render(false);
    expect(html).toContain('Heads not checked');
    expect(html).not.toContain('Heads?');
  });
});
