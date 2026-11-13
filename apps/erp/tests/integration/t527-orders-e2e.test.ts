import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-527 (TESTER) - R7 end to end: the events the Orders tab builds, sent through the REAL POST /api/pos/events of a paired tablet, change the real T-524
 * state exactly as the screen expects: seat (package + a la carte) -> add -> heads -> cancel, read back through listOpenStands, getSessionBill, the new
 * GET /api/pos/session/[id] route and the projectOrders reducer. docs/tasks/527-pos-orders-screen.md R7. Real Postgres on a scratch "_test" database (any name).
 *
 * ASSUMED API: seatEvent / addLinesEvent / setHeadsEvent / cancelLineEvent from apps/erp/src/app/pos/_orders/payloads.ts and projectOrders from .../project.ts exactly
 * as documented in t527-orders-payloads.test.ts and t527-orders-project.test.ts. The inbox refuses a key it does not know, so a wrong payload shows up here as a
 * quarantined result, not as a pass.
 *
 * RED NOW FOR THE RIGHT REASON: the _orders modules and the session route do not exist (lazy imports: "MISSING MODULE ... not built").
 */
const state = vi.hoisted(() => ({ cookie: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      for (const part of state.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return { name, value: part.slice(i + 1).trim() };
      }
      return undefined;
    },
    set: () => undefined,
    delete: () => undefined,
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called - the routes must return their own responses');
  },
}));

import { POS_TABLET_COOKIE } from '@shareat/auth';
import { getSessionBill, listOpenStands } from '../../../../packages/domain/src/pos';
import { asOrg, closeAll, ev, fixture, linesAddedPayload, newStand, nowIso, pinSession, RATES, sql, standOpenedPayload, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const SESSION_COOKIE = 'shareat_session';
// biome-ignore lint/suspicious/noExplicitAny: the modules under test do not exist yet; their types are the builder's
async function load(path: string, label: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ path);
  } catch (e) {
    throw new Error(`MISSING MODULE: ${label} cannot be loaded (T-527 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}
const payloads = () => load('../../src/app/pos/_orders/payloads', 'apps/erp/src/app/pos/_orders/payloads.ts');
const projector = () => load('../../src/app/pos/_orders/project', 'apps/erp/src/app/pos/_orders/project.ts');

async function callRoute(path: string, method: 'GET' | 'POST', cookie: string, body?: unknown, ctx?: unknown): Promise<Response> {
  const mod = await load(path, path.replace('../../src/', 'apps/erp/src/') + '.ts');
  state.cookie = cookie;
  const req = new Request('http://localhost:9008/api/pos/x', {
    method,
    headers: { cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return mod[method](req, ctx);
}
const tabletCookie = (f: Fx) => `${POS_TABLET_COOKIE}=${f.pairingToken}`;

describe('fixture sanity (runs now)', () => {
  it('hand-built events of the same shape go through the real route, and the read-backs below see what this file expects (package follows heads, a cancelled line leaves the bill)', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const stand = await newStand(f);
    const sessionId = uuid();
    const [unliLine, porkLine] = [uuid(), uuid()];
    const send = async (events: ReturnType<typeof ev>[]) => {
      const res = await callRoute('../../src/app/api/pos/events/route', 'POST', tabletCookie(f), { pairingId: f.pairingId, events });
      expect(res.status).toBe(200);
      return ((await res.json()) as { results: { status: string }[] }).results.map((r) => r.status);
    };
    expect(await send([
      ev(1, 'stand.opened', f.counterId, { ...standOpenedPayload(sessionId, stand.id, 3), lines: linesAddedPayload(sessionId, [{ lineId: unliLine, item: f.menu.unli, qty: 3 }, { lineId: porkLine, item: f.menu.pork, qty: 1 }]).lines }),
      ev(2, 'heads.set', f.counterId, { sessionId, headsCashier: 4 }),
      ev(3, 'line.cancelled', f.counterId, { lineId: porkLine, reason: 'Wrong item' }),
    ])).toEqual(['applied', 'applied', 'applied']);
    const open = await asOrg(f.orgId, (tx) => listOpenStands(tx, f.counter, { storeId: f.storeId }));
    expect(open.stands).toEqual([expect.objectContaining({ sessionId, standId: stand.id, standNumber: stand.number, headsCashier: 4, headsServer: null })]);
    const lines = (await asOrg(f.orgId, (tx) => getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId }, RATES))).lines;
    expect(lines.map((l) => [l.name, l.kind, l.qty])).toEqual([['Unli Grill', 'package', 4]]);
    expect((await sql<{ kitchen_status: string }[]>`select kitchen_status from table_session_lines where id = ${porkLine}`)[0]!.kitchen_status).toBe('cancelled');
  });
});

describe('the Orders tab\'s events, through the real inbox', () => {
  it('seat (package + a la carte) -> add -> heads -> cancel: every event is applied, and the stand and the bill show exactly what the screen expects', async () => {
    const f = await fixture();
    const { seatEvent, addLinesEvent, setHeadsEvent, cancelLineEvent } = await payloads();
    const session = await pinSession(f, f.counterId);
    const stand = await newStand(f);

    // the menu the tablet holds: the real snapshot route (device cookie only)
    const snap = await callRoute('../../src/app/api/pos/snapshot/route', 'GET', tabletCookie(f));
    expect(snap.status).toBe(200);
    const snapshot = (await snap.json()) as { menu: unknown; stands: { id: string; number: number }[] };
    expect(snapshot.stands.map((s) => s.id)).toContain(stand.id);

    const ids: string[] = [];
    const newId = () => {
      const x = uuid();
      ids.push(x);
      return x;
    };
    const at = new Date();
    const post = async (seq: number, ev: { kind: string; personId: string; occurredAtDevice: string; payload: unknown }) => {
      const res = await callRoute('../../src/app/api/pos/events/route', 'POST', tabletCookie(f), { pairingId: f.pairingId, events: [{ seq, ...ev }] });
      expect(res.status).toBe(200);
      const j = (await res.json()) as { results: { seq: number; status: string; error?: string }[] };
      expect(j.results, `event ${seq} (${ev.kind})`).toEqual([{ seq, status: 'applied' }]);
    };
    const stands = () => asOrg(f.orgId, (tx) => listOpenStands(tx, f.counter, { storeId: f.storeId }));
    const bill = (sessionId: string) => asOrg(f.orgId, (tx) => getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId }, RATES));

    // 1. seat: Unli Grill x 3 heads + one Pork belly
    const seat = seatEvent({
      personId: f.counterId, standId: stand.id, heads: 3, now: at, menu: snapshot.menu, newId,
      cart: [{ itemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 1 }, { itemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1 }],
    });
    const sessionId = (seat.payload as { sessionId: string }).sessionId;
    const [unliLineId, porkLineId] = (seat.payload as { lines: { lineId: string }[] }).lines.map((l) => l.lineId) as [string, string];
    await post(1, seat);
    expect((await stands()).stands).toEqual([
      expect.objectContaining({ sessionId, standId: stand.id, standNumber: stand.number, mode: 'dine_in', headsCashier: 3, headsServer: null }),
    ]);
    let lines = (await bill(sessionId)).lines;
    expect(lines.find((l) => l.name === 'Unli Grill')).toMatchObject({ id: unliLineId, kind: 'package', qty: 3, kitchenStatus: 'queued' });
    expect(lines.find((l) => l.name === 'Pork belly')).toMatchObject({ id: porkLineId, kind: 'item', qty: 1, kitchenStatus: 'queued' });

    // 2. add: two Cola
    const add = addLinesEvent({ personId: f.counterId, sessionId, heads: 3, now: at, menu: snapshot.menu, newId, cart: [{ itemId: f.menu.cola.itemId, variantId: f.menu.cola.variantId, qty: 2 }] });
    await post(2, add);
    lines = (await bill(sessionId)).lines;
    expect(lines.find((l) => l.name === 'Cola')).toMatchObject({ kind: 'item', qty: 2 });
    expect(lines).toHaveLength(3);

    // 3. heads 3 -> 4: the table shows 4, and the package follows the heads
    await post(3, setHeadsEvent({ personId: f.counterId, sessionId, heads: 4, now: at }));
    expect((await stands()).stands[0]).toMatchObject({ sessionId, headsCashier: 4, headsServer: null });
    lines = (await bill(sessionId)).lines;
    expect(lines.filter((l) => l.kind === 'package').reduce((n, l) => n + l.qty, 0)).toBe(4);

    // 4. cancel the pork: gone from the live bill, 'cancelled' in the database, the other lines untouched
    await post(4, cancelLineEvent({ personId: f.counterId, lineId: porkLineId, reason: 'Wrong item', now: at }));
    lines = (await bill(sessionId)).lines;
    expect(lines.map((l) => l.name).sort()).toEqual(['Cola', 'Unli Grill']);
    expect((await sql<{ kitchen_status: string }[]>`select kitchen_status from table_session_lines where id = ${porkLineId}`)[0]!.kitchen_status).toBe('cancelled');
    expect((await stands()).stands).toHaveLength(1);

    // 5. the read route the tablet polls and the reducer the screen draws from agree with all of that
    const route = await callRoute('../../src/app/api/pos/session/[sessionId]/route', 'GET', `${tabletCookie(f)}; ${SESSION_COOKIE}=${session}`, undefined, { params: Promise.resolve({ sessionId }) });
    expect(route.status).toBe(200);
    const body = await route.json();
    expect(body.lines.map((l: { name: string }) => l.name).sort()).toEqual(['Cola', 'Unli Grill']);
    const { projectOrders } = await projector();
    const view = projectOrders({ openStands: (await stands()).stands, sessions: { [sessionId]: body } }, [], { stands: snapshot.stands, menu: snapshot.menu });
    expect(view.tiles).toHaveLength(1);
    expect(view.tiles[0]).toMatchObject({ sessionId, standNumber: stand.number, headsCashier: 4, headsServer: null, packageName: 'Unli Grill', needsHeads: true, pending: false });
    expect(view.sessions[sessionId].lines.map((l: { name: string; pending: boolean; cancelled: boolean }) => [l.name, l.pending, l.cancelled]).sort()).toEqual([['Cola', false, false], ['Unli Grill', false, false]]);
  });

  it('take-out opens a session with no stand, and sending the same event again is a duplicate, not a second table', async () => {
    const f = await fixture();
    const { takeOutEvent } = await payloads();
    await pinSession(f, f.counterId);
    const snap = await callRoute('../../src/app/api/pos/snapshot/route', 'GET', tabletCookie(f));
    const snapshot = (await snap.json()) as { menu: unknown };
    const event = takeOutEvent({ personId: f.counterId, name: 'Ana', now: new Date(), menu: snapshot.menu, newId: uuid, cart: [{ itemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 2 }] });
    const send = async (seq: number) =>
      ((await (await callRoute('../../src/app/api/pos/events/route', 'POST', tabletCookie(f), { pairingId: f.pairingId, events: [{ seq, ...event }] })).json()) as { results: { status: string; error?: string }[] }).results[0]!;
    expect(await send(1)).toMatchObject({ status: 'applied' });
    expect(await send(1)).toMatchObject({ status: 'duplicate' });
    const open = await asOrg(f.orgId, (tx) => listOpenStands(tx, f.counter, { storeId: f.storeId }));
    expect(open.stands).toEqual([expect.objectContaining({ mode: 'take_out', standId: null, headsCashier: 0 })]);
    const sessionId = (event.payload as { sessionId: string }).sessionId;
    const lines = (await asOrg(f.orgId, (tx) => getSessionBill(tx, f.counter, { storeId: f.storeId, sessionId }, RATES))).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'Pork belly', qty: 2 });
  });
});
