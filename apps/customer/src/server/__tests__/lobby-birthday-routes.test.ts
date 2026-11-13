import { redactDbUrl } from '../../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * T-455 S6a (TESTER) - the diner's birthday-song routes: docs/tasks/455-customer-lobby.md 3.1 (/lobby/birthday), 4.1, 4.2, 4.3, the S6a row of 5 and
 * "S3 rulings" (status/sentence contract, cookie, 16 KB cap). Handlers are called DIRECTLY with a `Request` against real Postgres via TEST_DATABASE_URL
 * (the lobby-routes.test.ts style). The domain runs for real.
 *
 * RED TODAY, for one reason: apps/customer/src/app/api/lobby/birthday/route.ts and .../birthday/cancel/route.ts do not exist.
 *
 * CONTRACT ASSUMED (orchestrator to confirm):
 *   POST /api/lobby/birthday         body { storeCode, celebrantName? }  -> 200 { ok: true, birthday: { status, celebrantName, scheduledAt (ISO string | null), declineReason } }
 *   GET  /api/lobby/birthday?s=CODE                                      -> 200 { ok: true, birthday: <same shape> | null }  (null = nothing asked yet)
 *   POST /api/lobby/birthday/cancel  body { storeCode }                  -> 200 { ok: true, birthday: { status: 'cancelled', ... } }
 *   Auth is the lobby_dev cookie ONLY (no entry id, no code, no request id in any input or output): no cookie -> 401 and the same sentence as 404.
 *   Statuses follow S3: 400 bad input, 401/404 "We could not find that place in line.", 413 over 16 KB, 409 for a refusal (second request, closed, wrong state),
 *   each with the domain refusal's own plain sentence and NO machine code in the body. Every reply is `cache-control: no-store`.
 *
 * MUTANT INDEX: no cookie answered 200; any cookie reading/cancelling another diner's request; a cookie valid across stores; an id or code accepted as input;
 * request id / hashes / entry id in the reply; second request 200; name > 40 accepted; body cap missing on these routes; machine code or limit named in a body;
 * cacheable reply; celebrant name in any log channel; cancel after play allowed.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

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
  const code = uid('t455s6a');
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
    /* the module may not resolve while the routes are missing */
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
async function mkStore(o: { birthday?: boolean } = {}): Promise<Store> {
  const code = uid('ST');
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${code}, 'Lipa') returning id`;
  await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, birthday_enabled, pos_seen_at)
            values (${orgId}, ${st!.id}, true, false, 60, ${o.birthday ?? true}, now())`;
  return { id: st!.id, code };
}
let codeN = Math.floor(Math.random() * 3000);
/** A live lobby entry owned by a fresh cookie; the cookie is what the phone sends. */
async function diner(s: Store, status = 'waiting'): Promise<{ cookie: string; entryId: string }> {
  const cookie = randomBytes(32).toString('base64url');
  const [r] = await sql<{ id: string }[]>`
    insert into lobby_entries (org_id, store_id, source, code, display_name, party_size, status, device_hash, ip_hash, client_request_id, created_at)
    values (${orgId}, ${s.id}, 'lobby', ${String(1000 + (++codeN % 9000))}, 'Zanzibar Quillfeather', 4, ${status}, ${hmacHex(cookie)}, ${uid('ip')}, ${uid('req')}, ${ago(5)}) returning id`;
  return { cookie, entryId: r!.id };
}
const birthdayRows = async (entryId: string) => await sql<Record<string, any>[]>`select * from lobby_birthday_requests where entry_id = ${entryId} order by created_at, id`;
/** Move the entry's request by SQL as the cashier would (the trigger stamps accepted_at). */
async function cashierMoves(entryId: string, to: 'accepted' | 'declined' | 'played') {
  const [b] = await birthdayRows(entryId);
  if (to === 'accepted' || to === 'played') await sql`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${new Date(Date.now() + 45 * 60_000).toISOString()} where id = ${b!.id}`;
  if (to === 'played') await sql`update lobby_birthday_requests set status = 'played', played_at = now() where id = ${b!.id}`;
  if (to === 'declined') await sql`update lobby_birthday_requests set status = 'declined', decline_reason = 'Not tonight, the shop is full.' where id = ${b!.id}`;
}

// ---------------------------------------------------------------------------------------------- request helpers
const ORIGIN = 'http://order.test';
let ipN = 0;
const freshIp = () => `198.51.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const SORRY_NOT_FOUND = { ok: false, error: 'We could not find that place in line.' };
const SORRY_BAD_INPUT = { ok: false, error: 'Please check the name, party size and order, then try again.' };
const SORRY_TOO_LARGE = { ok: false, error: 'That request is too large.' };
const CELEBRANT = 'Benedict Quillfeather';

function mk(path: string, o: { method?: string; body?: unknown; cookie?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'x-real-ip': freshIp() };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.cookie) headers.cookie = `lobby_dev=${o.cookie}`;
  return new Request(`${ORIGIN}${path}`, {
    method: o.method ?? 'POST',
    headers,
    body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
  });
}
const routes = {
  birthday: async () => await import('@/app/api/lobby/birthday/route'),
  cancel: async () => (await import('@/app/api/lobby/birthday/cancel/route')).POST,
};
interface Reply { res: Response; status: number; body: any }
async function reply(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparsable: text };
  }
  return { res, status: res.status, body };
}
async function ask(s: Store, cookie: string | null, body?: Record<string, unknown> | string): Promise<Reply> {
  const b = typeof body === 'string' ? body : { storeCode: s.code, celebrantName: CELEBRANT, ...(body ?? {}) };
  return reply(await (await routes.birthday()).POST(mk('/api/lobby/birthday', { body: b, cookie })));
}
async function read(s: Store | null, cookie: string | null, q?: string): Promise<Reply> {
  const qs = q ?? (s ? `?s=${encodeURIComponent(s.code)}` : '');
  return reply(await (await routes.birthday()).GET(mk(`/api/lobby/birthday${qs}`, { method: 'GET', cookie })));
}
async function cancel(s: Store, cookie: string | null, body?: unknown): Promise<Reply> {
  return reply(await (await routes.cancel())(mk('/api/lobby/birthday/cancel', { body: body ?? { storeCode: s.code }, cookie })));
}
const expectNoStore = (r: Reply) => {
  expect(r.res.headers.get('content-type')).toMatch(/application\/json/);
  expect(r.res.headers.get('cache-control'), 'a diner reply is private to one phone and must not be cached').toMatch(/no-store/);
};
/** A refusal body is exactly { ok: false, error: <plain sentence> }: no machine code, no ids. */
const expectPlainRefusal = (r: Reply, status: number) => {
  expect(r.status).toBe(status);
  expect(Object.keys(r.body).sort()).toEqual(['error', 'ok']);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toMatch(/^[A-Z][^\n]{8,160}[.]$/);
  expect(r.body.error).not.toMatch(/LOBBY_|violates|constraint|duplicate|relation|lobby_/i);
};

// ================================================================================================ A. asking
describe('A. POST /api/lobby/birthday', () => {
  it('A1 the owner asks: 200 with the diner view (status, name, time, reason - no ids), one requested row for HER entry [kills: wrong status, extra keys (request id, entry id, hashes), cacheable reply, row on the wrong entry]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    const r = await ask(s, d.cookie);
    expect(r.status).toBe(200);
    expectNoStore(r);
    expect(Object.keys(r.body).sort()).toEqual(['birthday', 'ok']);
    expect(Object.keys(r.body.birthday).sort()).toEqual(['celebrantName', 'declineReason', 'scheduledAt', 'status']);
    expect(r.body).toEqual({ ok: true, birthday: { status: 'requested', celebrantName: CELEBRANT, scheduledAt: null, declineReason: null } });
    const rows = await birthdayRows(d.entryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'requested', celebrant_name: CELEBRANT });
  });

  it('A2 NO COOKIE: 401 and the not-found sentence, nothing written; a malformed cookie is the same; an unknown store code is 404 with the same sentence [kills: asking without the device cookie, a distinguishable unknown-store reply]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    for (const cookie of [null, 'not-a-real-cookie']) {
      const r = await ask(s, cookie);
      expect([401, 404], `cookie ${cookie}`).toContain(r.status);
      expect(r.body).toEqual(SORRY_NOT_FOUND);
    }
    expect((await ask(s, null)).status).toBe(401);
    const unknown = await ask({ id: s.id, code: 'NO-SUCH-STORE' }, d.cookie);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(SORRY_NOT_FOUND);
    expect(await birthdayRows(d.entryId)).toHaveLength(0);
  });

  it('A3 CROSS-ENTRY / CROSS-STORE: a cookie of someone else with no entry gets 404; my cookie used with ANOTHER store\'s code gets 404; nothing is written for anyone [kills: cookie valid across stores, request attached to a guessed entry]', async () => {
    const a = await mkStore();
    const b = await mkStore();
    const mine = await diner(a);
    const stranger = randomBytes(32).toString('base64url');
    const r1 = await ask(a, stranger);
    expect(r1.status).toBe(404);
    expect(r1.body).toEqual(SORRY_NOT_FOUND);
    const r2 = await ask(b, mine.cookie);
    expect(r2.status).toBe(404);
    expect(r2.body).toEqual(SORRY_NOT_FOUND);
    expect(await birthdayRows(mine.entryId)).toHaveLength(0);
    const countRows = await sql<{ n: number }[]>`select count(*)::int n from lobby_birthday_requests r join lobby_entries e on e.id = r.entry_id where e.store_id = ${b.id}`;
    expect(countRows[0]?.n).toBe(0);
  });

  it('A4 no id or code is an input: a body carrying entryId, requestId or code for ANOTHER diner still acts only on the cookie owner\'s entry [kills: trusting an id from the body]', async () => {
    const s = await mkStore();
    const mine = await diner(s);
    const other = await diner(s);
    const r = await ask(s, mine.cookie, { entryId: other.entryId, requestId: other.entryId, code: '1234' });
    expect(r.status).toBe(200);
    expect(await birthdayRows(mine.entryId)).toHaveLength(1);
    expect(await birthdayRows(other.entryId)).toHaveLength(0);
  });

  it('A5 SECOND REQUEST: 409 with the refusal\'s plain sentence and no machine code; still exactly one row; a cancelled one frees the slot [kills: 200 for a second ask, a code or limit named in the body, unique violation as 500]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    expect((await ask(s, d.cookie)).status).toBe(200);
    const second = await ask(s, d.cookie, { celebrantName: 'Other' });
    expectPlainRefusal(second, 409);
    expect(second.body.error).not.toBe('Please check in at the counter.');
    expect(await birthdayRows(d.entryId)).toHaveLength(1);
    expect((await cancel(s, d.cookie)).status).toBe(200);
    expect((await ask(s, d.cookie)).status).toBe(200);
    expect((await birthdayRows(d.entryId)).map((x) => x.status).sort()).toEqual(['cancelled', 'requested']);
  });

  it('A6 the name is optional and limited: omitted is fine (stored NULL); 40 chars ok; 41, a number and an array are 400 with the bad-input sentence and nothing written [kills: name required, no limit, non-string accepted]', async () => {
    const s = await mkStore();
    const none = await diner(s);
    const r0 = await reply(await (await routes.birthday()).POST(mk('/api/lobby/birthday', { body: { storeCode: s.code }, cookie: none.cookie })));
    expect(r0.status).toBe(200);
    expect(r0.body.birthday.celebrantName).toBeNull();
    expect((await birthdayRows(none.entryId))[0]!.celebrant_name).toBeNull();
    const ok = await diner(s);
    expect((await ask(s, ok.cookie, { celebrantName: 'x'.repeat(40) })).status).toBe(200);
    for (const bad of ['y'.repeat(41), 7, ['a']] as unknown[]) {
      const d = await diner(s);
      const r = await ask(s, d.cookie, { celebrantName: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).toEqual(SORRY_BAD_INPUT);
      expect(await birthdayRows(d.entryId)).toHaveLength(0);
    }
  });

  it('A7 a broken or non-object body is 400; a body over 16 KB is 413 with the too-large sentence and nothing written [kills: body cap missing on this route, off by one]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    for (const bad of ['{not json', '[]', '"x"', '']) {
      const r = await ask(s, d.cookie, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).toEqual(SORRY_BAD_INPUT);
    }
    const big = await ask(s, d.cookie, JSON.stringify({ storeCode: s.code, celebrantName: 'a'.repeat(17 * 1024) }));
    expect(big.status).toBe(413);
    expect(big.body).toEqual(SORRY_TOO_LARGE);
    expect(await birthdayRows(d.entryId)).toHaveLength(0);
  });

  it('A8 a closed entry (cancelled) cannot ask: 409 plain refusal, nothing written; a store with the birthday switch off: 409 plain refusal, nothing written [kills: asking on a dead entry, birthday_enabled ignored]', async () => {
    const s = await mkStore();
    const dead = await diner(s, 'cancelled');
    expectPlainRefusal(await ask(s, dead.cookie), 409);
    expect(await birthdayRows(dead.entryId)).toHaveLength(0);
    const off = await mkStore({ birthday: false });
    const d = await diner(off);
    expectPlainRefusal(await ask(off, d.cookie), 409);
    expect(await birthdayRows(d.entryId)).toHaveLength(0);
  });

  it('A9 THE CELEBRANT NAME AND THE PARTY NAME NEVER REACH A LOG: ask, read, refused ask and cancel are replayed with known names and the captured console/stdout/stderr/logger text holds neither [kills: PII in route logs (4.3)]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    const { text } = await capturing(async () => {
      await ask(s, d.cookie);
      await ask(s, d.cookie); // refused: second
      await read(s, d.cookie);
      await cancel(s, d.cookie);
      await ask(s, d.cookie, { celebrantName: 'q'.repeat(41) + CELEBRANT }); // refused: too long
    });
    expect(text.includes(CELEBRANT), 'celebrant name in a log').toBe(false);
    expect(text.includes('Benedict'), 'celebrant name in a log').toBe(false);
    expect(text.includes('Zanzibar'), 'party name in a log').toBe(false);
    expect(text.includes(d.cookie), 'cookie value in a log').toBe(false);
  });
});

// ================================================================================================ B. reading
describe('B. GET /api/lobby/birthday?s=CODE', () => {
  it('B1 nothing asked yet: 200 with birthday null; no cookie: 401 + the not-found sentence; no or unknown store code: 404 + the same sentence [kills: 404 for "nothing yet" (the screen cannot tell), reading without the cookie]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    const empty = await read(s, d.cookie);
    expect(empty.status).toBe(200);
    expectNoStore(empty);
    expect(empty.body).toEqual({ ok: true, birthday: null });
    const noCookie = await read(s, null);
    expect(noCookie.status).toBe(401);
    expect(noCookie.body).toEqual(SORRY_NOT_FOUND);
    const noCode = await read(null, d.cookie);
    expect(noCode.status).toBe(404);
    expect(noCode.body).toEqual(SORRY_NOT_FOUND);
    const unknown = await read(null, d.cookie, '?s=NO-SUCH-STORE');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(SORRY_NOT_FOUND);
  });

  it('B2 ANOTHER DINER CANNOT READ MINE: a stranger cookie at the same store gets 404, my cookie at another store gets 404 - neither sees the name or the status [kills: any cookie reads any request, cookie valid across stores]', async () => {
    const a = await mkStore();
    const b = await mkStore();
    const mine = await diner(a);
    const other = await diner(a);
    expect((await ask(a, mine.cookie)).status).toBe(200);
    const sameStoreOther = await read(a, other.cookie);
    expect(sameStoreOther.status).toBe(200);
    expect(sameStoreOther.body).toEqual({ ok: true, birthday: null });
    expect(JSON.stringify(sameStoreOther.body).includes(CELEBRANT)).toBe(false);
    const otherStore = await read(b, mine.cookie);
    expect(otherStore.status).toBe(404);
    expect(otherStore.body).toEqual(SORRY_NOT_FOUND);
  });

  it('B3 the diner sees what the cashier did: accepted shows the time as an ISO string, declined shows the reason, both with the exact four keys [kills: time or reason not shown, wrong time format]', async () => {
    const s = await mkStore();
    const acc = await diner(s);
    const dec = await diner(s);
    await ask(s, acc.cookie);
    await ask(s, dec.cookie);
    await cashierMoves(acc.entryId, 'accepted');
    await cashierMoves(dec.entryId, 'declined');
    const a = await read(s, acc.cookie);
    expect(a.status).toBe(200);
    expect(a.body.birthday.status).toBe('accepted');
    expect(typeof a.body.birthday.scheduledAt).toBe('string');
    expect(Math.abs(new Date(a.body.birthday.scheduledAt).getTime() - (Date.now() + 45 * 60_000))).toBeLessThan(10_000);
    expect(a.body.birthday.declineReason).toBeNull();
    const d = await read(s, dec.cookie);
    expect(d.body.birthday).toEqual({ status: 'declined', celebrantName: CELEBRANT, scheduledAt: null, declineReason: 'Not tonight, the shop is full.' });
  });

  it('B4 a stale accepted request (30+ minutes past its time) reads as expired [kills: expiry on read missing at the route]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    await ask(s, d.cookie);
    const [b] = await birthdayRows(d.entryId);
    await sql`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${ago(40)} where id = ${b!.id}`;
    const r = await read(s, d.cookie);
    expect(r.body.birthday.status).toBe('expired');
  });
});

// ================================================================================================ C. cancelling
describe('C. POST /api/lobby/birthday/cancel', () => {
  it('C1 the owner cancels a requested request: 200, status cancelled, row cancelled; cancelling again is 409 plain refusal [kills: cancel not written, cancel twice]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    await ask(s, d.cookie);
    const r = await cancel(s, d.cookie);
    expect(r.status).toBe(200);
    expectNoStore(r);
    expect(r.body.ok).toBe(true);
    expect(r.body.birthday.status).toBe('cancelled');
    expect((await birthdayRows(d.entryId))[0]!.status).toBe('cancelled');
    expectPlainRefusal(await cancel(s, d.cookie), 409);
  });

  it('C2 CANCEL AFTER PLAY: 409 plain refusal and the request stays played [kills: cancel after play]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    await ask(s, d.cookie);
    await cashierMoves(d.entryId, 'played');
    expectPlainRefusal(await cancel(s, d.cookie), 409);
    expect((await birthdayRows(d.entryId))[0]!.status).toBe('played');
  });

  it('C3 cancel needs the owning cookie and store: no cookie 401; a stranger 404; my cookie with another store\'s code 404; the request stays requested [kills: any cookie cancels any request, cross-store cancel]', async () => {
    const a = await mkStore();
    const b = await mkStore();
    const mine = await diner(a);
    await ask(a, mine.cookie);
    const none = await cancel(a, null);
    expect(none.status).toBe(401);
    expect(none.body).toEqual(SORRY_NOT_FOUND);
    const stranger = await cancel(a, randomBytes(32).toString('base64url'));
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual(SORRY_NOT_FOUND);
    const cross = await cancel(b, mine.cookie);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(SORRY_NOT_FOUND);
    expect((await birthdayRows(mine.entryId))[0]!.status).toBe('requested');
  });

  it('C4 cancel with nothing asked is 404 (not-found sentence); a body over 16 KB is 413; a broken body is 400 [kills: body cap missing on cancel]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    const none = await cancel(s, d.cookie);
    expect(none.status).toBe(404);
    expect(none.body).toEqual(SORRY_NOT_FOUND);
    const big = await cancel(s, d.cookie, JSON.stringify({ storeCode: s.code, pad: 'a'.repeat(17 * 1024) }));
    expect(big.status).toBe(413);
    expect(big.body).toEqual(SORRY_TOO_LARGE);
    const broken = await cancel(s, d.cookie, '{nope');
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual(SORRY_BAD_INPUT);
  });
});
