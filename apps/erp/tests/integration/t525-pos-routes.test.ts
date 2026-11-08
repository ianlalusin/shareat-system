import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-525 (TESTER) - the three POS v2 doors, called as a route would be: a real `Request` with real cookies into the exported GET / POST of
 * apps/erp/src/app/api/pos/{events,snapshot,state}/route.ts. docs/tasks/525-pos-v2-apis.md R1, R2, R7, R8, R10.
 * Real Postgres on a scratch "_test" database (any name). The domain cases are in packages/domain/tests/integration/t525-pos-inbox.test.ts.
 *
 * HOW THE ROUTES ARE REACHED: `lib/session` is NOT mocked. Only `next/headers` is: its `cookies()` reads the Cookie header of the Request being called
 * (so `readPosTabletToken` and `currentSession` run for real, against real pairings and real session rows). The routes must read cookies through
 * `readPosTabletToken()` / `currentSession()` (R1) and everything else from the `Request` they are handed.
 *
 * ASSUMED CONTRACT (the builder matches these or says why not):
 *   Every answer is JSON `{ ok, ... }` with `cache-control` containing `no-store`, EXCEPT the snapshot's 200/304 (`private, no-cache`, R7).
 *   Failures are `{ ok: false, error: "<one sentence>" }`. The snapshot's 200 is `{ ok: true, store, menu, stands, tenders, discountPresets, rules, staff, device, businessDate }`
 *   (the nine R7 keys at the top level beside `ok`) with an `etag` header of the form "<64 hex>" and `x-next-change-at` when the menu has a next change.
 *   The state route reads `since` and `storeId` from the query string, `stationId` for the kitchen queue; its 200 is `{ ok:true, stateVersion, openStands, kitchenQueue, refillQueue }`
 *   where a read the person may not do is `null`. The three reads are gated by record_sale (openStands), serve_pos_ticket (kitchenQueue), request_pos_refill (refillQueue).
 *   403 beats 304 on the state route: store scope is checked BEFORE the cheap state_version comparison (so a 304 never confirms another store's version).
 *
 * RED NOW FOR THE RIGHT REASON: the three route files do not exist. They are loaded lazily, so each case fails "MISSING MODULE ... not built" AFTER its
 * fixture ran. The "fixture sanity" cases run for real.
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

import { posV2Repo } from '@shareat/db';
import { POS_TABLET_COOKIE } from '@shareat/auth';
import { openStand, addLines } from '../../../../packages/domain/src/pos';
import {
  asOrg, closeAll, counts, ev, eventsOf, fixture, newStand, nowIso, pinSession, plainDay, receiptOfSession, seniorDay, sql, standOpenedPayload, stateVersionOf, uuid,
  type Ev, type Fx,
} from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';
import { insOffer } from '../../../../packages/db/tests/integration/_fixtures/t401-menu';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

// ------------------------------------------------------------------------------------------------------------------------------
// Calling a route
// ------------------------------------------------------------------------------------------------------------------------------
const ROUTES = {
  events: '../../src/app/api/pos/events/route',
  snapshot: '../../src/app/api/pos/snapshot/route',
  state: '../../src/app/api/pos/state/route',
} as const;
type Route = keyof typeof ROUTES;
const SESSION_COOKIE = 'shareat_session';
const UNPAIRED = 'This tablet is not paired. Ask a manager to pair it again.';
const NOT_ON = 'The POS is not switched on for this store.';

interface Call {
  query?: string;
  /** cookie name -> value */
  cookies?: Record<string, string | undefined>;
  /** undefined = application/json; null = no content-type header at all */
  contentType?: string | null;
  body?: string;
  headers?: Record<string, string>;
}
async function call(route: Route, method: 'GET' | 'POST', o: Call = {}): Promise<Response> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ ROUTES[route]);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/api/pos/${route}/route.ts cannot be loaded (T-525 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
  const handler = mod[method];
  if (typeof handler !== 'function') throw new Error(`MISSING EXPORT: apps/erp/src/app/api/pos/${route}/route.ts does not export ${method} (T-525 not built).`);
  const cookie = Object.entries(o.cookies ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; ');
  state.cookie = cookie;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...o.headers };
  if (method === 'POST' && o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
  const req = new Request(`http://localhost:9008/api/pos/${route}${o.query ?? ''}`, { method, headers, ...(o.body !== undefined ? { body: o.body } : {}) });
  return (handler as (r: Request) => Promise<Response>)(req);
}
const tablet = (f: Fx) => ({ [POS_TABLET_COOKIE]: f.pairingToken });
const post = (f: Fx, events: unknown, o: Call = {}) => call('events', 'POST', { cookies: tablet(f), body: JSON.stringify({ events }), ...o });
const noStore = (res: Response) => expect(res.headers.get('cache-control') ?? '').toContain('no-store');
async function expectFailure(res: Response, status: number, error?: string) {
  expect(res.status).toBe(status);
  const j = (await res.json()) as { ok: boolean; error: string };
  expect(j.ok).toBe(false);
  expect(typeof j.error).toBe('string');
  expect(j.error.length).toBeGreaterThan(10);
  expect(j.error, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  if (error !== undefined) expect(j.error).toBe(error);
  return j;
}
/** A well-formed event of a kind the server does not know: it is stored quarantined, so it exercises the inbox without a domain call. */
const unknownEvent = (f: Fx, seq: number, payload: Record<string, unknown> = {}): Ev => ev(seq, 'table.teleported', f.counterId, payload);

// ==============================================================================================================================
describe('fixture sanity (runs now)', () => {
  it('real pairing tokens resolve, and a real session token resolves, through the real lib/session with the mocked cookie jar', async () => {
    const f = await fixture();
    const token = await pinSession(f, f.counterId);
    state.cookie = `${POS_TABLET_COOKIE}=${f.pairingToken}; ${SESSION_COOKIE}=${token}`;
    const { readPosTabletToken, currentSession } = await import('../../src/lib/session');
    expect(await readPosTabletToken()).toBe(f.pairingToken);
    const s = await currentSession();
    expect(s?.actor).toEqual({ personId: f.counterId, orgId: f.orgId });
    state.cookie = `${POS_TABLET_COOKIE}=${f.pairingRevokedToken}`;
    expect(await currentSession(), 'no person session cookie, no session').toBeNull();
  });

  it('the repo read spies work: vi.spyOn on posV2Repo sees the T-524 reads the state route will call', async () => {
    const f = await fixture();
    const spy = vi.spyOn(posV2Repo, 'listOpenSessionsWithStand');
    const { listOpenStands } = await import('../../../../packages/domain/src/pos');
    await asOrg(f.orgId, (tx) => listOpenStands(tx, f.admin, { storeId: f.storeId }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ==============================================================================================================================
describe('POST /api/pos/events - the envelope (R2)', () => {
  it('no cookie, a forged cookie and a revoked pairing are all 401 with the one sentence; nothing is written', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const day = plainDay(f);
    for (const cookies of [{}, { [POS_TABLET_COOKIE]: 'A'.repeat(43) }, { [POS_TABLET_COOKIE]: f.pairingRevokedToken }]) {
      const res = await call('events', 'POST', { cookies, body: JSON.stringify({ events: day.events }) });
      await expectFailure(res, 401, UNPAIRED);
      noStore(res);
    }
    expect(await counts(f)).toMatchObject({ events: 0, receipts: 0, sessions: 0 });
  });

  it('a person session cookie is NOT enough (the device is the credential) and is NOT required (the event names its person)', async () => {
    const f = await fixture();
    const tokens = { counter: await pinSession(f, f.counterId) };
    const day = plainDay(f);
    await expectFailure(await call('events', 'POST', { cookies: { [SESSION_COOKIE]: tokens.counter }, body: JSON.stringify({ events: day.events }) }), 401, UNPAIRED);
    const ok = await post(f, day.events); // tablet cookie only, no shareat_session
    expect(ok.status).toBe(200);
  });

  it('a body that is not application/json is 415 (text/plain, form posts, no content-type); application/json with a charset is accepted; nothing is processed on a 415', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const body = JSON.stringify({ events: plainDay(f).events });
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
      const res = await call('events', 'POST', { cookies: tablet(f), body, contentType });
      await expectFailure(res, 415);
      noStore(res);
    }
    expect(await counts(f)).toMatchObject({ events: 0, sessions: 0 });
    const res = await call('events', 'POST', { cookies: tablet(f), body, contentType: 'application/json; charset=utf-8' });
    expect(res.status).toBe(200);
    expect((await counts(f)).events).toBe(3);
  });

  it('1 to 100 events per batch: 101 and 0 are 400, 100 is accepted; nothing is processed on a 400', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const many = (n: number) => Array.from({ length: n }, (_, i) => unknownEvent(f, i + 1));
    await expectFailure(await post(f, many(101)), 400);
    await expectFailure(await post(f, []), 400);
    expect((await counts(f)).events, 'a 400 processes nothing, not even the first 100').toBe(0);
    const res = await post(f, many(100));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; results: { seq: number; status: string }[] };
    expect(j.results).toHaveLength(100);
    expect(j.results.every((r) => r.status === 'quarantined')).toBe(true);
    expect((await counts(f)).events).toBe(100);
  });

  it('a malformed envelope is 400 with the first problem in one sentence, and nothing is processed', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const good = unknownEvent(f, 1);
    const bad: [string, string][] = [
      ['not json', '{"events": [ '],
      ['events is not a list', JSON.stringify({ events: 'nope' })],
      ['no events key', JSON.stringify({})],
      ['seq is 0', JSON.stringify({ events: [{ ...good, seq: 0 }] })],
      ['seq is negative', JSON.stringify({ events: [{ ...good, seq: -3 }] })],
      ['seq is fractional', JSON.stringify({ events: [{ ...good, seq: 1.5 }] })],
      ['seq is text', JSON.stringify({ events: [{ ...good, seq: '1' }] })],
      ['kind missing', JSON.stringify({ events: [{ ...good, kind: undefined }] })],
      ['kind has the wrong shape', JSON.stringify({ events: [{ ...good, kind: 'DROP TABLE' }] })],
      ['personId is not a uuid', JSON.stringify({ events: [{ ...good, personId: 'cara' }] })],
      ['occurredAtDevice is not a time', JSON.stringify({ events: [{ ...good, occurredAtDevice: 'yesterday' }] })],
      ['payload is a list', JSON.stringify({ events: [{ ...good, payload: [] }] })],
      ['payload is null', JSON.stringify({ events: [{ ...good, payload: null }] })],
      ['second event is the bad one', JSON.stringify({ events: [good, { ...good, seq: 2, personId: 'cara' }] })],
    ];
    for (const [label, body] of bad) {
      const res = await call('events', 'POST', { cookies: tablet(f), body });
      await expectFailure(res, 400);
      noStore(res);
      expect((await counts(f)).events, `${label}: nothing processed, not even the good first event`).toBe(0);
    }
  });

  it('a body over 512 KB is 413 and nothing is processed; a 100 KB event is fine', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const big = JSON.stringify({ events: [unknownEvent(f, 1, { pad: 'x'.repeat(600 * 1024) })] });
    expect(big.length).toBeGreaterThan(512 * 1024);
    const res = await call('events', 'POST', { cookies: tablet(f), body: big });
    await expectFailure(res, 413);
    noStore(res);
    expect((await counts(f)).events).toBe(0);
    const small = await post(f, [unknownEvent(f, 1, { pad: 'x'.repeat(100 * 1024) })]);
    expect(small.status).toBe(200);
    expect((await counts(f)).events).toBe(1);
  });

  it('store mode off is 409 and nothing is processed (the device keeps its outbox); so is a store with no pos_stores row; the same batch is fine when the store is on', async () => {
    const off = await fixture('off');
    await pinSession(off, off.counterId);
    const day = plainDay(off);
    const res = await post(off, day.events);
    await expectFailure(res, 409, NOT_ON);
    noStore(res);
    expect(await counts(off)).toMatchObject({ events: 0, sessions: 0, receipts: 0 });

    const f = await fixture();
    await pinSession(f, f.counterId);
    // store B has a live pairing but no pos_stores row at all
    const none = await call('events', 'POST', { cookies: { [POS_TABLET_COOKIE]: f.pairingBToken }, body: JSON.stringify({ events: [unknownEvent(f, 1)] }) });
    await expectFailure(none, 409, NOT_ON);
    expect(await counts(f)).toMatchObject({ events: 0 });

    expect((await post(f, plainDay(f).events)).status).toBe(200);
  });

  it('the happy path end to end: 200 {ok, stateVersion, results} from the real inbox, the receipt exists, the answer is no-store', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const day = plainDay(f);
    const res = await post(f, day.events);
    expect(res.status).toBe(200);
    noStore(res);
    const j = (await res.json()) as { ok: boolean; stateVersion: number; results: { seq: number; status: string }[] };
    expect(j.ok).toBe(true);
    expect(j.results).toEqual([{ seq: 1, status: 'applied' }, { seq: 2, status: 'applied' }, { seq: 3, status: 'applied' }]);
    expect(j.stateVersion).toBe(await stateVersionOf(f));
    expect(j.stateVersion).toBeGreaterThan(0);
    expect((await receiptOfSession(day.sessionId))?.id).toBe(day.receiptId);
    const again = (await (await post(f, day.events)).json()) as { results: { status: string }[] };
    expect(again.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect((await counts(f)).receipts).toBe(1);
  });

  it('T-539 S2 end to end: a senior sale.completed through the real route with NO injected reader is priced from the database rules (12% VAT, 20%): receipt, statutory row, no mismatch row', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const day = seniorDay(f);
    // The tablet's own figures for pork 250.00 x 2 with one senior on one: VAT 26.79 + 20% of 223.21 (44.64) = 71.43 off (the statutory row keeps the whole 71.43).
    const sale = day.events[3]!;
    sale.payload = { ...sale.payload, device: { subtotal: '500.00', discountTotal: '71.43', total: '428.57', lines: [{ lineId: day.porkLineId, gross: '500.00', discountTotal: '71.43', net: '428.57' }] } };
    const res = await post(f, day.events);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { results: { seq: number; status: string }[] };
    expect(j.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(await receiptOfSession(day.sessionId)).toMatchObject({ id: day.receiptId, total: '428.57' });
    const rec = await sql`select kind, source, gross_amount::text, discount_amount::text from statutory_discount_records where org_id = ${f.orgId}`;
    expect(rec).toEqual([{ kind: 'senior', source: 'pos', gross_amount: '250.00', discount_amount: '71.43' }]);
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'pos.sale_recompute_mismatch'`).toHaveLength(0);
  });

  it('the pairing is the only source of store and pairing: a payload that names another store is quarantined and writes nothing anywhere', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const sessionId = uuid();
    const res = await post(f, [ev(1, 'stand.opened', f.counterId, { ...standOpenedPayload(sessionId, f.stand7), storeId: f.store2Id })]);
    const j = (await res.json()) as { results: { status: string; error?: string }[] };
    expect(j.results[0]!.status).toBe('quarantined');
    expect(j.results[0]!.error!.startsWith('POS_EVENT_INVALID: ')).toBe(true);
    expect(await counts(f)).toMatchObject({ sessions: 0 });
    const rows = await eventsOf(f);
    expect(rows).toHaveLength(1);
  });
});

// ==============================================================================================================================
describe('GET /api/pos/snapshot (R7)', () => {
  const get = (f: Fx, o: Call = {}) => call('snapshot', 'GET', { cookies: tablet(f), ...o });
  const NINE = ['businessDate', 'device', 'discountPresets', 'menu', 'rules', 'staff', 'stands', 'store', 'tenders'];
  const keysDeep = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
    return out;
  };

  it('no cookie, a forged cookie and a revoked pairing are 401; a person session alone is 401 too (the staff list is needed BEFORE anyone signs in, so only the device counts)', async () => {
    const f = await fixture();
    const token = await pinSession(f, f.counterId);
    for (const cookies of [{}, { [POS_TABLET_COOKIE]: 'A'.repeat(43) }, { [POS_TABLET_COOKIE]: f.pairingRevokedToken }, { [SESSION_COOKIE]: token }]) {
      const res = await call('snapshot', 'GET', { cookies });
      await expectFailure(res, 401, UNPAIRED);
    }
  });

  it('store mode off is 409, and so is a store with no pos_stores row', async () => {
    const off = await fixture('off');
    await expectFailure(await get(off), 409, NOT_ON);
    const f = await fixture();
    await expectFailure(await call('snapshot', 'GET', { cookies: { [POS_TABLET_COOKIE]: f.pairingBToken } }), 409, NOT_ON);
  });

  it('200 with exactly the nine R7 keys beside ok, with no person session needed; no key in the staff list looks like PIN material', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId); // gives the counter a PIN credential whose hashes must not appear
    const res = await get(f);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(Object.keys(j).filter((k) => k !== 'ok').sort()).toEqual(NINE);
    expect(res.headers.get('etag') ?? '').toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers.get('cache-control') ?? '').toContain('private');
    expect(res.headers.get('cache-control') ?? '').toContain('no-cache');
    expect(res.headers.get('cache-control') ?? '').not.toContain('public');
    expect(keysDeep(j.staff).filter((k) => /pin|hash|secret|salt/i.test(k))).toEqual([]);
    expect((j.store as { terminalNo: number }).terminalNo).toBe(1);
    expect(Number((j.rules as { vatPercentBasisPoints?: unknown } | undefined)?.vatPercentBasisPoints ?? NaN)).not.toBeNaN();
    const creds = await sql<{ secret_hash: string; lookup_hash: string }[]>`select secret_hash, lookup_hash from person_credentials where person_id = ${f.counterId} and kind = 'pin'`;
    const text = JSON.stringify(j);
    for (const c of creds) {
      expect(text).not.toContain(c.secret_hash);
      expect(text).not.toContain(c.lookup_hash);
    }
  });

  it('a second GET with the ETag is 304 with no body; a wrong ETag is 200; a price change gives a new ETag and the old one no longer matches', async () => {
    const f = await fixture();
    const first = await get(f);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const same = await get(f, { headers: { 'if-none-match': etag } });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe('');
    expect(same.headers.get('cache-control') ?? '').toContain('no-cache');

    expect((await get(f, { headers: { 'if-none-match': '"0000000000000000000000000000000000000000000000000000000000000000"' } })).status).toBe(200);

    await insOffer(f, f.menu.pork.variantId, '275.00');
    const changed = await get(f, { headers: { 'if-none-match': etag } });
    expect(changed.status, 'the old ETag no longer matches after a price change').toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('rules: with no reader injected (the production path) the snapshot carries the real rule values: registry defaults on a fresh org (T-539 S2)', async () => {
    const f = await fixture();
    const res = await get(f);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { rules: { vatPercentBasisPoints: number | string; scPwdPercentBasisPoints: number | string; businessDayStartHour: number } };
    expect([Number(j.rules.vatPercentBasisPoints), Number(j.rules.scPwdPercentBasisPoints), j.rules.businessDayStartHour]).toEqual([1200, 2000, 4]);
  });

  it('no terminal row for this pairing is 409 "This tablet has no till number yet. Ask a manager."', async () => {
    const f = await fixture();
    await sql`delete from pos_terminals where pairing_id = ${f.pairingId}`;
    await expectFailure(await get(f), 409, 'This tablet has no till number yet. Ask a manager.');
  });

  it('lastSeq and lastTerminalSeq are right after a sale taken through the events route', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const day = plainDay(f);
    expect((await post(f, [...day.events, unknownEvent(f, 4)])).status).toBe(200);
    const j = (await (await get(f)).json()) as { device: { pairingId: string; lastSeq: number; lastTerminalSeq: number } };
    expect(j.device).toEqual({ pairingId: f.pairingId, lastSeq: 4, lastTerminalSeq: day.terminalSeq });
  });
});

// ==============================================================================================================================
describe('GET /api/pos/state?since=N (R8)', () => {
  const getState = (f: Fx, session: string | null, o: { query?: string; withTablet?: boolean } = {}) =>
    call('state', 'GET', { query: o.query ?? '', cookies: { ...(o.withTablet === false ? {} : tablet(f)), ...(session ? { [SESSION_COOKIE]: session } : {}) } });
  /** A table opened and a pork line added through T-524 directly (each call bumps the state version once). */
  async function openTable(f: Fx) {
    const st = await newStand(f);
    const sessionId = uuid();
    const lineId = uuid();
    const base = { storeId: f.storeId, pairingId: f.pairingId };
    await asOrg(f.orgId, async (tx) => {
      await openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 2, openedAtDevice: nowIso() });
    });
    const afterOpen = await stateVersionOf(f);
    await asOrg(f.orgId, async (tx) => {
      await addLines(tx, f.counter, { ...base, sessionId, lines: [{ lineId, menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 1, addedAtDevice: nowIso() }] });
    });
    return { sessionId, lineId, afterOpen };
  }
  const spies = () => ({
    stands: vi.spyOn(posV2Repo, 'listOpenSessionsWithStand'),
    queue: vi.spyOn(posV2Repo, 'listQueuedLines'),
  });

  it('no session is 401, and a tablet cookie alone is not a session', async () => {
    const f = await fixture();
    await expectFailure(await getState(f, null, { withTablet: false }), 401);
    await expectFailure(await getState(f, null), 401);
    await expectFailure(await call('state', 'GET', { cookies: { [SESSION_COOKIE]: 'x'.repeat(43) } }), 401);
  });

  it('since equal to the store\'s version is 304 with no body and NO list query runs; one behind is 200 and the lists are read', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    await openTable(f);
    const v = await stateVersionOf(f);
    expect(v).toBeGreaterThanOrEqual(2);
    const s = spies();

    const hit = await getState(f, session, { query: `?since=${v}` });
    expect(hit.status).toBe(304);
    expect(await hit.text()).toBe('');
    expect(s.stands, 'the cheap path runs no list query').not.toHaveBeenCalled();
    expect(s.queue).not.toHaveBeenCalled();

    const miss = await getState(f, session, { query: `?since=${v - 1}` });
    expect(miss.status).toBe(200);
    noStore(miss);
    const j = (await miss.json()) as { ok: boolean; stateVersion: number };
    expect(j.ok).toBe(true);
    expect(j.stateVersion).toBe(v);
    expect(s.stands, 'the 200 path does read').toHaveBeenCalled();
  });

  it('since missing, not a number, negative or fractional is treated as -1: always 200, even when the store\'s version is 0', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    expect(await stateVersionOf(f)).toBe(0);
    for (const q of ['', '?since=', '?since=abc', '?since=-5', '?since=1.5', '?since=0x10']) {
      const res = await getState(f, session, { query: q });
      expect(res.status, q || '(none)').toBe(200);
    }
    const hit = await getState(f, session, { query: '?since=0' });
    expect(hit.status, 'a real match is still 304').toBe(304);
  });

  it('after lines.added: 200 with the NEW version; a cashier gets the open stands and null for the kitchen and refill queues', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    const t = await openTable(f);
    const before = t.afterOpen;
    const res = await getState(f, session, { query: `?since=${before}` });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { stateVersion: number; openStands: unknown; kitchenQueue: unknown; refillQueue: unknown };
    expect(j.stateVersion).toBeGreaterThan(before);
    expect(j.stateVersion).toBe(await stateVersionOf(f));
    expect(j.openStands).not.toBeNull();
    expect(JSON.stringify(j.openStands)).toContain(t.sessionId);
    expect(j.kitchenQueue, 'a cashier holds no serve_pos_ticket: null, not a 403').toBeNull();
    expect(j.refillQueue, 'a cashier holds no request_pos_refill: null, not a 403').toBeNull();
  });

  it('a kitchen-only person gets openStands null and the queue; stationId narrows the queue', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.kitchenId);
    const t = await openTable(f);
    const [bar] = await sql<{ id: string }[]>`insert into kitchen_stations (org_id, store_id, name, created_by) values (${f.orgId}, ${f.storeId}, 'Bar', ${f.personId}) returning id`;
    const res = await getState(f, session, { query: '?since=-1' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { openStands: unknown; kitchenQueue: unknown };
    expect(j.openStands, 'no record_sale: null, not a 403').toBeNull();
    expect(j.kitchenQueue).not.toBeNull();
    expect(JSON.stringify(j.kitchenQueue)).toContain(t.lineId);

    const mine = (await (await getState(f, session, { query: `?since=-1&stationId=${f.grill}` })).json()) as { kitchenQueue: unknown };
    expect(JSON.stringify(mine.kitchenQueue)).toContain(t.lineId);
    const other = (await (await getState(f, session, { query: `?since=-1&stationId=${bar!.id}` })).json()) as { kitchenQueue: unknown };
    expect(JSON.stringify(other.kitchenQueue), 'the pork is on the Grill, not the Bar').not.toContain(t.lineId);
  });

  it('a server phone or kitchen screen with no tablet cookie names its store with storeId and is 200; another store\'s id is 403, and 403 beats 304', async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    await openTable(f);
    // store B gets a switch row at version 0, so `since=0` WOULD be a 304 if scope were not checked first
    await sql`insert into pos_stores (org_id, store_id, mode, live_from, changed_by) values (${f.orgId}, ${f.store2Id}, 'test', ${null}, ${f.personId})`;

    const own = await getState(f, session, { withTablet: false, query: `?storeId=${f.storeId}&since=-1` });
    expect(own.status).toBe(200);
    expect(JSON.stringify(await own.json())).toContain('openStands');

    for (const since of ['-1', '0']) {
      const res = await getState(f, session, { withTablet: false, query: `?storeId=${f.store2Id}&since=${since}` });
      expect(res.status, `since=${since} for another store`).toBe(403);
      const j = (await res.json()) as { ok: boolean };
      expect(j.ok).toBe(false);
    }
  });

  it("with the tablet cookie the store is the pairing's: a different storeId in the query is 403 (never answered from store A or B), and its own storeId, in any letter case, is 200", async () => {
    const f = await fixture();
    const session = await pinSession(f, f.counterId);
    const t = await openTable(f);
    const res = await getState(f, session, { query: `?storeId=${f.store2Id}&since=-1` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    for (const query of ['?since=-1', `?storeId=${f.storeId.toUpperCase()}&since=-1`]) {
      const same = await getState(f, session, { query });
      expect(same.status, query).toBe(200);
      expect(JSON.stringify(await same.json())).toContain(t.sessionId);
    }
  });
});
