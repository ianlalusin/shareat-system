import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-575 (TESTER) - POST /api/pos/senior-id-check, called as a route would be (a real `Request` with real cookies; the T-531 route-test pattern).
 * docs/tasks/575-pos-repeat-senior-id-warning.md as amended 13 Nov 2026.
 *
 * ASSUMED CONTRACT (the builder matches these or says why not):
 *   POST /api/pos/senior-id-check   (apps/erp/src/app/api/pos/senior-id-check/route.ts)   body { idNumber: string }, content-type application/json.
 *        The ID travels in the BODY, never in a URL: there is no GET (Next answers 405 for a method the file does not export).
 *        Paired-tablet cookie AND a PIN-signed-in person (record_sale at the tablet's store); the store is the pairing's, never a request value.
 *        200 { ok: true, used: n, lastReceiptNo: string | null, lastAt: string | null } and NOTHING else of the holder (no name). 401 without a tablet or a session,
 *        403 for a person without record_sale or of another store, 415 not JSON, 400 a body without a text idNumber. Every answer is JSON with cache-control no-store.
 *
 * RED NOW FOR THE RIGHT REASON: the route file does not exist ("MISSING MODULE ... (T-575 not built)", after the fixture ran).
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
import { HOLDER, IDNO, pinSession } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';
import { closeAll, sell, sql, world, type World } from '../../../../packages/domain/tests/integration/_fixtures/t531-day-close';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const ROUTE = '../../src/app/api/pos/senior-id-check/route';
const PATH = '/api/pos/senior-id-check';
const SESSION_COOKIE = 'shareat_session';

async function load(): Promise<Record<string, unknown>> {
  try {
    return await import(/* @vite-ignore */ ROUTE);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/api/pos/senior-id-check/route.ts cannot be loaded (T-575 not built): ${String((e as Error).message).slice(0, 120)}`);
  }
}
async function post(o: { cookies?: Record<string, string | undefined>; body?: unknown; raw?: string; contentType?: string | null } = {}): Promise<Response> {
  const mod = await load();
  if (typeof mod.POST !== 'function') throw new Error('MISSING EXPORT: the route does not export POST (T-575 not built).');
  const cookie = Object.entries(o.cookies ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; ');
  state.cookie = cookie;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}) };
  if (o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
  const body = o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined;
  return (mod.POST as (r: Request) => Promise<Response>)(new Request(`http://localhost:9008${PATH}`, { method: 'POST', headers, ...(body !== undefined ? { body } : {}) }));
}

/** A live world, one senior sale made now, everyone signed in on the tablet. */
async function today() {
  const liveFrom = toBusinessDate(new Date(Date.now() - 10 * 24 * 3600e3));
  const w: World = await world('live', liveFrom);
  const at = new Date();
  const made = await sell(w, {
    at, items: [{ item: w.menu.pork, qty: 1 }], discounts: [{ lineIndex: 0, kind: 'senior', qty: 1, dinerNo: 1 }], pay: [{ tenderId: w.cash, amount: '300.00' }],
  });
  const tokens = { counter: await pinSession(w, w.counterId), kitchen: await pinSession(w, w.kitchenId), other: await pinSession(w, w.managerOtherId) };
  const as = (t: string) => ({ [POS_TABLET_COOKIE]: w.pairingToken, [SESSION_COOKIE]: t });
  return { w, made, at, counterCookies: as(tokens.counter), kitchenCookies: as(tokens.kitchen), otherStoreCookies: as(tokens.other) };
}
const noStore = (res: Response) => expect(res.headers.get('cache-control') ?? '').toContain('no-store');
async function expectFailure(res: Response, status: number | number[]) {
  if (Array.isArray(status)) expect(status).toContain(res.status);
  else expect(res.status).toBe(status);
  const j = (await res.json()) as { ok: boolean; error: string };
  expect(j.ok).toBe(false);
  expect(typeof j.error).toBe('string');
  expect(j.error, 'one sentence, no UUID, no card number').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  expect(j.error).not.toContain(IDNO);
}

describe('POST /api/pos/senior-id-check', () => {
  it('200 with { used, lastReceiptNo, lastAt } for a card used earlier today at this store, and no holder name anywhere in the answer [kills: a name in the answer; a store taken from the request]', async () => {
    const { w, made, at, counterCookies } = await today();
    const res = await post({ cookies: counterCookies, body: { idNumber: `  ${IDNO.toLowerCase()}  ` } });
    expect(res.status).toBe(200);
    noStore(res);
    const text = await res.text();
    expect(text).not.toContain(HOLDER);
    const j = JSON.parse(text) as { ok: boolean; used: number; lastReceiptNo: string; lastAt: string };
    expect(Object.keys(j).sort()).toEqual(['lastAt', 'lastReceiptNo', 'ok', 'used']);
    expect(j.ok).toBe(true);
    expect(j.used).toBe(1);
    expect(j.lastReceiptNo).toBe(`${w.storeCode}-01-${String(made.terminalSeq).padStart(6, '0')}`);
    expect(new Date(j.lastAt).getTime()).toBe(at.getTime());
  });

  it('a card never used answers { used: 0, lastReceiptNo: null, lastAt: null } and writes nothing [kills: a lookup that writes]', async () => {
    const { w, counterCookies } = await today();
    const before = await sql<{ n: number }[]>`select count(*)::int n from statutory_discount_records where org_id = ${w.orgId}`;
    const res = await post({ cookies: counterCookies, body: { idNumber: 'OSCA-0000001' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, used: 0, lastReceiptNo: null, lastAt: null });
    expect((await sql<{ n: number }[]>`select count(*)::int n from statutory_discount_records where org_id = ${w.orgId}`)[0]!.n).toBe(before[0]!.n);
  });

  it('there is no GET: the card number must never travel in a URL, so the route exports no GET (Next answers 405) [kills: a lookup by query string]', async () => {
    const mod = await load();
    if (typeof mod.GET === 'function') {
      const res = await (mod.GET as (r: Request) => Promise<Response>)(new Request(`http://localhost:9008${PATH}?idNumber=${IDNO}`));
      expect(res.status).toBe(405);
    } else {
      expect(mod.GET).toBeUndefined();
    }
  });

  it('401 with no tablet, 401 with no person session; 403 for a person without record_sale (the kitchen) and for a person of the other store [kills: a door open to a phone or to another store]', async () => {
    const { w, kitchenCookies, counterCookies, otherStoreCookies } = await today();
    const body = { idNumber: IDNO };
    await expectFailure(await post({ cookies: { [SESSION_COOKIE]: counterCookies[SESSION_COOKIE] }, body }), 401);
    await expectFailure(await post({ cookies: { [POS_TABLET_COOKIE]: w.pairingToken }, body }), 401);
    await expectFailure(await post({ body }), 401);
    await expectFailure(await post({ cookies: kitchenCookies, body }), 403);
    await expectFailure(await post({ cookies: otherStoreCookies, body }), 403);
  });

  it('415 for a body that is not JSON; 400 for broken JSON, a missing idNumber and a non-text one [kills: a 500 on a bad body]', async () => {
    const { counterCookies } = await today();
    await expectFailure(await post({ cookies: counterCookies, body: { idNumber: IDNO }, contentType: 'text/plain' }), 415);
    await expectFailure(await post({ cookies: counterCookies, raw: '{nope' }), 400);
    await expectFailure(await post({ cookies: counterCookies, body: {} }), 400);
    await expectFailure(await post({ cookies: counterCookies, body: { idNumber: 42 } }), 400);
  });
});
