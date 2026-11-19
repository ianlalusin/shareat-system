import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-534 S2 - the two Convert doors, called as a route would be (a real Request with real cookies), the t531 pattern.
 *   POST /api/pos/conversions        { requestId, fromTenderId, toTenderId, amount, note? }   tablet cookie AND person session (record_sale), no PIN
 *   POST /api/pos/conversions/void   { conversionId, reason? }                                the recorder, or a holder of approve_pos_correction, before the Z
 * 200 { ok, wrote, ... }; 409 with a refusal sentence; 401 no session / no tablet; 403 no record_sale; 415 not JSON; 400 a body that is not the shape.
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
import { pinSession } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';
import { close, closeAll, manila, D1, pinOf, porkSale, sql, uuid, world } from '../../../../packages/domain/tests/integration/_fixtures/t531-day-close';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const SESSION_COOKIE = 'shareat_session';
const ROUTES = { record: '../../src/app/api/pos/conversions/route', void: '../../src/app/api/pos/conversions/void/route' } as const;
const PATHS = { record: '/api/pos/conversions', void: '/api/pos/conversions/void' } as const;

async function call(route: keyof typeof ROUTES, o: { cookies?: Record<string, string | undefined>; body?: unknown; contentType?: string | null } = {}): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ ROUTES[route])) as { POST: (r: Request) => Promise<Response> };
  const cookie = Object.entries(o.cookies ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; ');
  state.cookie = cookie;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}) };
  if (o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
  return mod.POST(new Request(`http://localhost:9008${PATHS[route]}`, { method: 'POST', headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }));
}

async function setup() {
  const w = await world('live');
  await porkSale(w, manila(D1, '12:00'));
  const tokens = { counter: await pinSession(w, w.counterId), kitchen: await pinSession(w, w.kitchenId), manager: await pinSession(w, w.managerId) };
  const as = (t: string) => ({ [POS_TABLET_COOKIE]: w.pairingToken, [SESSION_COOKIE]: t });
  return { w, counter: as(tokens.counter), kitchen: as(tokens.kitchen), manager: as(tokens.manager), tokens };
}
const rowCount = async (orgId: string) => Number((await sql<{ n: number }[]>`select count(*)::int n from pos_payment_conversions where org_id = ${orgId}`)[0]!.n);
const body = (w: { cash: string; gcash: string }, over: Record<string, unknown> = {}) => ({ requestId: uuid(), fromTenderId: w.cash, toTenderId: w.gcash, amount: '500.00', note: 'x', ...over });

describe('POST /api/pos/conversions', () => {
  it('200 writes one Convert for the paired tablet\'s store; the same requestId again answers wrote:false and writes nothing', async () => {
    const { w, counter } = await setup();
    const b = body(w);
    const res = await call('record', { cookies: counter, body: b });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control') ?? '').toContain('no-store');
    const j = (await res.json()) as { ok: boolean; wrote: boolean; id: string };
    expect(j).toMatchObject({ ok: true, wrote: true });
    const again = (await (await call('record', { cookies: counter, body: b })).json()) as { ok: boolean; wrote: boolean; id: string };
    expect(again).toEqual({ ok: true, wrote: false, id: j.id });
    expect(await rowCount(w.orgId)).toBe(1);
    const [row] = await sql<{ store_id: string; recorded_by: string }[]>`select store_id, recorded_by from pos_payment_conversions where id = ${j.id}`;
    expect(row).toEqual({ store_id: w.storeId, recorded_by: w.counterId });
  });

  it('401 with no session and with no tablet; 403 for a person without record_sale; nothing written', async () => {
    const { w, counter, kitchen } = await setup();
    expect((await call('record', { cookies: { [POS_TABLET_COOKIE]: w.pairingToken }, body: body(w) })).status).toBe(401);
    expect((await call('record', { cookies: { [SESSION_COOKIE]: counter[SESSION_COOKIE] }, body: body(w) })).status).toBe(401);
    expect((await call('record', { cookies: kitchen, body: body(w) })).status).toBe(403);
    expect(await rowCount(w.orgId)).toBe(0);
  });

  it('415 when it is not JSON; 400 for a body of the wrong shape; 409 with the sentence when both methods are the same', async () => {
    const { w, counter } = await setup();
    expect((await call('record', { cookies: counter, body: body(w), contentType: 'text/plain' })).status).toBe(415);
    expect((await call('record', { cookies: counter, body: { requestId: uuid() } })).status).toBe(400);
    expect((await call('record', { cookies: counter, body: body(w, { amount: undefined }) })).status).toBe(400);
    const same = await call('record', { cookies: counter, body: body(w, { toTenderId: w.cash }) });
    expect(same.status).toBe(409);
    expect(((await same.json()) as { error: string }).error).toBe('Pick two different payment methods.');
    expect(await rowCount(w.orgId)).toBe(0);
  });
});

describe('POST /api/pos/conversions/void', () => {
  it('200 voids the cashier\'s own Convert; a second void answers wrote:false; the other person without the right gets 409 with the sentence', async () => {
    const { w, counter, manager } = await setup();
    const mine = (await (await call('record', { cookies: counter, body: body(w) })).json()) as { id: string };
    const theirs = (await (await call('record', { cookies: manager, body: body(w) })).json()) as { id: string };
    const refused = await call('void', { cookies: counter, body: { conversionId: theirs.id } });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('Only the cashier who recorded this Convert, or a manager, can void it.');
    expect(await (await call('void', { cookies: counter, body: { conversionId: mine.id } })).json()).toEqual({ ok: true, wrote: true });
    expect(await (await call('void', { cookies: counter, body: { conversionId: mine.id } })).json()).toEqual({ ok: true, wrote: false });
    expect(await (await call('void', { cookies: manager, body: { conversionId: theirs.id, reason: 'wrong amount' } })).json()).toEqual({ ok: true, wrote: true });
  });

  it('409 after the Z: "This Convert is already in a closed day, so it cannot be voided any more."', async () => {
    const { w, counter } = await setup();
    const c = (await (await call('record', { cookies: counter, body: body(w) })).json()) as { id: string };
    await close(w, manila(D1, '22:30'), await pinOf(w, w.managerId));
    const res = await call('void', { cookies: counter, body: { conversionId: c.id } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('This Convert is already in a closed day, so it cannot be voided any more.');
  });
});
