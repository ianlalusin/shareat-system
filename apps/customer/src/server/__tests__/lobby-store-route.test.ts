import { config } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * T-455 S4 (TESTER) - GET /api/lobby/store?s=CODE, the read the lobby screen needs for "store name, N parties waiting" and the paused notice
 * (orchestrator ruling, 25 Oct). Handlers are called directly with a Request against real Postgres (TEST_DATABASE_URL, `_test` guard), as in lobby-routes.test.ts.
 *
 * Contract pinned here: 200 { ok:true, store:{ storeName, partiesWaiting, accepting } }. A closed store (paused / disabled / POS unseen > 5 min / no lobby_stores row)
 * AND an unknown or missing code answer 200 { ok:true, store:{ storeName:'', partiesWaiting:0, accepting:false }, error:'Please check in at the counter.' } with the SAME keys,
 * so the reply never says whether a code exists. No cookie, no x-real-ip, no LOBBY_HASH_SECRET needed. GET only; other methods are not exported (Next answers 405);
 * a body/declared length over 16 KB answers 413. No org id, store id, price or person data in the body; no Set-Cookie; no-store.
 * RED TODAY: apps/customer/src/app/api/lobby/store/route.ts does not exist.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
vi.mock('server-only', () => ({}));

const SECRET = 'lobby-test-secret-Zk3-Qm9-Xv2-77bT-ab12cd34';
const sql = postgres(url, { max: 4 });
let orgId = '';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}-${randomBytes(3).toString('hex')}Q`;
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ORIGIN = 'http://order.test';
const COUNTER = 'Please check in at the counter.';

beforeAll(async () => {
  const code = uid('t455s4');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  orgId = org!.id;
  process.env.LOBBY_HASH_SECRET = SECRET;
  process.env.LOBBY_ORG_ID = orgId;
  process.env.DATABASE_URL = url;
});
afterAll(async () => {
  try {
    const db = await import('@shareat/db');
    await db.closeDb();
  } catch {
    /* module missing while red */
  }
  await sql.end({ timeout: 5 });
});

type Store = { id: string; code: string };
async function mkStore(o: { enabled?: boolean; paused?: boolean; posSeenMinutesAgo?: number | null; row?: boolean } = {}): Promise<Store> {
  const code = uid('ST');
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${code}, 'Lipa Branch') returning id`;
  if (o.row !== false) {
    const seen = o.posSeenMinutesAgo === undefined ? ago(0) : o.posSeenMinutesAgo === null ? null : ago(o.posSeenMinutesAgo);
    await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, pos_seen_at)
              values (${orgId}, ${st!.id}, ${o.enabled ?? true}, ${o.paused ?? false}, 60, ${seen})`;
  }
  return { id: st!.id, code };
}
const countEntries = async () => (await sql<{ n: number }[]>`select count(*)::int n from lobby_entries where org_id = ${orgId}`)[0]!.n;

const getRoute = async () => await import('@/app/api/lobby/store/route');
async function store(code: string | null, headers: Record<string, string> = {}) {
  const mod = await getRoute();
  const res = await mod.GET(new Request(`${ORIGIN}/api/lobby/store${code === null ? '' : `?s=${encodeURIComponent(code)}`}`, { method: 'GET', headers }));
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparsable: text };
  }
  return { res, status: res.status, body, text };
}
async function joinLine(s: Store, name: string) {
  const { POST } = await import('@/app/api/lobby/check-in/route');
  const cookie = randomBytes(32).toString('base64url'); // T-491: a check-in only commits when the phone already holds its cookie
  const r = await POST(
    new Request(`${ORIGIN}/api/lobby/check-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `lobby_dev=${cookie}`, 'x-real-ip': `198.51.${++seq % 250}.${(seq * 7) % 250}` },
      body: JSON.stringify({ storeCode: s.code, displayName: name, partySize: 2, clientRequestId: randomUUID() }),
    }),
  );
  expect(r.status).toBe(200);
  return { res: r, cookie };
}

describe('GET /api/lobby/store', () => {
  it('S1 an open store answers 200 { ok, store:{ storeName, partiesWaiting:0, accepting:true } }, JSON, no-store, no Set-Cookie [kills: wrong shape/status; cacheable reply; a cookie set on a read]', async () => {
    const s = await mkStore();
    const r = await store(s.code);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.res.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.res.headers.get('set-cookie')).toBeNull();
    expect(Object.keys(r.body).sort()).toEqual(['ok', 'store']);
    expect(Object.keys(r.body.store).sort()).toEqual(['accepting', 'partiesWaiting', 'storeName']);
    expect(r.body).toEqual({ ok: true, store: { storeName: 'Lipa Branch', partiesWaiting: 0, accepting: true } });
  });

  it('S2 partiesWaiting counts only waiting|called entries of THIS store [kills: counting cancelled entries, counting another store, a constant]', async () => {
    const a = await mkStore();
    const b = await mkStore();
    await joinLine(a, 'One');
    await joinLine(a, 'Two');
    await joinLine(b, 'Other');
    const cancelled = await joinLine(a, 'Three');
    const cookie = cancelled.cookie;
    const { POST } = await import('@/app/api/lobby/cancel/route');
    const c = await POST(new Request(`${ORIGIN}/api/lobby/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `lobby_dev=${cookie}`, 'x-real-ip': '198.51.100.9' }, body: JSON.stringify({ storeCode: a.code }) }));
    expect(c.status).toBe(200);
    expect((await store(a.code)).body.store.partiesWaiting).toBe(2);
    expect((await store(b.code)).body.store.partiesWaiting).toBe(1);
  });

  it('S3 paused, disabled, POS unseen > 5 min, never seen, and no lobby_stores row all answer accepting:false with the counter sentence [kills: fail-open on any one switch]', async () => {
    const closed = [
      await mkStore({ paused: true }),
      await mkStore({ enabled: false }),
      await mkStore({ posSeenMinutesAgo: 6 }),
      await mkStore({ posSeenMinutesAgo: null }),
      await mkStore({ row: false }),
    ];
    for (const s of closed) {
      const r = await store(s.code);
      expect(r.status, s.code).toBe(200);
      expect(r.body.store.accepting, s.code).toBe(false);
      expect(r.body.error, s.code).toBe(COUNTER);
    }
  });

  it('S4 POS seen 4 minutes ago is still open [kills: a staleness window shorter than the 5 minutes of 4.1]', async () => {
    const s = await mkStore({ posSeenMinutesAgo: 4 });
    expect((await store(s.code)).body.store.accepting).toBe(true);
  });

  it('S5 an unknown code, a missing code and an empty code are byte-identical in shape to a paused store [kills: an existence leak (404, different keys, different sentence)]', async () => {
    const paused = await mkStore({ paused: true });
    const shape = (b: any) => JSON.stringify({ top: Object.keys(b).sort(), store: Object.keys(b.store).sort(), error: b.error });
    const ref = shape((await store(paused.code)).body);
    for (const code of ['NOPE-NOT-A-STORE', '', null]) {
      const r = await store(code);
      expect(r.status, String(code)).toBe(200);
      expect(r.body.store.accepting).toBe(false);
      expect(r.body.store.partiesWaiting).toBe(0);
      expect(shape(r.body), String(code)).toBe(ref);
    }
  });

  it('S6 the body carries no org id, store id, price or person data [kills: returning the row]', async () => {
    const s = await mkStore();
    await joinLine(s, 'Zanzibar Quillfeather');
    const { text } = await store(s.code);
    expect(text).not.toContain(orgId);
    expect(text).not.toContain(s.id);
    expect(text).not.toMatch(/Zanzibar|Quillfeather|phone|email|price|amount|total|device|ip_hash/i);
  });

  it('S7 needs no cookie, no x-real-ip and no LOBBY_HASH_SECRET [kills: reusing the check-in glue that fails 401/503]', async () => {
    const s = await mkStore();
    const saved = process.env.LOBBY_HASH_SECRET;
    delete process.env.LOBBY_HASH_SECRET;
    try {
      const r = await store(s.code);
      expect(r.status).toBe(200);
      expect(r.body.store.accepting).toBe(true);
    } finally {
      process.env.LOBBY_HASH_SECRET = saved;
    }
  });

  it('S8 it is read-only: no entry rows are written [kills: a GET that creates or stamps rows]', async () => {
    const s = await mkStore();
    const before = await countEntries();
    await store(s.code);
    await store('NOPE');
    expect(await countEntries()).toBe(before);
  });

  it('S9 GET only: the module exports GET and no POST/PUT/PATCH/DELETE, so every other method is a 405 [kills: a write method on a public read route]', async () => {
    const mod = (await getRoute()) as Record<string, unknown>;
    expect(typeof mod.GET).toBe('function');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(mod[m], m).toBeUndefined();
  });

  it('S10 a declared body over 16 KB is refused 413 with the too-large sentence [kills: no size rule on this route]', async () => {
    const s = await mkStore();
    const r = await store(s.code, { 'content-length': String(16 * 1024 + 1) });
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ ok: false, error: 'That request is too large.' });
  });
});
