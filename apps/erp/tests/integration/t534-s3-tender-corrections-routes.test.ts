import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-534 S3 - the wrong-payment-method door, called as a route would be (a real Request with real cookies), the t531 pattern.
 *   POST /api/pos/tender-corrections   { requestId, receiptId, paymentId, toTenderId, amount, referenceNo?, reason, pin? }   tablet cookie AND person session (record_sale);
 *   a manager PIN unless the signed-in person holds approve_pos_correction.
 * 200 { ok, wrote, id }; 409 with a refusal sentence; 401 no session / no tablet / a wrong PIN; 403 no record_sale; 415 not JSON; 400 a body that is not the shape.
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

import { POS_APPROVAL_REFUSED, POS_TABLET_COOKIE } from '@shareat/auth';
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
const ROUTE = '../../src/app/api/pos/tender-corrections/route';

async function call(o: { cookies?: Record<string, string | undefined>; body?: unknown; contentType?: string | null } = {}): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ ROUTE)) as { POST: (r: Request) => Promise<Response> };
  const cookie = Object.entries(o.cookies ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('; ');
  state.cookie = cookie;
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}) };
  if (o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
  return mod.POST(new Request('http://localhost:9008/api/pos/tender-corrections', { method: 'POST', headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }));
}

async function setup() {
  const w = await world('live');
  const sale = await porkSale(w, manila(D1, '12:00'));
  const [pay] = await sql<{ id: string }[]>`select id from pos_sales_receipt_payments where receipt_id = ${sale.receiptId}`;
  const tokens = { counter: await pinSession(w, w.counterId), kitchen: await pinSession(w, w.kitchenId), manager: await pinSession(w, w.managerId) };
  const as = (t: string) => ({ [POS_TABLET_COOKIE]: w.pairingToken, [SESSION_COOKIE]: t });
  return { w, receiptId: sale.receiptId, paymentId: pay!.id, counter: as(tokens.counter), kitchen: as(tokens.kitchen), manager: as(tokens.manager) };
}
type S = Awaited<ReturnType<typeof setup>>;
const rowCount = async (orgId: string) => Number((await sql<{ n: number }[]>`select count(*)::int n from pos_tender_corrections where org_id = ${orgId}`)[0]!.n);
const misses = async (orgId: string) => Number((await sql<{ n: number }[]>`select count(*)::int n from sign_in_attempts where org_id = ${orgId} and kind = 'miss'`)[0]!.n);
const body = (s: S, over: Record<string, unknown> = {}) => ({ requestId: uuid(), receiptId: s.receiptId, paymentId: s.paymentId, toTenderId: s.w.gcash, amount: '100.00', referenceNo: 'GC-0001234', reason: 'Paid by GCash', ...over });

describe('POST /api/pos/tender-corrections', () => {
  it('200 for a signed-in holder of the right (no PIN): one correction for the paired tablet store; the same requestId again answers wrote:false and writes nothing', async () => {
    const s = await setup();
    const b = body(s);
    const res = await call({ cookies: s.manager, body: b });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control') ?? '').toContain('no-store');
    const j = (await res.json()) as { ok: boolean; wrote: boolean; id: string };
    expect(j).toMatchObject({ ok: true, wrote: true });
    expect(await (await call({ cookies: s.manager, body: b })).json()).toEqual({ ok: true, wrote: false, id: j.id });
    expect(await rowCount(s.w.orgId)).toBe(1);
    const [row] = await sql<{ store_id: string; approved_by: string; recorded_by: string }[]>`select store_id, approved_by, recorded_by from pos_tender_corrections where id = ${j.id}`;
    expect(row).toEqual({ store_id: s.w.storeId, approved_by: s.w.managerId, recorded_by: s.w.managerId });
  });

  it('a cashier needs a manager PIN: none is 409 with the sentence, a wrong one is 401 and COUNTS as a miss, the manager PIN is 200 approved by the manager', async () => {
    const s = await setup();
    const none = await call({ cookies: s.counter, body: body(s) });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toBe('A manager must approve this. Ask for a manager PIN.');
    const wrong = await call({ cookies: s.counter, body: body(s, { pin: '999999' }) });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe(POS_APPROVAL_REFUSED);
    expect(await misses(s.w.orgId)).toBe(1);
    expect(await rowCount(s.w.orgId)).toBe(0);
    const ok = await call({ cookies: s.counter, body: body(s, { pin: await pinOf(s.w, s.w.managerId) }) });
    expect(ok.status).toBe(200);
    const [row] = await sql<{ approved_by: string; recorded_by: string }[]>`select approved_by, recorded_by from pos_tender_corrections where org_id = ${s.w.orgId}`;
    expect(row).toEqual({ approved_by: s.w.managerId, recorded_by: s.w.counterId });
  });

  it('401 with no session and with no tablet; 403 for a person without record_sale; nothing written', async () => {
    const s = await setup();
    expect((await call({ cookies: { [POS_TABLET_COOKIE]: s.w.pairingToken }, body: body(s) })).status).toBe(401);
    expect((await call({ cookies: { [SESSION_COOKIE]: s.manager[SESSION_COOKIE] }, body: body(s) })).status).toBe(401);
    expect((await call({ cookies: s.kitchen, body: body(s) })).status).toBe(403);
    expect(await rowCount(s.w.orgId)).toBe(0);
  });

  it('415 when it is not JSON; 400 for a body of the wrong shape; 409 with the sentence after the Z', async () => {
    const s = await setup();
    expect((await call({ cookies: s.manager, body: body(s), contentType: 'text/plain' })).status).toBe(415);
    expect((await call({ cookies: s.manager, body: { requestId: uuid() } })).status).toBe(400);
    expect((await call({ cookies: s.manager, body: body(s, { amount: undefined }) })).status).toBe(400);
    expect((await call({ cookies: s.manager, body: body(s, { reason: undefined }) })).status).toBe(400);
    await close(s.w, manila(D1, '22:30'), await pinOf(s.w, s.w.managerId));
    const closed = await call({ cookies: s.manager, body: body(s) });
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as { error: string }).error).toBe('Already in a closed day. Refund it and ring it again.');
    expect(await rowCount(s.w.orgId)).toBe(0);
  });
});
