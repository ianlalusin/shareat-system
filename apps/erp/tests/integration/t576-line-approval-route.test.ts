import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-576 - POST /api/pos/line-approval, called as a route would be (a real `Request` with real cookies; the T-575 route-test pattern).
 * The till asks BEFORE it saves a line action: a wrong manager PIN is refused on the spot (and charged one miss), a right one answers a signed token
 * bound to this store, tablet, approver, action and target. The PIN is never in a URL (there is no GET) and never in the answer.
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

import { POS_TABLET_COOKIE, posLineApprovalMatches } from '@shareat/auth';
import { closeAll, fixture, pinOf, pinSession, sql, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const ROUTE = '../../src/app/api/pos/line-approval/route';
const PATH = '/api/pos/line-approval';
const SESSION_COOKIE = 'shareat_session';
const WRONG_PIN = 'That PIN cannot approve this. Ask a store manager.';

async function post(o: { cookies?: Record<string, string | undefined>; body?: unknown; raw?: string; contentType?: string | null } = {}): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ ROUTE)) as { POST?: (r: Request) => Promise<Response>; GET?: unknown };
  const cookie = Object.entries(o.cookies ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; ');
  state.cookie = cookie;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}) };
  if (o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
  const body = o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined;
  return mod.POST!(new Request(`http://localhost:9008${PATH}`, { method: 'POST', headers, ...(body !== undefined ? { body } : {}) }));
}

async function world() {
  const f: Fx = await fixture();
  const tokens = { counter: await pinSession(f, f.counterId), kitchen: await pinSession(f, f.kitchenId), other: await pinSession(f, f.managerOtherId) };
  const as = (t: string) => ({ [POS_TABLET_COOKIE]: f.pairingToken, [SESSION_COOKIE]: t });
  return { f, counterCookies: as(tokens.counter), kitchenCookies: as(tokens.kitchen), otherStoreCookies: as(tokens.other), managerPin: await pinOf(f, f.managerId) };
}
const misses = async (f: Fx) => Number((await sql<{ n: number }[]>`select count(*)::int n from sign_in_attempts where org_id = ${f.orgId} and kind = 'miss'`)[0]!.n);
const noStore = (res: Response) => expect(res.headers.get('cache-control') ?? '').toContain('no-store');
async function expectFailure(res: Response, status: number | number[]) {
  if (Array.isArray(status)) expect(status).toContain(res.status);
  else expect(res.status).toBe(status);
  const j = (await res.json()) as { ok: boolean; error: string };
  expect(j.ok).toBe(false);
  expect(typeof j.error).toBe('string');
  return j.error;
}

describe('POST /api/pos/line-approval', () => {
  it('a right manager PIN answers 200 { token, approverId, exp } whose token verifies for exactly this store, tablet, action and target, and never echoes the PIN [kills: an unsigned or loosely bound token]', async () => {
    const { f, counterCookies, managerPin } = await world();
    const target = uuid();
    const before = Date.now();
    const res = await post({ cookies: counterCookies, body: { pin: managerPin, action: 'line.cancelled', targetId: target } });
    expect(res.status).toBe(200);
    noStore(res);
    const text = await res.text();
    expect(text).not.toContain(managerPin);
    const j = JSON.parse(text) as { ok: boolean; token: string; approverId: string; exp: number };
    expect(Object.keys(j).sort()).toEqual(['approverId', 'exp', 'ok', 'token']);
    expect(j.approverId).toBe(f.managerId);
    expect(j.exp).toBeGreaterThan(before + 14 * 60_000);
    expect(j.exp).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const claim = { orgId: f.orgId, storeId: f.storeId, pairingId: f.pairingId, approverId: f.managerId, action: 'line.cancelled', targetId: target, exp: j.exp, detail: '' };
    expect(posLineApprovalMatches(claim, j.token)).toBe(true);
    expect(posLineApprovalMatches({ ...claim, targetId: uuid() }, j.token)).toBe(false);
    expect(posLineApprovalMatches({ ...claim, action: 'discount.added' }, j.token)).toBe(false);
    expect(posLineApprovalMatches({ ...claim, storeId: f.store2Id }, j.token)).toBe(false);
    expect(await misses(f)).toBe(0);
  });

  it('a discount token is bound to the new discount id and to its kind / value / units: the route passes the body through [kills: a route that drops the detail]', async () => {
    const { f, counterCookies, managerPin } = await world();
    const target = uuid();
    const line = uuid();
    const body = { pin: managerPin, action: 'discount.added', targetId: target, kind: 'custom', valueType: 'percent', value: '10', qty: 1, lineId: line };
    const j = JSON.parse(await (await post({ cookies: counterCookies, body })).text()) as { token: string; approverId: string; exp: number };
    const claim = { orgId: f.orgId, storeId: f.storeId, pairingId: f.pairingId, approverId: f.managerId, action: 'discount.added', targetId: target, exp: j.exp, detail: `custom||percent|1000|1|${line}` };
    expect(posLineApprovalMatches(claim, j.token)).toBe(true);
    expect(posLineApprovalMatches({ ...claim, detail: `custom||percent|10000|1|${line}` }, j.token)).toBe(false);
    await expectFailure(await post({ cookies: counterCookies, body: { ...body, kind: undefined } }), 409);
  });

  it('a wrong PIN is refused on the spot with the approval sentence, no token, and charges exactly ONE miss [kills: a refusal that costs nothing, or two]', async () => {
    const { f, counterCookies } = await world();
    const res = await post({ cookies: counterCookies, body: { pin: '000001', action: 'line.cancelled', targetId: uuid() } });
    const error = await expectFailure(res, 401);
    expect(error).toBe(WRONG_PIN);
    expect(await misses(f)).toBe(1);
  });

  it('there is no GET: a PIN must never travel in a URL, so the route exports no GET (Next answers 405)', async () => {
    const mod = (await import(/* @vite-ignore */ ROUTE)) as { GET?: unknown };
    expect(mod.GET).toBeUndefined();
  });

  it('401 with no tablet and with no person session; 403 for the kitchen (no record_sale) and for a person of the other store [kills: a door open to a phone or to another store]', async () => {
    const { f, counterCookies, kitchenCookies, otherStoreCookies, managerPin } = await world();
    const body = { pin: managerPin, action: 'line.cancelled', targetId: uuid() };
    await expectFailure(await post({ cookies: { [SESSION_COOKIE]: counterCookies[SESSION_COOKIE] }, body }), 401);
    await expectFailure(await post({ cookies: { [POS_TABLET_COOKIE]: f.pairingToken }, body }), 401);
    await expectFailure(await post({ body }), 401);
    await expectFailure(await post({ cookies: kitchenCookies, body }), 403);
    await expectFailure(await post({ cookies: otherStoreCookies, body }), 403);
    expect(await misses(f), 'a refused caller never reaches the PIN check').toBe(0);
  });

  it('415 for a body that is not JSON; 400 for broken JSON, missing or non-text fields; an unknown action or a non-UUID target is refused, and none of them charge a miss', async () => {
    const { f, counterCookies, managerPin } = await world();
    await expectFailure(await post({ cookies: counterCookies, body: { pin: managerPin, action: 'line.cancelled', targetId: uuid() }, contentType: 'text/plain' }), 415);
    await expectFailure(await post({ cookies: counterCookies, raw: '{nope' }), 400);
    await expectFailure(await post({ cookies: counterCookies, body: {} }), 400);
    await expectFailure(await post({ cookies: counterCookies, body: { pin: 1234, action: 'line.cancelled', targetId: uuid() } }), 400);
    await expectFailure(await post({ cookies: counterCookies, body: { pin: managerPin, action: 'session.voided', targetId: uuid() } }), 409);
    await expectFailure(await post({ cookies: counterCookies, body: { pin: managerPin, action: 'line.cancelled', targetId: 'nope' } }), 409);
    expect(await misses(f)).toBe(0);
  });
});
