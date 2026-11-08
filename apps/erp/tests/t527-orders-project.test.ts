/**
 * T-527 (TESTER) - R1 / R2 / R7: the local view of the Orders tab. docs/tasks/527-pos-orders-screen.md.
 * `projectOrders(server, pending, snapshot)` is pure: the server's last `openStands` plus its cached session bodies, with the outbox's pending events on top.
 * It never invents a server fact, and an event the outbox removed is simply not in `pending` any more, so it stops being applied.
 *
 * ASSUMED API (the builder matches these or says why not) - all in apps/erp/src/app/pos/_orders/project.ts:
 *   projectOrders(server: { openStands: ServerStand[] | null; sessions: Record<string, SessionBody | undefined> }, pending: PosEvent[],
 *                 snapshot: { stands: { id: string; number: number }[]; menu: StoreMenuV2 } | null): { tiles: Tile[]; sessions: Record<string, ProjectedSession> }
 *     ServerStand  = the T-524 listOpenStands row: { sessionId, standId, standNumber, mode, headsCashier, headsServer, openedAtDevice }
 *     SessionBody  = the GET /api/pos/session/[id] body: { session: { id, mode, standId, status, headsCashier, headsServer }, lines: { id, kind, name, qty, unitPrice, kitchenStatus, bundleHeads }[] }
 *     Tile         = { sessionId, standId: string|null, standNumber: number|null, mode, headsCashier, headsServer: number|null, openedAtDevice,
 *                      packageName: string|null, needsHeads: boolean, pending: boolean }     (`pending` = the tile exists ONLY because of a pending stand.opened)
 *     ProjectedSession = { headsCashier, headsServer, lines: ProjectedLine[] }
 *     ProjectedLine    = { id, name, qty, unitPrice: string|null, kitchenStatus: string, note: string|null, optionNames: string[], pending: boolean, cancelled: boolean }
 *       (a pending line's unitPrice is the DISPLAY price: menu amount + option deltas, as a decimal string like "260.00")
 *   Tiles are ordered by openedAtDevice, oldest first. Lines keep server order, pending lines are appended in outbox order.
 *   seatStandChoices(snapshotStands, tiles): { id: string; number: number; inUse: boolean }[]   ordered by number; inUse = some tile holds that stand (pending ones too)
 *   tileClock(openedAtDevice: string, nowMs: number): { minutes: number; label: string; warn: boolean }   label like the offline pill ("45m", "1h 29m"); warn only PAST 90 minutes
 *   refusalNotices(sent: PosEvent[], results: PosEventResult[], view: ReturnType<typeof projectOrders>): string[]
 *       one sentence per QUARANTINED result, naming the stand: "A change to Stand 4 was refused. A manager will see it." (view = computed BEFORE the events left the outbox)
 *
 * RED NOW FOR THE RIGHT REASON: the module does not exist. It is loaded lazily, so each case fails "MISSING MODULE ... not built".
 */
import { describe, expect, it } from 'vitest';
import type { PosEvent, PosEventResult } from '@/lib/pos-device';
import { IDS, SNAPSHOT, id, PERSON } from './helpers/t527-menu';

const MOD = '../src/app/pos/_orders/project';
// biome-ignore lint/suspicious/noExplicitAny: the module under test does not exist yet; its types are the builder's
async function load(): Promise<any> {
  try {
    return await import(/* @vite-ignore */ MOD);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/_orders/project.ts cannot be loaded (T-527 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}

const A = id(100); // server session on stand 5, a package table, heads not yet confirmed
const B = id(101); // server session on stand 7, a la carte only
const C = id(102); // a session that exists only as a pending stand.opened (stand 4)
const T_A = '2026-11-07T09:00:00.000Z';
const T_B = '2026-11-07T09:30:00.000Z';
const T_C = '2026-11-07T10:00:00.000Z';
const L = { pkg: id(200), pork: id(201), cola: id(202), newPork: id(203), newPkg: id(204), c1: id(195) }; // c1 sorts before newPork: lines of one event share a time, so lineId carries the cart order

const SERVER = {
  openStands: [
    { sessionId: B, standId: IDS.stand7, standNumber: 7, mode: 'dine_in', headsCashier: 2, headsServer: 3, openedAtDevice: T_B },
    { sessionId: A, standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 4, headsServer: null, openedAtDevice: T_A },
  ],
  sessions: {
    [A]: {
      session: { id: A, mode: 'dine_in', standId: IDS.stand5, status: 'open', headsCashier: 4, headsServer: null },
      lines: [
        { id: L.pkg, kind: 'package', name: 'Unli Grill', qty: 4, unitPrice: '449.00', kitchenStatus: 'queued', bundleHeads: null },
        { id: L.pork, kind: 'item', name: 'Pork belly', qty: 2, unitPrice: '250.00', kitchenStatus: 'served', bundleHeads: null },
      ],
    },
    [B]: {
      session: { id: B, mode: 'dine_in', standId: IDS.stand7, status: 'open', headsCashier: 2, headsServer: 3 },
      lines: [{ id: L.cola, kind: 'item', name: 'Cola', qty: 1, unitPrice: '80.00', kitchenStatus: 'queued', bundleHeads: null }],
    },
  },
};

let seq = 0;
const ev = (kind: PosEvent['kind'], payload: Record<string, unknown>): PosEvent => ({ seq: ++seq, kind, personId: PERSON, occurredAtDevice: T_C, payload });
const standOpened = (sessionId: string, standId: string | null, o: { heads?: number; lines?: unknown[]; at?: string; mode?: string } = {}) =>
  ev('stand.opened', {
    sessionId, mode: o.mode ?? 'dine_in', ...(standId ? { standId } : {}), headsCashier: o.heads ?? 2, openedAtDevice: o.at ?? T_C, ...(o.lines ? { lines: o.lines } : {}),
  });
const line = (lineId: string, itemId: string, variantId: string, qty: number, extra: Record<string, unknown> = {}) => ({ lineId, menuItemId: itemId, variantId, qty, addedAtDevice: T_C, ...extra });
const linesAdded = (sessionId: string, lines: unknown[]) => ev('lines.added', { sessionId, lines });
const headsSet = (sessionId: string, headsCashier: number) => ev('heads.set', { sessionId, headsCashier });
const cancelled = (lineId: string, reason = 'Wrong item') => ev('line.cancelled', { lineId, reason });

const tileFields = (t: Record<string, unknown>) => ({
  sessionId: t.sessionId, standNumber: t.standNumber, headsCashier: t.headsCashier, headsServer: t.headsServer, packageName: t.packageName, needsHeads: t.needsHeads, pending: t.pending,
});

describe('projectOrders - what the server told us', () => {
  it('turns the server list into tiles, oldest first, with the package name and the Heads? flag', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(SERVER, [], SNAPSHOT);
    expect(view.tiles.map(tileFields)).toEqual([
      { sessionId: A, standNumber: 5, headsCashier: 4, headsServer: null, packageName: 'Unli Grill', needsHeads: true, pending: false },
      { sessionId: B, standNumber: 7, headsCashier: 2, headsServer: 3, packageName: null, needsHeads: false, pending: false },
    ]);
    expect(view.tiles[0]).toMatchObject({ standId: IDS.stand5, mode: 'dine_in', openedAtDevice: T_A });
  });

  it('lines come from the cached session body untouched: not pending, not cancelled', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(SERVER, [], SNAPSHOT);
    expect(view.sessions[A].lines).toEqual([
      { id: L.pkg, name: 'Unli Grill', qty: 4, unitPrice: '449.00', kitchenStatus: 'queued', note: null, optionNames: [], pending: false, cancelled: false, addedAtDevice: null },
      { id: L.pork, name: 'Pork belly', qty: 2, unitPrice: '250.00', kitchenStatus: 'served', note: null, optionNames: [], pending: false, cancelled: false, addedAtDevice: null },
    ]);
  });

  it('with no list at all (never fetched) and nothing pending there are no tiles and no sessions', async () => {
    const { projectOrders } = await load();
    const view = projectOrders({ openStands: null, sessions: {} }, [], SNAPSHOT);
    expect(view.tiles).toEqual([]);
    expect(view.sessions).toEqual({});
  });
});

describe('projectOrders - each pending event kind', () => {
  it('stand.opened adds a tile marked pending (stand number from the snapshot, no server heads) and sorts by its own time', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(SERVER, [standOpened(C, IDS.stand4, { heads: 3 })], SNAPSHOT);
    expect(view.tiles.map((t: { sessionId: string }) => t.sessionId)).toEqual([A, B, C]);
    expect(tileFields(view.tiles[2])).toEqual({ sessionId: C, standNumber: 4, headsCashier: 3, headsServer: null, packageName: null, needsHeads: false, pending: true });
    expect(view.tiles[2]).toMatchObject({ standId: IDS.stand4, mode: 'dine_in', openedAtDevice: T_C });
  });

  it('a pending stand opened EARLIER than a server one goes first (oldest first is by the time seated, not by pending-or-not)', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(SERVER, [standOpened(C, IDS.stand4, { at: '2026-11-07T08:00:00.000Z' })], SNAPSHOT);
    expect(view.tiles.map((t: { sessionId: string }) => t.sessionId)).toEqual([C, A, B]);
  });

  it('stand.opened with first-order lines: package + a la carte lines are pending, named and priced from the menu; the tile shows the package and asks for heads', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(
      { openStands: [], sessions: {} },
      [standOpened(C, IDS.stand4, { heads: 3, lines: [line(L.c1, IDS.unli, IDS.unliV, 3), line(L.newPork, IDS.pork, IDS.porkV, 1, { note: 'no chili', optionValueIds: [IDS.spicy] })] })],
      SNAPSHOT,
    );
    expect(view.sessions[C].lines).toEqual([
      { id: L.c1, name: 'Unli Grill', qty: 3, unitPrice: '449.00', kitchenStatus: 'queued', note: null, optionNames: [], pending: true, cancelled: false, addedAtDevice: T_C },
      { id: L.newPork, name: 'Pork belly', qty: 1, unitPrice: '260.00', kitchenStatus: 'queued', note: 'no chili', optionNames: ['Spicy'], pending: true, cancelled: false, addedAtDevice: T_C },
    ]);
    expect(tileFields(view.tiles[0])).toMatchObject({ packageName: 'Unli Grill', needsHeads: true });
  });

  it('a pending take-out has a tile with no stand number and no heads to ask for', async () => {
    const { projectOrders } = await load();
    const view = projectOrders({ openStands: [], sessions: {} }, [standOpened(C, null, { mode: 'take_out', heads: 0, lines: [line(L.c1, IDS.pork, IDS.porkV, 2, { optionValueIds: [IDS.garlic] })] })], SNAPSHOT);
    expect(view.tiles).toHaveLength(1);
    expect(view.tiles[0]).toMatchObject({ sessionId: C, mode: 'take_out', standId: null, standNumber: null, headsCashier: 0, needsHeads: false, pending: true });
    expect(view.sessions[C].lines[0]).toMatchObject({ name: 'Pork belly', qty: 2, unitPrice: '250.00', optionNames: ['Garlic'], pending: true });
  });

  it('lines.added appends pending lines after the server lines; the display price is the menu amount plus the option deltas', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(SERVER, [linesAdded(A, [line(L.newPork, IDS.pork, IDS.porkV, 2, { optionValueIds: [IDS.spicy] }), line(L.newPkg, IDS.unli, IDS.unliV, 1)])], SNAPSHOT);
    const lines = view.sessions[A].lines;
    expect(lines.map((l: { id: string; pending: boolean }) => [l.id, l.pending])).toEqual([[L.pkg, false], [L.pork, false], [L.newPork, true], [L.newPkg, true]]);
    expect(lines[2]).toMatchObject({ name: 'Pork belly', qty: 2, unitPrice: '260.00', optionNames: ['Spicy'], kitchenStatus: 'queued', cancelled: false });
    expect(view.tiles.map(tileFields)[0]).toMatchObject({ sessionId: A, pending: false }); // an existing table is not a "sending" tile
  });

  it('heads.set changes the cashier count and leaves the server count alone; the last one in outbox order wins', async () => {
    const { projectOrders } = await load();
    const one = projectOrders(SERVER, [headsSet(A, 6)], SNAPSHOT);
    expect(tileFields(one.tiles[0])).toMatchObject({ sessionId: A, headsCashier: 6, headsServer: null });
    expect(one.sessions[A]).toMatchObject({ headsCashier: 6, headsServer: null });
    const two = projectOrders(SERVER, [headsSet(A, 6), headsSet(A, 5)], SNAPSHOT);
    expect(tileFields(two.tiles[0])).toMatchObject({ headsCashier: 5, headsServer: null });
  });

  it('line.cancelled marks the line cancelled (struck through) and keeps it in the list; other lines and the tile are untouched', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(SERVER, [cancelled(L.pork)], SNAPSHOT);
    expect(view.sessions[A].lines.map((l: { id: string; cancelled: boolean }) => [l.id, l.cancelled])).toEqual([[L.pkg, false], [L.pork, true]]);
    expect(view.sessions[A].lines[1]).toMatchObject({ pending: true, qty: 2 }); // T-527b: a line touched by a pending event shows the sending dot, and a cancel touches it
    expect(view.tiles.map(tileFields)).toEqual(projectOrders(SERVER, [], SNAPSHOT).tiles.map(tileFields));
  });

  it('a pending line can be cancelled by a later pending cancel: it stays, pending and cancelled', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(SERVER, [linesAdded(A, [line(L.newPork, IDS.pork, IDS.porkV, 1)]), cancelled(L.newPork, 'Duplicate')], SNAPSHOT);
    const last = view.sessions[A].lines.at(-1);
    expect(last).toMatchObject({ id: L.newPork, pending: true, cancelled: true });
  });
});

describe('projectOrders - removed events, merging and never inventing', () => {
  it('an event the outbox removed is no longer applied: the heads and the extra tile go back to what the server says', async () => {
    const { projectOrders } = await load();
    const withBoth = [headsSet(A, 6), standOpened(C, IDS.stand4)];
    expect(projectOrders(SERVER, withBoth, SNAPSHOT).tiles).toHaveLength(3);
    expect(tileFields(projectOrders(SERVER, withBoth, SNAPSHOT).tiles[0]).headsCashier).toBe(6);
    const afterRemoval = projectOrders(SERVER, [], SNAPSHOT); // applied / duplicate / quarantined / conflict: all leave the outbox
    expect(afterRemoval.tiles).toHaveLength(2);
    expect(tileFields(afterRemoval.tiles[0]).headsCashier).toBe(4);
    expect(afterRemoval.sessions[C]).toBeUndefined();
  });

  it('a server tile and a pending stand.opened for the SAME session merge into one tile, and the server wins (no sending dot)', async () => {
    const { projectOrders } = await load();
    const dup = standOpened(A, IDS.stand5, { heads: 9, at: T_C });
    const view = projectOrders(SERVER, [dup], SNAPSHOT);
    const mine = view.tiles.filter((t: { sessionId: string }) => t.sessionId === A);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ headsCashier: 4, pending: false, openedAtDevice: T_A });
  });

  it('pending first-order lines the server already holds are not shown twice and are not marked pending', async () => {
    const { projectOrders } = await load();
    const view = projectOrders(SERVER, [standOpened(A, IDS.stand5, { lines: [line(L.pkg, IDS.unli, IDS.unliV, 4)] }), linesAdded(A, [line(L.pork, IDS.pork, IDS.porkV, 2)])], SNAPSHOT);
    expect(view.sessions[A].lines.map((l: { id: string; pending: boolean }) => [l.id, l.pending])).toEqual([[L.pkg, false], [L.pork, false]]);
  });

  it('never invents a server fact: events for an unknown table or an unknown line change nothing and do not throw', async () => {
    const { projectOrders } = await load();
    const stranger = id(999);
    const events = [linesAdded(stranger, [line(L.newPork, IDS.pork, IDS.porkV, 1)]), headsSet(stranger, 5), cancelled(id(998))];
    const view = projectOrders(SERVER, events, SNAPSHOT);
    expect(view.tiles.map(tileFields)).toEqual(projectOrders(SERVER, [], SNAPSHOT).tiles.map(tileFields));
    expect(view.sessions[stranger]).toBeUndefined();
    expect(view.sessions[A].lines).toHaveLength(2);
  });

  it('seatStandChoices greys out every stand that has a tile, pending tiles included, and lists the rest in stand order', async () => {
    const { projectOrders, seatStandChoices } = await load();
    const view = projectOrders(SERVER, [standOpened(C, IDS.stand4)], SNAPSHOT);
    expect(seatStandChoices(SNAPSHOT.stands, view.tiles)).toEqual([
      { id: IDS.stand4, number: 4, inUse: true }, // only a PENDING event holds it
      { id: IDS.stand5, number: 5, inUse: true },
      { id: IDS.stand7, number: 7, inUse: true },
    ]);
    const free = seatStandChoices(SNAPSHOT.stands, projectOrders({ openStands: [], sessions: {} }, [], SNAPSHOT).tiles);
    expect(free.map((s: { number: number; inUse: boolean }) => [s.number, s.inUse])).toEqual([[4, false], [5, false], [7, false]]);
  });
});

describe('time seated and the notice for a refused change', () => {
  it('the clock reads like the offline pill and the bar turns to warning only past 1 h 30', async () => {
    const { tileClock } = await load();
    const t0 = Date.parse(T_A);
    expect(tileClock(T_A, t0 + 45 * 60_000)).toEqual({ minutes: 45, label: '45m', warn: false });
    expect(tileClock(T_A, t0 + 89 * 60_000)).toEqual({ minutes: 89, label: '1h 29m', warn: false });
    expect(tileClock(T_A, t0 + 91 * 60_000)).toEqual({ minutes: 91, label: '1h 31m', warn: true });
  });

  it('a quarantined change says which stand, in the one sentence; applied and duplicate results say nothing', async () => {
    const { projectOrders, refusalNotices } = await load();
    const opened = standOpened(C, IDS.stand4);
    const heads = headsSet(A, 1);
    const sent = [opened, heads];
    const view = projectOrders(SERVER, sent, SNAPSHOT);
    const results: PosEventResult[] = [{ seq: opened.seq, status: 'applied' }, { seq: heads.seq, status: 'quarantined', error: 'pos: below senior count' }];
    expect(refusalNotices(sent, results, view)).toEqual(['A change to Stand 5 was refused. A manager will see it.']);
    const refusedOpen: PosEventResult[] = [{ seq: opened.seq, status: 'quarantined' }, { seq: heads.seq, status: 'duplicate' }];
    expect(refusalNotices(sent, refusedOpen, view)).toEqual(['A change to Stand 4 was refused. A manager will see it.']);
    expect(refusalNotices(sent, [{ seq: opened.seq, status: 'applied' }, { seq: heads.seq, status: 'duplicate' }], view)).toEqual([]);
  });
});

