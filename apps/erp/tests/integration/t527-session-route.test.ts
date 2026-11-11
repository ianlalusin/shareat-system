import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-527 (TESTER) - R1: GET /api/pos/session/[sessionId], called as a route would be (a real Request with real cookies into the exported GET of
 * apps/erp/src/app/api/pos/session/[sessionId]/route.ts). docs/tasks/527-pos-orders-screen.md R1 and the Addendum. Real Postgres on a scratch "_test" database
 * (any name). Same harness as t525-pos-routes.test.ts: only `next/headers` is mocked, `lib/session` runs for real.
 *
 * ASSUMED CONTRACT (the builder matches these or says why not):
 *   handler: `GET(req: Request, ctx: { params: Promise<{ sessionId: string }> })` (the Next 15+ shape). Needs a person session (401 if none: a tablet cookie alone is not one).
 *   The store is `effectiveStore(pairing, ?storeId)` (T-526 lib.ts): a paired tablet's own store always wins and a DIFFERENT ?storeId is 403; no pairing uses ?storeId.
 *   Capability record_sale at that store (403 without it, and 403 for a store the person does not work at). An unknown session id is 404 (the domain's "gone" is NOT a 409 here).
 *   Failures are `{ ok: false, error: "<one sentence>" }` with `cache-control: no-store`. The 200 is `{ ok: true, session, lines }` (+ `stateVersion`), `no-store`,
 *   and carries NO pricing anywhere (no `pricing`, `subtotal`, `discountTotal`, `total`, `gross` or `net` key at any depth): pricing is T-528's to show.
 *   `session` = { id, mode, standId, status, headsCashier, headsServer }; each line = { id, kind, name, qty, unitPrice, kitchenStatus, bundleHeads, discounts }.
 *
 * RED NOW FOR THE RIGHT REASON: the route file does not exist. It is loaded lazily, so each case fails "MISSING MODULE ... not built" AFTER its fixture ran.
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
    throw new Error('notFound() called - the route must return its own responses');
  },
}));

import { POS_TABLET_COOKIE } from '@shareat/auth';
import { openStand, addLines } from '../../../../packages/domain/src/pos';
import { asOrg, closeAll, fixture, newStand, nowIso, pinSession, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const ROUTE = '../../src/app/api/pos/session/[sessionId]/route';
const SESSION_COOKIE = 'shareat_session';

async function get(sessionId: string, o: { query?: string; cookies?: Record<string, string | undefined> } = {}): Promise<Response> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ ROUTE);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/api/pos/session/[sessionId]/route.ts cannot be loaded (T-527 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
  if (typeof mod.GET !== 'function') throw new Error('MISSING EXPORT: apps/erp/src/app/api/pos/session/[sessionId]/route.ts does not export GET (T-527 not built).');
  const cookie = Object.entries(o.cookies ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; ');
  state.cookie = cookie;
  const req = new Request(`http://localhost:9008/api/pos/session/${sessionId}${o.query ?? ''}`, { method: 'GET', headers: cookie ? { cookie } : {} });
  return (mod.GET as (r: Request, c: { params: Promise<{ sessionId: string }> }) => Promise<Response>)(req, { params: Promise.resolve({ sessionId }) });
}
const tablet = (f: Fx) => ({ [POS_TABLET_COOKIE]: f.pairingToken });
const noStore = (res: Response) => expect(res.headers.get('cache-control') ?? '').toContain('no-store');
async function expectFailure(res: Response, status: number) {
  expect(res.status).toBe(status);
  noStore(res);
  const j = (await res.json()) as { ok: boolean; error: string };
  expect(j.ok).toBe(false);
  expect(typeof j.error).toBe('string');
  expect(j.error.length).toBeGreaterThan(10);
  expect(j.error, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  return j;
}
const keysDeep = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
};

/** A table seated through T-524 directly with one pork belly line. */
async function openTable(f: Fx, heads = 2) {
  const st = await newStand(f);
  const sessionId = uuid();
  const lineId = uuid();
  const base = { storeId: f.storeId, pairingId: f.pairingId };
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: st.id, headsCashier: heads, openedAtDevice: nowIso() });
    await addLines(tx, f.counter, { ...base, sessionId, lines: [{ lineId, menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1, addedAtDevice: nowIso() }] });
  });
  return { sessionId, lineId, standId: st.id };
}

describe('GET /api/pos/session/[sessionId]', () => {
  it('a cashier with record_sale on the paired tablet gets 200 with the table and its lines, and no pricing anywhere', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    const t = await openTable(f, 3);
    const res = await get(t.sessionId, { cookies: { ...tablet(f), [SESSION_COOKIE]: session } });
    expect(res.status).toBe(200);
    noStore(res);
    const j = (await res.json()) as Record<string, unknown> & { session: Record<string, unknown>; lines: Record<string, unknown>[] };
    expect(j.ok).toBe(true);
    expect(j.session).toEqual({ id: t.sessionId, mode: 'dine_in', standId: t.standId, status: 'open', headsCashier: 3, headsServer: null });
    expect(j.lines).toHaveLength(1);
    expect(j.lines[0]).toMatchObject({ id: t.lineId, kind: 'item', name: 'Pork belly', qty: 1, kitchenStatus: 'queued', bundleHeads: null });
    expect(Number(j.lines[0]!.unitPrice)).toBe(250);
    expect(Object.keys(j)).not.toContain('pricing');
    const keys = keysDeep(j);
    for (const forbidden of ['pricing', 'subtotal', 'discountTotal', 'total', 'gross', 'net']) expect(keys, `no ${forbidden} key at any depth`).not.toContain(forbidden);
  });

  it('a cancelled line is no longer in the body (the table shows what is live)', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    const t = await openTable(f);
    const { cancelLine } = await import('../../../../packages/domain/src/pos');
    await asOrg(f.orgId, (tx) => cancelLine(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, lineId: t.lineId, reason: 'Wrong item' }));
    const res = await get(t.sessionId, { cookies: { ...tablet(f), [SESSION_COOKIE]: session } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lines: unknown[] }).lines).toEqual([]);
  });

  it('a phone with no tablet cookie names its store with ?storeId and gets 200 when it holds record_sale there', async () => {
    const f = await fixture();
    const admin = await pinSession(f, f.adminId);
    const t = await openTable(f);
    const res = await get(t.sessionId, { query: `?storeId=${f.storeId}`, cookies: { [SESSION_COOKIE]: admin } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { session: { id: string } }).session.id).toBe(t.sessionId);
  });

  it('no session is 401, and a tablet cookie alone is not a session', async () => {
    const f = await fixture();
    const t = await openTable(f);
    await expectFailure(await get(t.sessionId), 401);
    await expectFailure(await get(t.sessionId, { cookies: tablet(f) }), 401);
    await expectFailure(await get(t.sessionId, { cookies: { [SESSION_COOKIE]: 'x'.repeat(43) } }), 401);
  });

  it('403 for another store: a person who does not work at the requested store, and a paired tablet pointed at a different ?storeId (the pairing wins)', async () => {
    const f = await fixture();
    const counter = await pinSession(f, f.counterId);
    const t = await openTable(f);
    // 1. no pairing: the cashier asks for store B, where she has no scope
    await expectFailure(await get(t.sessionId, { query: `?storeId=${f.store2Id}`, cookies: { [SESSION_COOKIE]: counter } }), 403);
    // 2. paired to store A, the URL says store B: refused, never silently answered from A and never from B
    await expectFailure(await get(t.sessionId, { query: `?storeId=${f.store2Id}`, cookies: { ...tablet(f), [SESSION_COOKIE]: counter } }), 403);
    // control: the pairing's own store in the URL (any letter case) is fine
    const same = await get(t.sessionId, { query: `?storeId=${f.storeId.toUpperCase()}`, cookies: { ...tablet(f), [SESSION_COOKIE]: counter } });
    expect(same.status).toBe(200);
  });

  it('403 for a person at this store who lacks record_sale (kitchen holds serve_pos_ticket only)', async () => {
    const f = await fixture();
    const kitchen = await pinSession(f, f.kitchenId);
    const t = await openTable(f);
    await expectFailure(await get(t.sessionId, { cookies: { ...tablet(f), [SESSION_COOKIE]: kitchen } }), 403);
  });

  it('a table id that is not even a UUID is the same 404 as an unknown one (planner ruling 6)', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    await openTable(f);
    const cookies = { ...tablet(f), [SESSION_COOKIE]: session };
    const unknown = await expectFailure(await get(uuid(), { cookies }), 404);
    const malformed = await expectFailure(await get('not-a-table', { cookies }), 404);
    expect(malformed.error).toBe(unknown.error);
  });

  it('404 for a table id the store does not know (not 409, not 500)', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    await openTable(f);
    await expectFailure(await get(uuid(), { cookies: { ...tablet(f), [SESSION_COOKIE]: session } }), 404);
  });
});
