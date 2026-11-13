import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-531 R7 (TESTER) - the three POS day-close doors, called as a route would be (a real `Request` with real cookies), the T-525 route-test pattern.
 * docs/tasks/531-pos-day-close.md R7, R8 "Screens: the PIN never appears in any request log or audit row".
 *
 * ASSUMED CONTRACT (the builder matches these or says why not):
 *   GET  /api/pos/x-reading   (apps/erp/src/app/api/pos/x-reading/route.ts)  tablet cookie + person session (record_sale); the store is the paired tablet's.
 *        200 { ok: true, reading: { receiptCount, grossTotal, ... } } ; 401 without a session; 403 for a person without record_sale. Writes nothing.
 *   POST /api/pos/day-close   (.../day-close/route.ts)  tablet cookie AND person session; body { closeId, approval: { employeeId, pin } };
 *        200 { ok: true, wrote, dayCloseId, zNo, salesDayId, reading, v1?: ... } ; 409 { ok: false, error: <the refusal sentence> } ; 401 / 403 (the spec says "401 or 403").
 *        A wrong PIN is 401 or 403 and never 200. `employeeId` is accepted and the PIN check is the server's (hand-back Q8: is the employee id compared with the PIN's owner?).
 *   POST /api/pos/day-close/resend-v1 (.../day-close/resend-v1/route.ts)  body { businessDate }; person session with approve_pos_correction; 409 with the writer's sentence.
 *   Every answer is JSON with cache-control no-store; failures are { ok: false, error: <one sentence, no uuid> }. All of them are ONLINE-only doors (no outbox kind exists).
 * With POS_FIREBASE_SA_KEY_FILE unset (the test environment) the real writer refuses "The v1 bridge is not configured." and the close STILL succeeds (R5 credentials).
 * (The failed-bridge audit assertion below holds while the Z's business date is on or before 2026-12-31: this file's world is live from "today".)
 *
 * RED NOW FOR THE RIGHT REASON: the three route files do not exist ("MISSING MODULE ... (T-531 not built)", after the fixture ran).
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
import { toBusinessDate } from '@shareat/core/datetime';
import { pinSession } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';
import { closeAll, closesOf, pinOf, porkSale, salesDaysOf, sql, auditsOf, uuid, world, openReceiptCount, type World } from '../../../../packages/domain/tests/integration/_fixtures/t531-day-close';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const ROUTES = {
  'x-reading': '../../src/app/api/pos/x-reading/route',
  'day-close': '../../src/app/api/pos/day-close/route',
  'resend-v1': '../../src/app/api/pos/day-close/resend-v1/route',
} as const;
type Route = keyof typeof ROUTES;
const PATHS: Record<Route, string> = { 'x-reading': '/api/pos/x-reading', 'day-close': '/api/pos/day-close', 'resend-v1': '/api/pos/day-close/resend-v1' };
const SESSION_COOKIE = 'shareat_session';
const NO_SALES = 'There are no sales to close since the last Z.';

async function call(route: Route, method: 'GET' | 'POST', o: { cookies?: Record<string, string | undefined>; body?: unknown; contentType?: string | null } = {}): Promise<Response> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ ROUTES[route]);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src${PATHS[route].replace('/api/pos', '/app/api/pos')}/route.ts cannot be loaded (T-531 not built): ${String((e as Error).message).slice(0, 120)}`);
  }
  const handler = mod[method];
  if (typeof handler !== 'function') throw new Error(`MISSING EXPORT: the ${route} route does not export ${method} (T-531 not built).`);
  const cookie = Object.entries(o.cookies ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; ');
  state.cookie = cookie;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}) };
  if (method === 'POST' && o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
  const req = new Request(`http://localhost:9008${PATHS[route]}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  return (handler as (r: Request) => Promise<Response>)(req);
}

/** A live world whose first window opened "today" (Manila business date), with one cash sale made now; everyone has a PIN session on the tablet. */
async function today() {
  const liveFrom = toBusinessDate(new Date(Date.now() - 4 * 3600e3));
  const w = await world('live', liveFrom);
  await porkSale(w, new Date());
  // RULING 4 (8 Nov): the Employee ID typed with the PIN must be the PIN owner's staff code at the store, so the approving manager has one (SE-900, the id these cases type).
  await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${w.orgId}, ${w.storeId}, ${w.managerId}, 'SE-900', 'regular', '2025-01-01')`;
  const tokens = {
    counter: await pinSession(w, w.counterId),
    kitchen: await pinSession(w, w.kitchenId),
    manager: await pinSession(w, w.managerId),
  };
  const as = (t: string) => ({ [POS_TABLET_COOKIE]: w.pairingToken, [SESSION_COOKIE]: t });
  return { w, tokens, counterCookies: as(tokens.counter), kitchenCookies: as(tokens.kitchen), managerCookies: as(tokens.manager) };
}
const noStore = (res: Response) => expect(res.headers.get('cache-control') ?? '').toContain('no-store');
async function expectFailure(res: Response, status: number | number[], error?: string) {
  if (Array.isArray(status)) expect(status).toContain(res.status);
  else expect(res.status).toBe(status);
  const j = (await res.json()) as { ok: boolean; error: string };
  expect(j.ok).toBe(false);
  expect(typeof j.error).toBe('string');
  expect(j.error.length).toBeGreaterThan(10);
  expect(j.error, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  if (error !== undefined) expect(j.error).toBe(error);
}
const dayCounts = async (w: World) => ({ closes: (await closesOf(w)).length, days: (await salesDaysOf(w)).length, open: await openReceiptCount(w) });

// ==============================================================================================================================
describe('fixture sanity (runs now)', () => {
  it('the world is live from today, one sale is open, and the cookies resolve through the real lib/session', async () => {
    const { w, counterCookies } = await today();
    expect(await openReceiptCount(w)).toBe(1);
    state.cookie = Object.entries(counterCookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const { currentSession } = await import('../../src/lib/session');
    expect((await currentSession())?.actor).toEqual({ personId: w.counterId, orgId: w.orgId });
  });
});

describe('GET /api/pos/x-reading (R7)', () => {
  it('200 with the open window\'s figures for the paired tablet\'s store; writes nothing', async () => {
    const { w, counterCookies } = await today();
    const was = await dayCounts(w);
    const res = await call('x-reading', 'GET', { cookies: counterCookies });
    expect(res.status).toBe(200);
    noStore(res);
    const j = (await res.json()) as { ok: boolean; reading: { receiptCount: number; grossTotal: string } };
    expect(j.ok).toBe(true);
    expect(j.reading).toMatchObject({ receiptCount: 1, grossTotal: '250.00' });
    expect(await dayCounts(w)).toEqual(was);
    expect((await auditsOf(w, 'pos.day_closed')).length).toBe(0);
  });

  it('401 with no person session and with no tablet; 403 for a person without record_sale (the kitchen)', async () => {
    const { w, kitchenCookies, counterCookies } = await today();
    await expectFailure(await call('x-reading', 'GET', { cookies: { [POS_TABLET_COOKIE]: w.pairingToken } }), 401);
    await expectFailure(await call('x-reading', 'GET', { cookies: { [SESSION_COOKIE]: counterCookies[SESSION_COOKIE] } }), [401, 403]);
    await expectFailure(await call('x-reading', 'GET', { cookies: kitchenCookies }), 403);
  });
});

describe('POST /api/pos/day-close (R7)', () => {
  it('200: the Z is written, the sales day derived; the answer names the Z; the PIN is NOWHERE (not in the answer, any log line, any audit row)', async () => {
    const { w, counterCookies } = await today();
    const pin = await pinOf(w, w.managerId);
    const logged: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => (logged.push(String(c)), true)) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (logged.push(String(c)), true)) as never);

    const closeId = uuid();
    const res = await call('day-close', 'POST', { cookies: counterCookies, body: { closeId, approval: { employeeId: 'SE-900', pin } } });
    const text = await res.clone().text();
    expect(res.status).toBe(200);
    noStore(res);
    const j = JSON.parse(text) as { ok: boolean; wrote: boolean; dayCloseId: string; zNo: number; salesDayId: string | null };
    expect(j).toMatchObject({ ok: true, wrote: true, dayCloseId: closeId, zNo: 1 });
    expect(await dayCounts(w)).toEqual({ closes: 1, days: 1, open: 0 });
    expect(text).not.toContain(pin);
    expect(logged.join('\n'), 'no request or log line carries the PIN').not.toContain(pin);
    const [row] = await sql<{ blob: string }[]>`
      select coalesce(string_agg(row_to_json(a)::text, ' '), '') as blob from audit_log a where a.org_id = ${w.orgId}`;
    expect(row!.blob).not.toContain(pin);
  });

  it('a replay of the same closeId is 200 with wrote:false and writes nothing', async () => {
    const { w, counterCookies } = await today();
    const body = { closeId: uuid(), approval: { employeeId: 'SE-900', pin: await pinOf(w, w.managerId) } };
    await call('day-close', 'POST', { cookies: counterCookies, body });
    const was = await dayCounts(w);
    const again = await call('day-close', 'POST', { cookies: counterCookies, body });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { wrote: boolean }).wrote).toBe(false);
    expect(await dayCounts(w)).toEqual(was);
  });

  it('a refusal is 409 with the sentence: nothing to close (a second close with a new id right after the first)', async () => {
    const { w, counterCookies } = await today();
    const pin = await pinOf(w, w.managerId);
    await call('day-close', 'POST', { cookies: counterCookies, body: { closeId: uuid(), approval: { employeeId: 'SE-900', pin } } });
    const res = await call('day-close', 'POST', { cookies: counterCookies, body: { closeId: uuid(), approval: { employeeId: 'SE-900', pin } } });
    await expectFailure(res, 409, NO_SALES);
    noStore(res);
  });

  it('a wrong PIN is 401 or 403, never 200, writes nothing, and the answer does not echo the PIN', async () => {
    const { w, counterCookies } = await today();
    const res = await call('day-close', 'POST', { cookies: counterCookies, body: { closeId: uuid(), approval: { employeeId: 'SE-900', pin: '999999' } } });
    expect([401, 403]).toContain(res.status);
    expect(await res.text()).not.toContain('999999');
    expect(await dayCounts(w)).toEqual({ closes: 0, days: 0, open: 1 });
  });

  it('RULING 4: a right PIN with another person\'s Employee ID is refused (401 or 403) like a wrong PIN, and writes nothing', async () => {
    const { w, counterCookies } = await today();
    const res = await call('day-close', 'POST', { cookies: counterCookies, body: { closeId: uuid(), approval: { employeeId: 'SE-001', pin: await pinOf(w, w.managerId) } } });
    expect([401, 403]).toContain(res.status);
    expect(await dayCounts(w)).toEqual({ closes: 0, days: 0, open: 1 });
  });

  it('auth: no tablet cookie or no person session is 401/403; a person without record_sale is 403; nothing is written', async () => {
    const { w, kitchenCookies, counterCookies } = await today();
    const body = { closeId: uuid(), approval: { employeeId: 'SE-900', pin: await pinOf(w, w.managerId) } };
    await expectFailure(await call('day-close', 'POST', { cookies: { [SESSION_COOKIE]: counterCookies[SESSION_COOKIE] }, body }), [401, 403]);
    await expectFailure(await call('day-close', 'POST', { cookies: { [POS_TABLET_COOKIE]: w.pairingToken }, body }), [401, 403]);
    await expectFailure(await call('day-close', 'POST', { cookies: kitchenCookies, body }), 403);
    expect(await dayCounts(w)).toEqual({ closes: 0, days: 0, open: 1 });
  });

  it('a malformed body (no closeId, a closeId that is not an id, no PIN) is 400 with one sentence; text/plain is 415; nothing is written', async () => {
    const { w, counterCookies } = await today();
    const pin = await pinOf(w, w.managerId);
    for (const body of [{ approval: { employeeId: 'SE-900', pin } }, { closeId: 'nope', approval: { employeeId: 'SE-900', pin } }, { closeId: uuid() }, { closeId: uuid(), approval: {} }]) {
      await expectFailure(await call('day-close', 'POST', { cookies: counterCookies, body }), 400);
    }
    await expectFailure(await call('day-close', 'POST', { cookies: counterCookies, body: { closeId: uuid() }, contentType: 'text/plain' }), 415);
    expect(await dayCounts(w)).toEqual({ closes: 0, days: 0, open: 1 });
  });

  it('with no v1 key the close STILL succeeds (200); the failed send is recorded as pos.v1_bridge_failed (the Till tab then shows Resend)', async () => {
    const { w, counterCookies } = await today();
    const res = await call('day-close', 'POST', { cookies: counterCookies, body: { closeId: uuid(), approval: { employeeId: 'SE-900', pin: await pinOf(w, w.managerId) } } });
    expect(res.status).toBe(200);
    expect((await closesOf(w)).length).toBe(1);
    expect((await auditsOf(w, 'pos.v1_bridge_failed')).length).toBe(1);
    expect((await auditsOf(w, 'pos.v1_bridge_sent')).length).toBe(0);
  });
});

describe('POST /api/pos/day-close/resend-v1 (R7)', () => {
  it('a manager with approve_pos_correction gets 409 "The v1 bridge is not configured." when there is no key; the cashier is 403', async () => {
    const { w, counterCookies, managerCookies } = await today();
    await call('day-close', 'POST', { cookies: counterCookies, body: { closeId: uuid(), approval: { employeeId: 'SE-900', pin: await pinOf(w, w.managerId) } } });
    const [z] = await closesOf(w);
    await expectFailure(await call('resend-v1', 'POST', { cookies: managerCookies, body: { businessDate: z!.business_date } }), 409, 'The v1 bridge is not configured.');
    await expectFailure(await call('resend-v1', 'POST', { cookies: counterCookies, body: { businessDate: z!.business_date } }), 403);
  });
});
