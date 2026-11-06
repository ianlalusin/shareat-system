/**
 * T-508 S4 - GET /api/pos2/menu. docs/tasks/508-kitchen-stations-and-menu-to-pos.md R6 + "S0 findings".
 * The request carries Authorization (Firebase token), x-pos-store-id and x-device-id. The ERP store comes ONLY from the device's terminal link
 * (the `menu.forDevice` port, which resolves the link); a `storeId` in the query is never read. Unlinked device 401; staff not assigned to the
 * POS store 403; ETag = contentHash; If-None-Match equal -> 304.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, OTHER_STORE, STORE, createFakeFirestore, json, makeDeps, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';

vi.mock('server-only', () => ({}));

const UNLINKED = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const PROJ = (hash: string, stationName = 'Grill') => ({ menu: { stations: [{ id: 'st1', name: stationName }], items: [{ id: 'i1' }] }, contentHash: hash, nextChangeAt: null as string | null });

function get(opts: { query?: string; token?: string | null; store?: string | null; device?: string | null; inm?: string } = {}): Request {
  const h: Record<string, string> = {};
  const token = opts.token === undefined ? 'tok-cashier' : opts.token;
  if (token) h.authorization = `Bearer ${token}`;
  const store = opts.store === undefined ? STORE : opts.store;
  if (store) h['x-pos-store-id'] = store;
  const device = opts.device === undefined ? DEVICE : opts.device;
  if (device) h['x-device-id'] = device;
  if (opts.inm) h['if-none-match'] = opts.inm;
  return new Request(`http://pos2.test/api/pos2/menu${opts.query ?? ''}`, { method: 'GET', headers: h });
}

let fs: FakeFirestore;
let current = PROJ('h1');
const asked: { posStoreId: string; deviceId: string }[] = [];
const menuPort = { forDevice: async (i: { posStoreId: string; deviceId: string }) => { asked.push(i); return i.deviceId === UNLINKED ? null : current; } };
const handler = async () => (await import('@/server/pos2/menu')).handleMenu;
const deps = () => ({ ...makeDeps(fs).deps, menu: menuPort }) as never;

beforeEach(() => { fs = createFakeFirestore(); seedStaff(fs); seedStore(fs); current = PROJ('h1'); asked.length = 0; });
afterEach(() => vi.resetModules());

describe('GET /api/pos2/menu', () => {
  it('serves the menu with ETag = contentHash and no-store', async () => {
    const res = await (await handler())(get(), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"h1"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const b = await json(res);
    expect(b.contentHash).toBe('h1');
    expect(b.nextChangeAt).toBeNull();
    expect(b.menu.stations).toHaveLength(1);
  });
  it('unlinked device 401; unknown/non-uuid/missing device 401', async () => {
    for (const device of [UNLINKED, 'not-a-uuid', null]) expect((await (await handler())(get({ device }), deps())).status).toBe(401);
  });
  it('no token or bad token 401, and the port is never asked', async () => {
    for (const token of [null, 'bad-token']) expect((await (await handler())(get({ token }), deps())).status).toBe(401);
    expect(asked).toEqual([]);
  });
  it('spoofed ?storeId= is ignored: the port is asked with the header store and the device only', async () => {
    const res = await (await handler())(get({ query: `?storeId=${OTHER_STORE}&posStoreId=${OTHER_STORE}&erpStoreId=x` }), deps());
    expect(res.status).toBe(200);
    expect(asked).toEqual([{ posStoreId: STORE, deviceId: DEVICE }]);
  });
  it('staff not assigned to the requested POS store 403, port not asked', async () => {
    const res = await (await handler())(get({ store: OTHER_STORE }), deps());
    expect(res.status).toBe(403);
    expect(asked).toEqual([]);
  });
  it('If-None-Match equal -> 304 no body; a changed menu -> 200 with a new ETag', async () => {
    const h = await handler();
    const same = await h(get({ inm: '"h1"' }), deps());
    expect(same.status).toBe(304);
    expect(same.headers.get('cache-control')).toBe('no-store');
    expect(await same.text()).toBe('');
    current = PROJ('h2', 'Hot Line');
    const changed = await h(get({ inm: '"h1"' }), deps());
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).toBe('"h2"');
    expect((await json(changed)).menu.stations[0].name).toBe('Hot Line');
  });
  it('x-next-change-at: the ISO time on 200 and on 304; absent when there is none; ETag and body untouched', async () => {
    const h = await handler();
    const AT = '2026-11-01T09:00:00.000Z';
    current = { ...PROJ('h1'), nextChangeAt: AT };
    const ok = await h(get(), deps());
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-next-change-at')).toBe(AT);
    expect(ok.headers.get('etag')).toBe('"h1"');
    expect((await json(ok)).nextChangeAt).toBe(AT);
    const same = await h(get({ inm: '"h1"' }), deps());
    expect(same.status).toBe(304);
    expect(same.headers.get('x-next-change-at')).toBe(AT);
    expect(same.headers.get('etag')).toBe('"h1"');
    expect(await same.text()).toBe('');
    current = PROJ('h1'); // nextChangeAt null
    expect((await h(get(), deps())).headers.has('x-next-change-at')).toBe(false);
    expect((await h(get({ inm: '"h1"' }), deps())).headers.has('x-next-change-at')).toBe(false);
  });
  it('missing x-pos-store-id 400 "Missing store."', async () => {
    const res = await (await handler())(get({ store: null }), deps());
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('Missing store.');
  });
  it('route answers 503 when the POS server is not configured', async () => {
    const { GET } = await import('@/app/api/pos2/menu/route');
    const res = await GET(get());
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe('POS server is not configured');
  });
});
