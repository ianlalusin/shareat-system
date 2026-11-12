/**
 * T-529 (TESTER) - R2 / R4 unit: the Refills tab's pure logic. docs/tasks/529-pos-kitchen-refills.md R2. No database, no DOM.
 *
 * ASSUMED API (apps/erp/src/app/pos/_refills/):
 *   tables.ts
 *     refillTables(openStands: OpenStand[], packageVariantBySession: Record<string, string | null>): RefillTable[]
 *       OpenStand = T-524 `listOpenStands` row { sessionId, standId, standNumber, mode, headsCashier, headsServer, openedAtDevice }.
 *       Only OPEN DINE-IN tables that hold a PACKAGE (packageVariantBySession[sessionId] is a variant id, not null/absent) and have a stand number; sorted by stand number.
 *       RefillTable = { sessionId, standNumber: number, label: 'Stand 5', packageVariantId: string }
 *   meats.ts
 *     refillMeats(menu: StoreMenuV2, packageVariantId: string): { itemId: string; name: string }[]
 *       exactly the package variant's `refillItemIds` (never every refill on the menu), named from the menu; an id the menu no longer holds is left out;
 *       an unknown variant id is [].
 *   payloads.ts
 *     stepQty(qty: number, delta: 1 | -1): number                      never below 0, never above REFILL_QTY_MAX (999, the domain's line limit)
 *     REFILL_QTY_MAX: number
 *     refillEvent({ personId, sessionId, cart: { itemId: string; qty: number }[], now: Date, newId: () => string }): NewPosEvent
 *       -> { kind: 'refill.requested', personId, occurredAtDevice: now ISO, payload: { sessionId, lines: [{ lineId, menuItemId, qty, addedAtDevice: now ISO }] } }
 *       rows with qty 0 are left out, the rest keep cart order; newId is called once per line, in order; NO price anywhere. An all-zero cart throws 'Pick at least one meat.'
 *     refillRequestInput({ sessionId, cart, newId, now }): { sessionId: string; lines: { lineId: string; menuItemId: string; qty: number }[] }   same rules, for the Server Action
 *   queue.ts
 *     buildRefillRows(tickets: Ticket[], nowMs: number): RefillRow[]
 *       Only kind 'refill' tickets. One row per REQUEST: the lines of one table added at the same addedAtDevice. Rows OLDEST FIRST.
 *       RefillRow = { key: string, sessionId, standLabel: 'Stand 9', itemsText: '3 × Pork belly · 2 × Chicken bulgogi', askedMinutes: number (floor), askedLabel: '3 min', lineIds: string[] }
 *       items in a row are in line order (addedAtDevice then lineId).
 *   heads.ts
 *     headsRows(openStands): { sessionId, standNumber: number, label: 'Stand 5', current: number, confirmed: boolean }[]   dine-in tables only, by stand number;
 *       current = headsServer ?? headsCashier; confirmed = headsServer !== null
 *     stepHeads(n: number, delta: 1 | -1): number    clamps to 1..200 (the domain's own bounds)
 *
 * RED NOW FOR THE RIGHT REASON: the modules do not exist (lazy import: "MISSING MODULE ... not built").
 */
import { describe, expect, it } from 'vitest';
import { id, IT, MENU, minutesAgo, NOW, ST, ticket, VAR } from './helpers/t529-fixtures';

async function load(mod: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- the modules under test do not exist yet
  try {
    return await import(/* @vite-ignore */ `../src/app/pos/_refills/${mod}`);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/_refills/${mod} cannot be loaded (T-529 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}

const stand = (n: number, o: Record<string, unknown> = {}) => ({
  sessionId: id(1000 + n), standId: id(1100 + n), standNumber: n, mode: 'dine_in', headsCashier: 2, headsServer: null, openedAtDevice: '2026-11-07T09:00:00.000Z', ...o,
});

describe('the stand picker lists only open dine-in package tables', () => {
  it('keeps a dine-in table with a package; drops take-out, a dine-in table with no package, and one the map does not know', async () => {
    const { refillTables } = await load('tables');
    const stands = [
      stand(5),
      stand(7, { mode: 'take_out', standId: null, standNumber: null }),
      stand(9), // a la carte only: no package
      stand(12),
      stand(14), // not in the map at all
    ];
    const out = refillTables(stands, { [stands[0]!.sessionId]: VAR.unli, [stands[1]!.sessionId]: VAR.unli, [stands[2]!.sessionId]: null, [stands[3]!.sessionId]: VAR.premium });
    expect(out).toEqual([
      { sessionId: stands[0]!.sessionId, standNumber: 5, label: 'Stand 5', packageVariantId: VAR.unli },
      { sessionId: stands[3]!.sessionId, standNumber: 12, label: 'Stand 12', packageVariantId: VAR.premium },
    ]);
  });
  it('sorts by stand number whatever order the server lists them', async () => {
    const { refillTables } = await load('tables');
    const stands = [stand(12), stand(3), stand(7)];
    const map = Object.fromEntries(stands.map((s) => [s.sessionId, VAR.unli]));
    expect(refillTables(stands, map).map((t: { standNumber: number }) => t.standNumber)).toEqual([3, 7, 12]);
  });
  it('no open tables is an empty list', async () => {
    const { refillTables } = await load('tables');
    expect(refillTables([], {})).toEqual([]);
  });
});

describe('the meats come from the package\'s refillItemIds', () => {
  it('Unli Grill offers exactly its three refills (not Lettuce, not the Noodle refill)', async () => {
    const { refillMeats } = await load('meats');
    const out = refillMeats(MENU, VAR.unli) as { itemId: string; name: string }[];
    expect(out.map((m) => m.name).sort()).toEqual(['Beef brisket', 'Chicken bulgogi', 'Pork belly']);
    expect(out.map((m) => m.itemId).sort()).toEqual([IT.reBrisket, IT.rePork, IT.reBulgogi].sort());
  });
  it('Premium Unli offers its own two, so two packages on one floor get different lists', async () => {
    const { refillMeats } = await load('meats');
    const out = refillMeats(MENU, VAR.premium) as { itemId: string; name: string }[];
    expect(out.map((m) => m.itemId).sort()).toEqual([IT.reLettuce, IT.reBrisket].sort());
  });
  it('a refill that belongs to no package never shows (Noodle refill)', async () => {
    const { refillMeats } = await load('meats');
    for (const v of [VAR.unli, VAR.premium]) expect((refillMeats(MENU, v) as { itemId: string }[]).map((m) => m.itemId)).not.toContain(IT.reNoodles);
  });
  it('an unknown package variant has no meats', async () => {
    const { refillMeats } = await load('meats');
    expect(refillMeats(MENU, id(12345))).toEqual([]);
  });
  it('an id in refillItemIds that the menu no longer holds is left out, not a crash', async () => {
    const { refillMeats } = await load('meats');
    const menu = {
      ...MENU,
      items: MENU.items.map((i) => (i.id === IT.unli ? { ...i, variants: i.variants.map((v) => ({ ...v, refillItemIds: [...v.refillItemIds, id(54321)] })) } : i)),
    };
    expect((refillMeats(menu, VAR.unli) as unknown[]).length).toBe(3);
  });
});

describe('the steppers', () => {
  it('+ adds one, - takes one, and never goes below 0', async () => {
    const { stepQty } = await load('payloads');
    expect(stepQty(0, 1)).toBe(1);
    expect(stepQty(2, 1)).toBe(3);
    expect(stepQty(2, -1)).toBe(1);
    expect(stepQty(0, -1)).toBe(0);
  });
  it('stops at the domain\'s line limit of 999', async () => {
    const { stepQty, REFILL_QTY_MAX } = await load('payloads');
    expect(REFILL_QTY_MAX).toBe(999);
    expect(stepQty(999, 1)).toBe(999);
    expect(stepQty(998, 1)).toBe(999);
  });
  it('the Heads stepper clamps to 1..200', async () => {
    const { stepHeads } = await load('heads');
    expect(stepHeads(4, 1)).toBe(5);
    expect(stepHeads(4, -1)).toBe(3);
    expect(stepHeads(1, -1)).toBe(1);
    expect(stepHeads(200, 1)).toBe(200);
  });
});

describe('refillEvent (the tablet\'s outbox kind) and refillRequestInput (the phone\'s Server Action)', () => {
  const seq = (...xs: string[]) => {
    const q = [...xs];
    return () => q.shift() ?? 'EXHAUSTED';
  };
  const NOW_D = new Date(NOW);
  const S = id(2001);
  const P = id(2002);

  it('builds the exact event: zero rows dropped, cart order kept, one id per line in order, no price', async () => {
    const { refillEvent } = await load('payloads');
    const e = refillEvent({
      personId: P, sessionId: S, now: NOW_D, newId: seq('L1', 'L2'),
      cart: [{ itemId: IT.rePork, qty: 2 }, { itemId: IT.reBrisket, qty: 0 }, { itemId: IT.reBulgogi, qty: 1 }],
    });
    expect(e).toStrictEqual({
      kind: 'refill.requested',
      personId: P,
      occurredAtDevice: NOW_D.toISOString(),
      payload: {
        sessionId: S,
        lines: [
          { lineId: 'L1', menuItemId: IT.rePork, qty: 2, addedAtDevice: NOW_D.toISOString() },
          { lineId: 'L2', menuItemId: IT.reBulgogi, qty: 1, addedAtDevice: NOW_D.toISOString() },
        ],
      },
    });
  });
  it('an all-zero (or empty) cart is refused with one sentence', async () => {
    const { refillEvent } = await load('payloads');
    expect(() => refillEvent({ personId: P, sessionId: S, now: NOW_D, newId: seq('x'), cart: [{ itemId: IT.rePork, qty: 0 }] })).toThrow('Pick at least one meat.');
    expect(() => refillEvent({ personId: P, sessionId: S, now: NOW_D, newId: seq('x'), cart: [] })).toThrow('Pick at least one meat.');
  });
  it('the Server Action input has the same lines and no times or person (the server stamps them)', async () => {
    const { refillRequestInput } = await load('payloads');
    const input = refillRequestInput({ sessionId: S, now: NOW_D, newId: seq('L1', 'L2'), cart: [{ itemId: IT.rePork, qty: 2 }, { itemId: IT.reBulgogi, qty: 3 }] });
    expect(input).toStrictEqual({ sessionId: S, lines: [{ lineId: 'L1', menuItemId: IT.rePork, qty: 2 }, { lineId: 'L2', menuItemId: IT.reBulgogi, qty: 3 }] });
  });
  it('the Server Action input refuses an all-zero cart the same way', async () => {
    const { refillRequestInput } = await load('payloads');
    expect(() => refillRequestInput({ sessionId: S, now: NOW_D, newId: seq('x'), cart: [{ itemId: IT.rePork, qty: 0 }] })).toThrow('Pick at least one meat.');
  });
});

describe('the refill queue (left side of refill.png)', () => {
  const A = id(3001), B = id(3002), C = id(3003);
  it('only refill lines; one row per request; items as "qty × name" joined by " · "', async () => {
    const { buildRefillRows } = await load('queue');
    const at = minutesAgo(3);
    const rows = buildRefillRows(
      [
        ticket({ sessionId: A, standNumber: 9, kind: 'refill', name: 'Pork belly', qty: 3, addedAtDevice: at }),
        ticket({ sessionId: A, standNumber: 9, kind: 'refill', name: 'Chicken bulgogi', qty: 2, addedAtDevice: at }),
        ticket({ sessionId: A, standNumber: 9, kind: 'item', name: 'Cola', qty: 1, addedAtDevice: at }), // a dish is never in the refill queue
      ],
      NOW,
    ) as { key: string; sessionId: string; standLabel: string; itemsText: string; askedMinutes: number; askedLabel: string; lineIds: string[] }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: A, standLabel: 'Stand 9', itemsText: '3 × Pork belly · 2 × Chicken bulgogi', askedMinutes: 3, askedLabel: '3 min' });
    expect(rows[0]!.lineIds).toHaveLength(2);
  });
  it('two requests from one table are two rows; rows run oldest first across tables', async () => {
    const { buildRefillRows } = await load('queue');
    const rows = buildRefillRows(
      [
        ticket({ sessionId: A, standNumber: 9, kind: 'refill', name: 'Pork belly', qty: 1, addedAtDevice: minutesAgo(3) }),
        ticket({ sessionId: B, standNumber: 12, kind: 'refill', name: 'Pork belly', qty: 2, addedAtDevice: minutesAgo(6) }),
        ticket({ sessionId: A, standNumber: 9, kind: 'refill', name: 'Beef brisket', qty: 1, addedAtDevice: minutesAgo(11) }),
        ticket({ sessionId: C, standNumber: 3, kind: 'refill', name: 'Lettuce', qty: 1, addedAtDevice: minutesAgo(1) }),
      ],
      NOW,
    ) as { standLabel: string; itemsText: string; askedLabel: string }[];
    expect(rows.map((r) => [r.standLabel, r.itemsText, r.askedLabel])).toEqual([
      ['Stand 9', '1 × Beef brisket', '11 min'],
      ['Stand 12', '2 × Pork belly', '6 min'],
      ['Stand 9', '1 × Pork belly', '3 min'],
      ['Stand 3', '1 × Lettuce', '1 min'],
    ]);
  });
  it('an empty queue is no rows', async () => {
    const { buildRefillRows } = await load('queue');
    expect(buildRefillRows([], NOW)).toEqual([]);
  });
});

describe('confirm heads rows (phones, row 447)', () => {
  it('lists dine-in tables by stand number; current is the server count when there is one, else the cashier\'s; take-out is not listed', async () => {
    const { headsRows } = await load('heads');
    const rows = headsRows([
      stand(12, { headsCashier: 4, headsServer: 5 }),
      stand(5, { headsCashier: 2, headsServer: null }),
      stand(7, { mode: 'take_out', standId: null, standNumber: null, headsCashier: 0 }),
    ]);
    expect(rows).toEqual([
      { sessionId: id(1005), standNumber: 5, label: 'Stand 5', current: 2, confirmed: false },
      { sessionId: id(1012), standNumber: 12, label: 'Stand 12', current: 5, confirmed: true },
    ]);
  });
});

describe('sanity of the fixtures this file leans on', () => {
  it('the two packages really have different refill lists, and Noodles belongs to neither', () => {
    const lists = MENU.items.filter((i) => i.itemType === 'package').map((i) => i.variants[0]!.refillItemIds);
    expect(lists[0]).not.toEqual(lists[1]);
    expect(lists.flat()).not.toContain(IT.reNoodles);
    expect(ST.grill).toBeTruthy();
  });
});
