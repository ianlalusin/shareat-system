import { config } from 'dotenv';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * T-455 S3 (TESTER) - the customer lobby SERVER side: docs/tasks/455-customer-lobby.md section 2.3, 2.6, 2.7, 3.1, 4 (1-3), the S3 row of
 * section 5, and "S2 rulings" / "S2 audit notes". Route handlers are called DIRECTLY with a `Request` (the POS v2 style, apps/pos/src/server/__tests__),
 * against real Postgres via TEST_DATABASE_URL (`_test` name guard). The routes call the S2 domain for real; nothing in the domain is mocked.
 *
 * RED TODAY, for one reason: apps/customer/src/app/api/lobby/{check-in,me,cancel}/route.ts do not exist yet. The shared contract (paths, shapes, cookie,
 * env names, status codes, each tied to a spec line) is in the S3 CONTRACT.md in the tester's scratchpad; a QUESTION there means the spec is silent.
 *
 * HOW A REFUSAL IS ASSERTED: exact HTTP status AND exact body (toEqual). A diner body is `{ ok: false, error: <one plain sentence> }` and NEVER carries the
 * machine code (section 4.1, S2 ruling 2): the codes are for logs and tests only, so the counter-sentence limits answer byte-for-byte the same.
 *
 * ENV: the tests set LOBBY_HASH_SECRET, LOBBY_ORG_ID and DATABASE_URL before the first route import (a route reads process.env per request, never at import).
 * apps/customer/vitest.config.mts must therefore alias @shareat/db|domain|core/* like the root config does (the builder adds that; it is config, not test).
 *
 * MUTANT INDEX (each test title ends with "[kills: ...]"):
 *  cookie not HttpOnly / not Secure (or Secure only when NODE_ENV=production) / SameSite None|Strict|absent / constant, short or guessable value / Domain set;
 *  raw cookie or raw ip stored; unsalted or non-HMAC hash; ip taken from a client-chosen header; a second row for the same cookie; clientRequestId not required,
 *  any 1-64 chars accepted, replay creating a row, another device allowed to reuse it; no cookie answered 200/404 instead of 401; any cookie reads or cancels any
 *  entry; cookie valid across stores; cancel works twice; body cap off, off by one, applied to check-in only; a refusal that names its limit (status, sentence
 *  or code in the body); unknown store told apart from a closed one; missing secret/org falling back to a default; responses cacheable;
 *  name, note, ip, cookie value, hand-off url or secret in any log channel; hand-off url returned twice or to another cookie.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

// ---------------------------------------------------------------------------------------------- log capture (3 channels)
const hoisted = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@shareat/core/logger', () => {
  const rec = (...a: unknown[]) => {
    hoisted.lines.push(JSON.stringify(a, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v)));
  };
  const l: Record<string, unknown> = { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec, log: rec };
  l.child = () => l;
  return { logger: l, childLogger: () => l, newCorrelationId: () => 'corr-test', jobResult: (job: string, counts: unknown) => rec(job, counts) };
});

const SECRET = 'lobby-test-secret-Zk3-Qm9-Xv2-77bT-ab12cd34';
const sql = postgres(url, { max: 4 });

let orgId = '';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}-${randomBytes(3).toString('hex')}Q`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const hmacHex = (v: string) => createHmac('sha256', SECRET).update(v).digest('hex');

beforeAll(async () => {
  const code = uid('t455s3');
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
    /* the module may not resolve while the routes are missing; the pool then never opened */
  }
  await sql.end({ timeout: 5 });
});

async function capturing<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  hoisted.lines.length = 0;
  const parts: string[] = [];
  const keep = (...a: unknown[]) => void parts.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(keep),
    vi.spyOn(console, 'info').mockImplementation(keep),
    vi.spyOn(console, 'warn').mockImplementation(keep),
    vi.spyOn(console, 'error').mockImplementation(keep),
    vi.spyOn(console, 'debug').mockImplementation(keep),
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => (parts.push(String(c)), true)) as never),
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (parts.push(String(c)), true)) as never),
  ];
  try {
    const value = await fn();
    return { value, text: `${parts.join('\n')}\n${hoisted.lines.join('\n')}` };
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
}

// ---------------------------------------------------------------------------------------------- fixtures
type Store = { id: string; code: string };
async function mkStore(o: { enabled?: boolean; paused?: boolean; max?: number; posSeenMinutesAgo?: number | null; row?: boolean } = {}): Promise<Store> {
  const code = uid('ST');
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${code}, 'Lipa') returning id`;
  if (o.row !== false) {
    const seen = o.posSeenMinutesAgo === undefined ? ago(0) : o.posSeenMinutesAgo === null ? null : ago(o.posSeenMinutesAgo);
    await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, pos_seen_at)
              values (${orgId}, ${st!.id}, ${o.enabled ?? true}, ${o.paused ?? false}, ${o.max ?? 60}, ${seen})`;
  }
  return { id: st!.id, code };
}
const countEntries = async (s: Store) => (await sql<{ n: number }[]>`select count(*)::int n from lobby_entries where store_id = ${s.id}`)[0]!.n;
const entryRow = async (id: string) => (await sql<Record<string, any>[]>`select * from lobby_entries where id = ${id}`)[0]!;

// ---------------------------------------------------------------------------------------------- request helpers
const ORIGIN = 'http://order.test';
let ipN = 0;
const freshIp = () => `203.0.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const PARTY = { displayName: 'Zanzibar Quillfeather', partySize: 4, note: 'senior id 9Q4X-7731-ZK' };
const SORRY_COUNTER = { ok: false, error: 'Please check in at the counter.' };
const SORRY_BAD_INPUT = { ok: false, error: 'Please check the name, party size and order, then try again.' };
const SORRY_NOT_FOUND = { ok: false, error: 'We could not find that place in line.' };
const SORRY_CLOSED = { ok: false, error: 'That place in line is already closed.' };
const SORRY_TOO_LARGE = { ok: false, error: 'That request is too large.' };

function mk(path: string, o: { method?: string; body?: unknown; cookie?: string | null; ip?: string | null } = {}): Request {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.cookie) headers.cookie = `lobby_dev=${o.cookie}`;
  if (o.ip !== null) headers['x-real-ip'] = o.ip ?? freshIp();
  return new Request(`${ORIGIN}${path}`, {
    method: o.method ?? 'POST',
    headers,
    body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
  });
}
const routes = {
  checkIn: async () => (await import('@/app/api/lobby/check-in/route')).POST,
  me: async () => (await import('@/app/api/lobby/me/route')).GET,
  cancel: async () => (await import('@/app/api/lobby/cancel/route')).POST,
};
interface Reply { res: Response; status: number; body: any; setCookie: string | null; cookie: string | null }
async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparsable: text };
  }
  const setCookie = res.headers.get('set-cookie');
  const m = setCookie?.match(/^lobby_dev=([^;]*)/);
  return { res, status: res.status, body, setCookie, cookie: m ? m[1]! : null };
}
async function checkIn(s: Store, o: { body?: Record<string, unknown> | string; cookie?: string | null; ip?: string | null } = {}): Promise<Reply> {
  const body = typeof o.body === 'string' ? o.body : { storeCode: s.code, ...PARTY, clientRequestId: randomUUID(), ...(o.body ?? {}) };
  return reply(await (await routes.checkIn())(mk('/api/lobby/check-in', { body, cookie: o.cookie, ip: o.ip })));
}
async function me(s: Store | null, cookie: string | null, q?: string): Promise<Reply> {
  const qs = q ?? (s ? `?s=${encodeURIComponent(s.code)}` : '');
  return reply(await (await routes.me())(mk(`/api/lobby/me${qs}`, { method: 'GET', cookie })));
}
async function cancel(s: Store, cookie: string | null, body?: unknown): Promise<Reply> {
  return reply(await (await routes.cancel())(mk('/api/lobby/cancel', { body: body ?? { storeCode: s.code }, cookie })));
}
const strangerCookie = () => randomBytes(32).toString('base64url');
const expectJsonNoStore = (r: Reply) => {
  expect(r.res.headers.get('content-type'), 'json').toMatch(/application\/json/);
  expect(r.res.headers.get('cache-control'), 'a diner reply is private to one phone and must not be cached').toMatch(/no-store/);
};

// ================================================================================================ 0. the capture helper itself (positive control)
describe('0. the log-capture helper catches all three channels', () => {
  it('0.1 a sentinel written to console, stderr, stdout and the shared logger is seen; silence is seen as silence [kills: a capture that always returns empty]', async () => {
    const { text } = await capturing(async () => {
      console.log('SENTINEL-console');
      process.stderr.write('SENTINEL-stderr\n');
      process.stdout.write('SENTINEL-stdout\n');
      const { logger } = await import('@shareat/core/logger');
      (logger as any).info({ x: 'SENTINEL-logger' }, 'hello');
    });
    for (const s of ['SENTINEL-console', 'SENTINEL-stderr', 'SENTINEL-stdout', 'SENTINEL-logger']) expect(text, s).toContain(s);
    const quiet = await capturing(async () => 1);
    expect(quiet.text.trim()).toBe('');
  });
});

// ================================================================================================ A. check-in, the cookie, the hashes
describe('A. POST /api/lobby/check-in', () => {
  it('A1 a check-in answers 200 with the entry and writes one waiting lobby entry [kills: wrong status, extra keys such as phone/hash/ip, cacheable reply, row not written]', async () => {
    const s = await mkStore();
    const r = await checkIn(s);
    expect(r.status).toBe(200);
    expectJsonNoStore(r);
    expect(Object.keys(r.body).sort()).toEqual(['created', 'entry', 'ok']);
    expect(r.body.ok).toBe(true);
    expect(r.body.created).toBe(true);
    expect(Object.keys(r.body.entry).sort()).toEqual(['code', 'entryId', 'partiesAhead', 'status']);
    expect(r.body.entry.code).toMatch(/^[1-9][0-9]{3}$/);
    expect(r.body.entry.status).toBe('waiting');
    expect(r.body.entry.partiesAhead).toBe(0);
    const row = await entryRow(r.body.entry.entryId);
    expect([row.store_id, row.source, row.status, row.display_name, row.party_size, row.phone]).toEqual([s.id, 'lobby', 'waiting', PARTY.displayName, 4, null]);
    expect(await countEntries(s)).toBe(1);
  });

  it('A2 Set-Cookie is lobby_dev, HttpOnly, Secure (over plain http too), SameSite=Lax, Path=/api/lobby, no Domain, 256-bit random, different each time [kills: not HttpOnly, Secure only in production, SameSite None/Strict/absent, Domain set, constant or short value]', async () => {
    const s = await mkStore();
    const a = await checkIn(s);
    const b = await checkIn(s);
    for (const r of [a, b]) {
      expect(r.status).toBe(200);
      expect(r.setCookie, 'Set-Cookie on check-in').toBeTruthy();
      const attrs = r.setCookie!.split(';').map((x) => x.trim());
      expect(attrs[0]).toMatch(/^lobby_dev=[A-Za-z0-9_-]{43}$/);
      const lower = attrs.slice(1).map((x) => x.toLowerCase());
      expect(lower).toContain('httponly');
      expect(lower).toContain('secure');
      expect(lower).toContain('samesite=lax');
      expect(lower).toContain('path=/api/lobby');
      expect(lower.some((x) => x.startsWith('domain='))).toBe(false);
      expect(lower.some((x) => x.startsWith('max-age=') || x.startsWith('expires=')), 'the cookie must outlive a page reload').toBe(true);
    }
    expect(a.cookie).not.toBe(b.cookie);
  });

  it('A3 only HMAC hashes reach the database: device_hash = HMAC(secret, cookie), ip_hash = HMAC(secret, x-real-ip); no raw cookie or ip in any column [kills: raw value stored, unsalted sha256, wrong secret, ip taken from another header]', async () => {
    const s = await mkStore();
    const ip = '198.51.100.23';
    const r = await checkIn(s, { ip });
    expect(r.status).toBe(200);
    const row = await entryRow(r.body.entry.entryId);
    expect(row.device_hash).toBe(hmacHex(r.cookie!));
    expect(row.ip_hash).toBe(hmacHex(ip));
    const all = (await sql<{ t: string }[]>`select to_jsonb(e)::text t from lobby_entries e where e.id = ${r.body.entry.entryId}`)[0]!.t;
    expect(all, 'positive control: the row dump does hold the hash').toContain(hmacHex(r.cookie!));
    expect(all).not.toContain(r.cookie!);
    expect(all).not.toContain(ip);
    // a client-chosen header must not pick the ip that is limited: x-forwarded-for is ignored when x-real-ip is present
    const req = new Request(`${ORIGIN}/api/lobby/check-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.24', 'x-forwarded-for': '1.2.3.4' },
      body: JSON.stringify({ storeCode: s.code, ...PARTY, clientRequestId: randomUUID() }),
    });
    const spoofed = await reply(await (await routes.checkIn())(req));
    expect((await entryRow(spoofed.body.entry.entryId)).ip_hash).toBe(hmacHex('198.51.100.24'));
  });

  it('A4 the same cookie again returns the SAME entry and code (no second row); a replayed clientRequestId does too [kills: second row per phone, replay creating a row, code changing]', async () => {
    const s = await mkStore();
    const rid = randomUUID();
    const first = await checkIn(s, { body: { clientRequestId: rid } });
    const again = await checkIn(s, { cookie: first.cookie, body: { clientRequestId: randomUUID() } });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.entry.entryId).toBe(first.body.entry.entryId);
    expect(again.body.entry.code).toBe(first.body.entry.code);
    const replay = await checkIn(s, { cookie: first.cookie, body: { clientRequestId: rid } });
    expect(replay.body.entry.entryId).toBe(first.body.entry.entryId);
    expect(await countEntries(s)).toBe(1);
  });

  it('A5 another phone cannot reuse a clientRequestId already taken: 400 with the bad-input sentence, the first entry untouched, no second row [kills: id not scoped to the device; S2 audit note]', async () => {
    const s = await mkStore();
    const rid = randomUUID();
    const mine = await checkIn(s, { body: { clientRequestId: rid } });
    const theirs = await checkIn(s, { body: { clientRequestId: rid } });
    expect(theirs.status).toBe(400);
    expect(theirs.body).toEqual(SORRY_BAD_INPUT);
    expect(await countEntries(s)).toBe(1);
    expect((await entryRow(mine.body.entry.entryId)).status).toBe('waiting');
  });

  it('A6 clientRequestId must be uuid-shaped: missing, empty, short, any other 1-64 chars, a number, braces, a suffix, null: 400, nothing written; v4 and v7 shapes pass [kills: any string accepted, optional id, a regex without anchors]', async () => {
    const s = await mkStore();
    const bad: unknown[] = [undefined, '', '1', 'abc', 'x'.repeat(64), 12345, '{3f2b8c1e-8d5a-4b7e-9c11-0a1b2c3d4e5f}', '3f2b8c1e-8d5a-4b7e-9c11-0a1b2c3d4e5f-extra', 'x3f2b8c1e-8d5a-4b7e-9c11-0a1b2c3d4e5f', '3f2b8c1e8d5a4b7e9c110a1b2c3d4e5f', null];
    for (const v of bad) {
      const body: Record<string, unknown> = { storeCode: s.code, ...PARTY };
      if (v !== undefined) body.clientRequestId = v;
      const r = await checkIn(s, { body: JSON.stringify(body) });
      expect(r.status, `clientRequestId=${JSON.stringify(v)}`).toBe(400);
      expect(r.body, `clientRequestId=${JSON.stringify(v)}`).toEqual(SORRY_BAD_INPUT);
    }
    expect(await countEntries(s), 'no row for any refused id').toBe(0);
    for (const good of [randomUUID(), '018f3c2e-7a41-7b3c-9d52-3e4f5a6b7c8d']) {
      const ok = await checkIn(s, { body: { clientRequestId: good } });
      expect(ok.status, good).toBe(200);
    }
  });

  it('A7 bad party input answers 400 with the bad-input sentence and writes nothing (size 0/31/1.5/"4", empty or 41-char name, 61-char note, 21 lines, non-object body, broken json) [kills: no validation, validation after insert, 500 instead of 400, a body that echoes the input]', async () => {
    const s = await mkStore();
    const lines21 = Array.from({ length: 21 }, () => ({ variantId: randomUUID(), qty: 1, lineKind: 'a_la_carte' }));
    const cases: Record<string, unknown>[] = [
      { partySize: 0 }, { partySize: 31 }, { partySize: 1.5 }, { partySize: '4' },
      { displayName: '' }, { displayName: 'N'.repeat(41) }, { note: 'n'.repeat(61) }, { lines: lines21 },
    ];
    for (const c of cases) {
      const r = await checkIn(s, { body: c });
      expect([r.status, r.body], JSON.stringify(c).slice(0, 80)).toEqual([400, SORRY_BAD_INPUT]);
    }
    for (const raw of ['not json {', '[]', 'null', '"x"', '']) {
      const r = await checkIn(s, { body: raw });
      expect([r.status, r.body], `raw=${raw}`).toEqual([400, SORRY_BAD_INPUT]);
    }
    expect(await countEntries(s)).toBe(0);
  });

  it('A8 a server that is not configured (no LOBBY_HASH_SECRET, or no LOBBY_ORG_ID) answers 503 with the counter sentence and writes nothing; it never falls back to a default secret [kills: default secret, fail-open, 500]', async () => {
    const s = await mkStore();
    for (const name of ['LOBBY_HASH_SECRET', 'LOBBY_ORG_ID'] as const) {
      const prev = process.env[name];
      delete process.env[name];
      try {
        const r = await checkIn(s);
        expect([r.status, r.body], `${name} missing`).toEqual([503, SORRY_COUNTER]);
        expect(r.setCookie, 'no cookie issued by an unconfigured server').toBeNull();
      } finally {
        process.env[name] = prev;
      }
    }
    expect(await countEntries(s)).toBe(0);
    expect((await checkIn(s)).status, 'positive control: configured again').toBe(200);
  });
});

describe('E. audit follow-ups', () => {
  it('E1 (F2) LOBBY_HASH_SECRET shorter than 32 characters is "not configured": 503 counter sentence, no cookie, no row; 32 characters works [kills: any non-empty secret accepted, off-by-one on the minimum]', async () => {
    const s = await mkStore();
    const prev = process.env.LOBBY_HASH_SECRET;
    try {
      for (const weak of ['x', 'a'.repeat(31)]) {
        process.env.LOBBY_HASH_SECRET = weak;
        const r = await checkIn(s);
        expect([r.status, r.body], `secret length ${weak.length}`).toEqual([503, SORRY_COUNTER]);
        expect(r.setCookie).toBeNull();
      }
      expect(await countEntries(s)).toBe(0);
      process.env.LOBBY_HASH_SECRET = 'Qk7'.repeat(10) + 'ab'; // exactly 32
      expect((await checkIn(s)).status, 'positive control: 32 characters').toBe(200);
    } finally {
      process.env.LOBBY_HASH_SECRET = prev;
    }
  });

  it('E2 (F3) with no x-real-ip the answer is 503 even when NODE_ENV is "test"; only the explicit LOBBY_TEST_IP_STANDIN setting lets a request through [kills: stand-in keyed on NODE_ENV, one shared bucket for header-less requests]', async () => {
    const s = await mkStore();
    const prevEnv = process.env.NODE_ENV;
    const prevStand = process.env.LOBBY_TEST_IP_STANDIN;
    (process.env as Record<string, string>).NODE_ENV = 'test';
    delete process.env.LOBBY_TEST_IP_STANDIN;
    try {
      const r = await checkIn(s, { ip: null });
      expect([r.status, r.body]).toEqual([503, SORRY_COUNTER]);
      expect(r.setCookie).toBeNull();
      expect(await countEntries(s)).toBe(0);
      process.env.LOBBY_TEST_IP_STANDIN = 'injected-ip-for-tests';
      const ok = await checkIn(s, { ip: null });
      expect(ok.status, 'positive control: explicit stand-in').toBe(200);
      expect((await entryRow(ok.body.entry.entryId)).ip_hash).toBe(hmacHex('injected-ip-for-tests'));
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prevEnv;
      if (prevStand === undefined) delete process.env.LOBBY_TEST_IP_STANDIN;
      else process.env.LOBBY_TEST_IP_STANDIN = prevStand;
    }
  });
});

// ================================================================================================ B. whose entry is it
describe('B. GET /api/lobby/me and POST /api/lobby/cancel: only the owning cookie', () => {
  it('B1 no cookie -> 401 on /me with the not-found sentence, even when the store code is right [kills: 200/404/500 without a cookie, a store-code lookup that answers]', async () => {
    const s = await mkStore();
    await checkIn(s);
    const r = await me(s, null);
    expect([r.status, r.body]).toEqual([401, SORRY_NOT_FOUND]);
    expectJsonNoStore(r);
    expect(r.setCookie).toBeNull();
  });

  it('B2 a malformed cookie is no cookie: 401 [kills: a bad cookie reaching the hash and answering 404/500]', async () => {
    const s = await mkStore();
    for (const c of ['short', 'a'.repeat(200), '%%%', '']) {
      const r = await reply(await (await routes.me())(new Request(`${ORIGIN}/api/lobby/me?s=${s.code}`, { headers: { cookie: `lobby_dev=${c}`, 'x-real-ip': freshIp() } })));
      expect([r.status, r.body], `cookie=${c.slice(0, 12)}`).toEqual([401, SORRY_NOT_FOUND]);
    }
  });

  it('B3 the owner reads their place: 200 with exactly the diner view and the matching code [kills: leaking phone/ip/device_hash, wrong keys]', async () => {
    const s = await mkStore();
    const mine = await checkIn(s);
    const r = await me(s, mine.cookie);
    expect(r.status).toBe(200);
    expectJsonNoStore(r);
    expect(r.body.ok).toBe(true);
    expect(Object.keys(r.body.entry).sort()).toEqual(['code', 'displayName', 'entryId', 'handoffUrl', 'partiesAhead', 'partySize', 'standLabel', 'status']);
    expect(r.body.entry).toMatchObject({ entryId: mine.body.entry.entryId, code: mine.body.entry.code, status: 'waiting', displayName: PARTY.displayName, partySize: 4, standLabel: null, handoffUrl: null });
  });

  it('B4 another phone cannot read or cancel an entry: 404 for both, and the owner still holds a waiting place afterwards [kills: any cookie reads any entry, cancel by anybody, cancel keyed by code or store only]', async () => {
    const s = await mkStore();
    const mine = await checkIn(s);
    const other = await checkIn(s); // a second phone, its own entry
    const stranger = strangerCookie();
    const read = await me(s, stranger);
    expect([read.status, read.body]).toEqual([404, SORRY_NOT_FOUND]);
    const cancelled = await cancel(s, stranger);
    expect([cancelled.status, cancelled.body]).toEqual([404, SORRY_NOT_FOUND]);
    expect((await entryRow(mine.body.entry.entryId)).status, 'owner untouched').toBe('waiting');
    expect((await entryRow(other.body.entry.entryId)).status, 'second phone untouched').toBe('waiting');
    // each phone reads its OWN entry (positive control)
    expect((await me(s, other.cookie)).body.entry.entryId).toBe(other.body.entry.entryId);
    expect((await me(s, mine.cookie)).body.entry.entryId).toBe(mine.body.entry.entryId);
  });

  it('B5 the cookie of one store means nothing at another; an unknown or missing store code is the same 404 [kills: cookie valid across stores, unknown store told apart from not-found]', async () => {
    const s1 = await mkStore();
    const s2 = await mkStore();
    const mine = await checkIn(s1);
    expect(await me(s2, mine.cookie)).toMatchObject({ status: 404, body: SORRY_NOT_FOUND });
    expect(await cancel(s2, mine.cookie)).toMatchObject({ status: 404, body: SORRY_NOT_FOUND });
    expect(await me(null, mine.cookie, '?s=NOSUCHSTORE')).toMatchObject({ status: 404, body: SORRY_NOT_FOUND });
    expect(await me(null, mine.cookie, '')).toMatchObject({ status: 404, body: SORRY_NOT_FOUND });
    expect((await entryRow(mine.body.entry.entryId)).status).toBe('waiting');
    expect((await me(s1, mine.cookie)).status, 'positive control: at its own store').toBe(200);
  });

  it('B6 no cookie cannot cancel: 401; the owner can: 200 and the row is cancelled; a second cancel is 409 closed; /me then reports cancelled [kills: unauthenticated cancel, cancel not persisted, double cancel allowed]', async () => {
    const s = await mkStore();
    const mine = await checkIn(s);
    const anon = await cancel(s, null);
    expect([anon.status, anon.body]).toEqual([401, SORRY_NOT_FOUND]);
    expect((await entryRow(mine.body.entry.entryId)).status).toBe('waiting');
    const ok = await cancel(s, mine.cookie);
    expect(ok.status).toBe(200);
    expectJsonNoStore(ok);
    expect(ok.body).toEqual({ ok: true, entry: { entryId: mine.body.entry.entryId, status: 'cancelled' } });
    expect((await entryRow(mine.body.entry.entryId)).status).toBe('cancelled');
    const twice = await cancel(s, mine.cookie);
    expect([twice.status, twice.body]).toEqual([409, SORRY_CLOSED]);
    expect((await me(s, mine.cookie)).body.entry.status).toBe('cancelled');
  });

  it('B7 the hand-off link is returned once, only to the owning cookie, and never logged [kills: returned twice, shown to another cookie, link in a log line]', async () => {
    const s = await mkStore();
    const mine = await checkIn(s);
    const LINK = 'https://customer.example.test/join?token=HANDOFFTOKEN9zq41';
    await sql`update lobby_entries set status = 'seated', session_ref = ${uid('SESS')}, stand_label = '7', closed_at = now(),
              handoff_url = ${LINK}, handoff_expires_at = now() + interval '1 hour' where id = ${mine.body.entry.entryId}`;
    const stranger = await me(s, strangerCookie());
    expect(JSON.stringify(stranger.body)).not.toContain('HANDOFFTOKEN9zq41');
    const { value: first, text } = await capturing(() => me(s, mine.cookie));
    expect(first.body.entry.handoffUrl).toBe(LINK);
    expect(first.body.entry.status).toBe('seated');
    expect(first.body.entry.standLabel).toBe('7');
    expect(text, 'a bearer link in a log line').not.toContain('HANDOFFTOKEN9zq41');
    const second = await me(s, mine.cookie);
    expect(second.body.entry.handoffUrl, 'the second read must not return the bearer link again').toBeNull();
  });
});

// ================================================================================================ C. limits and one-sentence refusals
describe('C. body size, and refusals that never say which limit', () => {
  const pad = (bytes: number, base: Record<string, unknown>) => {
    const json = JSON.stringify(base);
    return json + ' '.repeat(bytes - Buffer.byteLength(json));
  };

  it('C1 a body of 16 KB + 1 byte is refused 413 with the too-large sentence on check-in AND cancel, nothing written; exactly 16 KB still passes the gate [kills: no cap, off-by-one, cap on check-in only]', async () => {
    const s = await mkStore();
    const base = { storeCode: s.code, ...PARTY, clientRequestId: randomUUID() };
    const tooBig = pad(16 * 1024 + 1, base);
    expect(Buffer.byteLength(tooBig)).toBe(16385);
    const r = await checkIn(s, { body: tooBig });
    expect([r.status, r.body]).toEqual([413, SORRY_TOO_LARGE]);
    const huge = await checkIn(s, { body: pad(1024 * 1024, base) });
    expect([huge.status, huge.body]).toEqual([413, SORRY_TOO_LARGE]);
    expect(await countEntries(s), 'nothing written for an oversize body').toBe(0);
    const mine = await checkIn(s);
    const c = await cancel(s, mine.cookie, pad(16 * 1024 + 1, { storeCode: s.code }));
    expect([c.status, c.body]).toEqual([413, SORRY_TOO_LARGE]);
    expect((await entryRow(mine.body.entry.entryId)).status, 'oversize cancel changed nothing').toBe('waiting');
    // boundary: exactly 16384 bytes of valid JSON is not oversize
    const s2 = await mkStore();
    const exact = pad(16 * 1024, { storeCode: s2.code, ...PARTY, clientRequestId: randomUUID() });
    expect(Buffer.byteLength(exact)).toBe(16384);
    const ok = await checkIn(s2, { body: exact });
    expect(ok.status, 'exactly 16 KB is allowed').toBe(200);
  });

  it('C2 paused, disabled, no lobby row, POS never seen, POS stale, store full, unknown store: ONE status and ONE body for all, without any code or limit word [kills: a refusal naming its limit by status, sentence or code; unknown store distinguishable]', async () => {
    const full = await mkStore({ max: 1 });
    await checkIn(full); // takes the only slot
    const cases: [string, Store][] = [
      ['paused', await mkStore({ paused: true })],
      ['disabled', await mkStore({ enabled: false })],
      ['no lobby row', await mkStore({ row: false })],
      ['pos never seen', await mkStore({ posSeenMinutesAgo: null })],
      ['pos stale', await mkStore({ posSeenMinutesAgo: 10 })],
      ['full', full],
      ['unknown store', { id: 'x', code: 'NOSUCHSTORE' }],
    ];
    for (const [name, s] of cases) {
      const r = await checkIn(s);
      expect([r.status, r.body], name).toEqual([409, SORRY_COUNTER]);
      expect(Object.keys(r.body).sort(), name).toEqual(['error', 'ok']);
      expect(JSON.stringify(r.body), name).not.toMatch(/LOBBY_|limit|paused|disabled|full|stale|too many|rate|cap/i);
      expectJsonNoStore(r);
    }
    for (const [name, s] of cases.slice(0, 5)) expect(await countEntries(s), `${name}: no row`).toBe(0);
    expect((await checkIn(await mkStore())).status, 'positive control: a healthy store').toBe(200);
  });

  it('C3 the sixth check-in from one network at one store in an hour is refused with the SAME 409 counter sentence; another network, and another store, still pass [kills: limit absent, off by one, global instead of per store, per cookie instead of per network]', async () => {
    const s = await mkStore();
    const other = await mkStore();
    const ip = '192.0.2.77';
    for (let i = 1; i <= 5; i++) expect((await checkIn(s, { ip })).status, `check-in ${i}`).toBe(200);
    const sixth = await checkIn(s, { ip });
    expect([sixth.status, sixth.body]).toEqual([409, SORRY_COUNTER]);
    expect(await countEntries(s)).toBe(5);
    expect((await checkIn(s, { ip: '192.0.2.78' })).status, 'another network').toBe(200);
    expect((await checkIn(other, { ip })).status, 'another store, same network').toBe(200);
  });
});

// ================================================================================================ D. logs
describe('D. no personal data in any log channel (section 4.3)', () => {
  const NAME_BITS = ['Zanzibar', 'Quillfeather', '9Q4X-7731'];

  it('D1 a known name and ID-like note pushed through check-in, replay, /me, cancel, bad input, broken json, oversize body and a refusal leave none of them (nor the cookie value, the raw ip, or the HMAC secret) in console, stdout/stderr or the shared logger [kills: logging the body, the error, the url, the cookie, the ip or the secret]', async () => {
    const s = await mkStore();
    const paused = await mkStore({ paused: true });
    const ip = '198.51.100.201';
    const { value: cookie, text } = await capturing(async () => {
      const a = await checkIn(s, { ip });
      await checkIn(s, { cookie: a.cookie, ip });
      await me(s, a.cookie);
      await me(s, strangerCookie());
      await cancel(s, strangerCookie());
      await cancel(s, a.cookie);
      await cancel(s, a.cookie);
      await checkIn(s, { body: { partySize: 99 }, ip });
      await checkIn(s, { body: { clientRequestId: 'not-a-uuid' }, ip });
      await checkIn(s, { body: `{ "displayName": "${PARTY.displayName}", broken`, ip });
      await checkIn(s, { body: JSON.stringify({ storeCode: s.code, ...PARTY, clientRequestId: randomUUID() }) + ' '.repeat(17000), ip });
      const refused = await checkIn(paused, { ip });
      expect(refused.status).toBe(409);
      return a.cookie!;
    });
    for (const bit of [...NAME_BITS, cookie, ip, SECRET]) expect(text, `log output holds ${bit.slice(0, 6)}...`).not.toContain(bit);
    // positive control: the flows really ran and carried those values (the capture is not blind, the check-in was real)
    expect(await countEntries(s)).toBe(1);
    expect((await sql<{ display_name: string }[]>`select display_name from lobby_entries where store_id = ${s.id}`)[0]!.display_name).toBe(PARTY.displayName);
  });
});
