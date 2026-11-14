import { isTestDatabaseUrl } from '../../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * T-455 S7a (TESTER) - the diner's senior/PWD discount-claim routes: docs/tasks/455-customer-lobby.md 3.1 (/lobby/discount), 4.1-4.4, the S7a row of 5, "S3 rulings"
 * and the line "the discount-claim log-capture case moves to S7a". Handlers are called DIRECTLY with a `Request` against real Postgres via TEST_DATABASE_URL (the
 * lobby-birthday-routes.test.ts style). The domain runs for real. PERSONAL DATA: names and ID numbers below are SYNTHETIC.
 *
 * RED TODAY, for one reason: apps/customer/src/app/api/lobby/discount/route.ts and .../discount/cancel/route.ts do not exist.
 *
 * CONTRACT ASSUMED (orchestrator to confirm):
 *   POST /api/lobby/discount         body { storeCode, kind: 'senior'|'pwd', holderName, idNumber, ocrAssisted? } -> 200 { ok: true, claims: ClaimView[] }  (the diner's claims after the change)
 *   GET  /api/lobby/discount?s=CODE                                                                               -> 200 { ok: true, claims: ClaimView[] }  ([] = nothing claimed yet)
 *   POST /api/lobby/discount/cancel  body { storeCode, claimId }                                                  -> 200 { ok: true, claims: ClaimView[] }  (the claim becomes expired)
 *   ClaimView = { claimId, kind, status, idMasked ('****1187'), rejectReason, ocrAssisted } - NEVER the name or the full ID number, in any reply, ever.
 *   Auth is the lobby_dev cookie ONLY: no cookie -> 401 and the same sentence as 404. A claimId is only an input of cancel and only works for the cookie's own claim.
 *   Statuses follow S3: 400 bad input (the bad-input sentence), 401/404 "We could not find that place in line.", 413 over 16 KB, 409 for a domain refusal (full, closed entry,
 *   switch off, decided claim) with the refusal's own plain sentence and NO machine code; every reply `cache-control: no-store`. A refusal never echoes what was typed.
 *
 * MUTANT INDEX: no cookie answered 200; any cookie claiming/reading/cancelling for another diner; cookie valid across stores; body id/entry accepted; name or full ID (or a fragment longer than the last 4)
 * in a reply; name/ID in a log; claim > party size 200; kind/name/ID bounds unchecked (a 41-char field accepted); body cap missing; machine code or a limit named; cacheable reply;
 * cancel of someone else's or a decided claim; GET revealing another diner's claims.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
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
  const code = uid('t455s7a');
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
async function mkStore(o: { claims?: boolean } = {}): Promise<Store> {
  const code = uid('ST');
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${code}, 'Lipa') returning id`;
  await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, claims_enabled, pos_seen_at)
            values (${orgId}, ${st!.id}, true, false, 60, ${o.claims ?? true}, now())`;
  return { id: st!.id, code };
}
let codeN = Math.floor(Math.random() * 3000);
// A seated row cannot be inserted without its session (lobby_entries_seated_needs_session_check): it is inserted waiting and seated by the caller.
async function diner(s: Store, o: { status?: string; party?: number } = {}): Promise<{ cookie: string; entryId: string }> {
  const cookie = randomBytes(32).toString('base64url');
  const status = o.status ?? 'waiting';
  const closed = ['cancelled', 'removed', 'expired'].includes(status);
  const [r] = await sql<{ id: string }[]>`
    insert into lobby_entries (org_id, store_id, source, code, display_name, party_size, status, device_hash, ip_hash, client_request_id, created_at, closed_at)
    values (${orgId}, ${s.id}, 'lobby', ${String(1000 + (++codeN % 9000))}, 'Tuckerman Party', ${o.party ?? 3}, ${status === 'seated' ? 'waiting' : status}, ${hmacHex(cookie)}, ${uid('ip')}, ${uid('req')}, ${ago(5)}, ${closed ? ago(1) : null}) returning id`;
  return { cookie, entryId: r!.id };
}
const claimRows = async (entryId: string) => await sql<Record<string, any>[]>`select * from lobby_discount_claims where entry_id = ${entryId} order by created_at, id`;
async function decide(entryId: string, to: 'approved' | 'rejected') {
  const [c] = await claimRows(entryId);
  if (to === 'rejected') await sql`update lobby_discount_claims set status = 'rejected', holder_name = null, id_number = null, reject_reason = 'The card has expired.', decided_at = now() where id = ${c!.id}`;
  else {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Cashier') returning id`;
    await sql`update lobby_discount_claims set status = 'approved', holder_name = null, id_number = null, session_ref = 'S-1', statutory_diner_ref = 'SD-1', acted_by_person_id = ${p!.id}, card_seen_at = now(), decided_at = now() where id = ${c!.id}`;
  }
}

// ---------------------------------------------------------------------------------------------- request helpers
const ORIGIN = 'http://order.test';
let ipN = 0;
const freshIp = () => `198.52.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const SORRY_NOT_FOUND = { ok: false, error: 'We could not find that place in line.' };
const SORRY_BAD_INPUT = { ok: false, error: 'Please check the name, party size and order, then try again.' };
const SORRY_TOO_LARGE = { ok: false, error: 'That request is too large.' };
const HOLDER = 'Zanzibar Quillfeather';
const ID_NO = '0042-5566-1187'; // synthetic

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
  discount: async () => await import('@/app/api/lobby/discount/route'),
  cancel: async () => (await import('@/app/api/lobby/discount/cancel/route')).POST,
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
async function claimIt(s: Store, cookie: string | null, body?: Record<string, unknown> | string): Promise<Reply> {
  const b = typeof body === 'string' ? body : { storeCode: s.code, kind: 'senior', holderName: HOLDER, idNumber: ID_NO, ...(body ?? {}) };
  return reply(await (await routes.discount()).POST(mk('/api/lobby/discount', { body: b, cookie })));
}
async function read(s: Store | null, cookie: string | null, q?: string): Promise<Reply> {
  const qs = q ?? (s ? `?s=${encodeURIComponent(s.code)}` : '');
  return reply(await (await routes.discount()).GET(mk(`/api/lobby/discount${qs}`, { method: 'GET', cookie })));
}
async function cancel(s: Store, cookie: string | null, body?: unknown): Promise<Reply> {
  return reply(await (await routes.cancel())(mk('/api/lobby/discount/cancel', { body: body ?? { storeCode: s.code }, cookie })));
}
const expectNoStore = (r: Reply) => {
  expect(r.res.headers.get('content-type')).toMatch(/application\/json/);
  expect(r.res.headers.get('cache-control'), 'a diner reply is private to one phone and must not be cached').toMatch(/no-store/);
};
const expectPlainRefusal = (r: Reply, status: number) => {
  expect(r.status).toBe(status);
  expect(Object.keys(r.body).sort()).toEqual(['error', 'ok']);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toMatch(/^[A-Z][^\n]{8,160}[.]$/);
  expect(r.body.error).not.toMatch(/LOBBY_|violates|constraint|duplicate|relation|lobby_/i);
  expect(r.body.error).not.toMatch(/Quillfeather|Zanzibar|0042|5566|1187/);
};
/** No reply ever carries the name or any part of the ID number beyond the masked last four. */
const expectNoPii = (r: Reply) => {
  const t = JSON.stringify(r.body);
  expect(t, 'holder name in a reply').not.toMatch(/Quillfeather|Zanzibar/);
  expect(t, 'ID number in a reply').not.toMatch(/0042|5566|00425566/);
  expect(t, 'party name in a reply').not.toMatch(/Tuckerman/);
};

// ================================================================================================ A. claiming
describe('A. POST /api/lobby/discount', () => {
  it('A1 the owner claims: 200 with her claims (six-key-free view: exactly claimId, ocrAssisted, idMasked, kind, rejectReason, status), ID as ****1187, no name, no full ID; one pending row on HER entry [kills: wrong status, extra keys, name/ID in the reply, cacheable reply, row on the wrong entry]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    const r = await claimIt(s, d.cookie);
    expect(r.status).toBe(200);
    expectNoStore(r);
    expect(Object.keys(r.body).sort()).toEqual(['claims', 'ok']);
    expect(r.body.claims).toHaveLength(1);
    expect(Object.keys(r.body.claims[0]).sort()).toEqual(['claimId', 'idMasked', 'kind', 'ocrAssisted', 'rejectReason', 'status']);
    expect(r.body.claims[0]).toMatchObject({ kind: 'senior', status: 'pending', idMasked: '****1187', rejectReason: null, ocrAssisted: false });
    expectNoPii(r);
    const rows = await claimRows(d.entryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', holder_name: HOLDER, id_number: ID_NO, id_last4: '1187', kind: 'senior', id: r.body.claims[0].claimId });
  });

  it('A2 NO COOKIE: 401 and the not-found sentence, nothing written; a malformed cookie the same; an unknown store code is 404 with the same sentence [kills: claiming without the device cookie, a distinguishable unknown-store reply]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    for (const cookie of [null, 'not-a-real-cookie']) {
      const r = await claimIt(s, cookie);
      expect([401, 404], `cookie ${cookie}`).toContain(r.status);
      expect(r.body).toEqual(SORRY_NOT_FOUND);
    }
    expect((await claimIt(s, null)).status).toBe(401);
    const unknown = await claimIt({ id: s.id, code: 'NO-SUCH-STORE' }, d.cookie);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(SORRY_NOT_FOUND);
    expect(await claimRows(d.entryId)).toHaveLength(0);
  });

  it('A3 CROSS-ENTRY / CROSS-STORE: a stranger cookie gets 404; my cookie with ANOTHER store\'s code gets 404; nothing is written for anyone [kills: cookie valid across stores, claim attached to a guessed entry]', async () => {
    const a = await mkStore();
    const b = await mkStore();
    const mine = await diner(a);
    const r1 = await claimIt(a, randomBytes(32).toString('base64url'));
    expect(r1.status).toBe(404);
    expect(r1.body).toEqual(SORRY_NOT_FOUND);
    const r2 = await claimIt(b, mine.cookie);
    expect(r2.status).toBe(404);
    expect(r2.body).toEqual(SORRY_NOT_FOUND);
    expect(await claimRows(mine.entryId)).toHaveLength(0);
  });

  it('A4 no id is an input: a body carrying entryId, claimId or code of ANOTHER diner still acts only on the cookie owner\'s entry [kills: trusting an id from the body]', async () => {
    const s = await mkStore();
    const mine = await diner(s);
    const other = await diner(s);
    const r = await claimIt(s, mine.cookie, { entryId: other.entryId, claimId: other.entryId, code: '1234' });
    expect(r.status).toBe(200);
    expect(await claimRows(mine.entryId)).toHaveLength(1);
    expect(await claimRows(other.entryId)).toHaveLength(0);
  });

  it('A5 CLAIM > PARTY SIZE: a party of 1 may claim once; the second is 409 with a plain sentence (no limit named, nothing typed echoed), still one row; cancelling frees the slot [kills: 200 past the cap, raw check violation as 500, a number named]', async () => {
    const s = await mkStore();
    const d = await diner(s, { party: 1 });
    const first = await claimIt(s, d.cookie);
    expect(first.status).toBe(200);
    const second = await claimIt(s, d.cookie, { holderName: 'Second Holder', idNumber: '7777-8888' });
    expectPlainRefusal(second, 409);
    expect(second.body.error).not.toMatch(/party|\b1\b|one|limit/i);
    expect(await claimRows(d.entryId)).toHaveLength(1);
    expect((await cancel(s, d.cookie, { storeCode: s.code, claimId: first.body.claims[0].claimId })).status).toBe(200);
    expect((await claimIt(s, d.cookie, { idNumber: '7777-8888' })).status).toBe(200);
  });

  it('A6 FIELD BOUNDS: kind other than senior/pwd, name blank or 41 chars, ID under 4 or 41 chars, a number or array for any of them -> 400 with the bad-input sentence, nothing typed echoed, nothing written; 40 chars are fine (4.4: no image in a text field) [kills: no bound, off by one, non-string accepted, echo of the input]', async () => {
    const s = await mkStore();
    const ok = await diner(s);
    expect((await claimIt(s, ok.cookie, { holderName: 'x'.repeat(40), idNumber: '8'.repeat(40) })).status).toBe(200);
    const bads: Array<Record<string, unknown>> = [
      { kind: 'child' }, { kind: undefined }, { kind: 5 },
      { holderName: '' }, { holderName: '   ' }, { holderName: 'y'.repeat(41) }, { holderName: 7 }, { holderName: ['a'] },
      { idNumber: '123' }, { idNumber: '9'.repeat(41) }, { idNumber: '' }, { idNumber: 1234 }, { idNumber: { a: 1 } },
    ];
    for (const bad of bads) {
      const d = await diner(s);
      const r = await claimIt(s, d.cookie, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).toEqual(SORRY_BAD_INPUT);
      expect(await claimRows(d.entryId)).toHaveLength(0);
    }
  });

  it('A7 a broken or non-object body is 400; a body over 16 KB is 413 with the too-large sentence and nothing written [kills: body cap missing on this route, off by one]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    for (const bad of ['{not json', '[]', '"x"', '']) {
      const r = await claimIt(s, d.cookie, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).toEqual(SORRY_BAD_INPUT);
    }
    const big = await claimIt(s, d.cookie, JSON.stringify({ storeCode: s.code, kind: 'senior', holderName: HOLDER, idNumber: ID_NO, pad: 'a'.repeat(17 * 1024) }));
    expect(big.status).toBe(413);
    expect(big.body).toEqual(SORRY_TOO_LARGE);
    expect(await claimRows(d.entryId)).toHaveLength(0);
  });

  it('A8 a cancelled entry, a seated entry and a store with claims_enabled = false each answer 409 with a plain refusal and write nothing [kills: claiming on a dead/seated entry, claims_enabled ignored]', async () => {
    const s = await mkStore();
    for (const status of ['cancelled', 'seated']) {
      const e = await diner(s, { status });
      if (status === 'seated') await sql`update lobby_entries set status = 'seated', session_ref = 'S-1', stand_label = '7', seated_at = now(), closed_at = now() where id = ${e.entryId}`;
      expectPlainRefusal(await claimIt(s, e.cookie), 409);
      expect(await claimRows(e.entryId)).toHaveLength(0);
    }
    const off = await mkStore({ claims: false });
    const d = await diner(off);
    expectPlainRefusal(await claimIt(off, d.cookie), 409);
    expect(await claimRows(d.entryId)).toHaveLength(0);
  });

  it('A9 THE NAME AND THE ID NUMBER NEVER REACH A LOG: claim, refused claim, read, bad input, cancel and an unauthenticated attempt are replayed with a known name and ID, and the captured console/stdout/stderr/logger text holds neither (4.3) [kills: PII in route logs]', async () => {
    const s = await mkStore();
    const d = await diner(s, { party: 1 });
    const { text } = await capturing(async () => {
      const first = await claimIt(s, d.cookie);
      await claimIt(s, d.cookie, { holderName: `${HOLDER}2`, idNumber: '5566-7788-9900' }); // refused: full
      await read(s, d.cookie);
      await claimIt(s, d.cookie, { holderName: 'q'.repeat(41) + HOLDER }); // refused: too long
      await claimIt(s, null); // refused: no cookie
      await cancel(s, d.cookie, { storeCode: s.code, claimId: first.body.claims[0].claimId });
    });
    for (const needle of ['Quillfeather', 'Zanzibar', '0042', '5566', '00425566', '7788', 'Tuckerman', d.cookie]) {
      expect(text.includes(needle), `${needle} in a log`).toBe(false);
    }
  });
});

// ================================================================================================ B. reading
describe('B. GET /api/lobby/discount?s=CODE', () => {
  it('B1 nothing claimed yet: 200 with claims []; no cookie: 401 + the not-found sentence; no or unknown store code: 404 + the same sentence [kills: 404 for "nothing yet", reading without the cookie]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    const empty = await read(s, d.cookie);
    expect(empty.status).toBe(200);
    expectNoStore(empty);
    expect(empty.body).toEqual({ ok: true, claims: [] });
    expect((await read(s, null)).status).toBe(401);
    expect((await read(s, null)).body).toEqual(SORRY_NOT_FOUND);
    const noCode = await read(null, d.cookie);
    expect(noCode.status).toBe(404);
    expect(noCode.body).toEqual(SORRY_NOT_FOUND);
    const unknown = await read(null, d.cookie, '?s=NO-SUCH-STORE');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(SORRY_NOT_FOUND);
  });

  it('B2 ANOTHER DINER CANNOT READ MINE: a stranger cookie at the same store sees [] (own entry, no claims) or 404, my cookie at another store gets 404; neither sees a claim, a name or an ID [kills: any cookie reads any claim, cookie valid across stores]', async () => {
    const a = await mkStore();
    const b = await mkStore();
    const mine = await diner(a);
    const other = await diner(a);
    expect((await claimIt(a, mine.cookie)).status).toBe(200);
    const sameStoreOther = await read(a, other.cookie);
    expect(sameStoreOther.status).toBe(200);
    expect(sameStoreOther.body).toEqual({ ok: true, claims: [] });
    const stranger = await read(a, randomBytes(32).toString('base64url'));
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual(SORRY_NOT_FOUND);
    const otherStore = await read(b, mine.cookie);
    expect(otherStore.status).toBe(404);
    expect(otherStore.body).toEqual(SORRY_NOT_FOUND);
  });

  it('B3 the diner sees what the cashier did, still masked: a rejected claim shows the reason; an approved one shows approved; neither reply holds the name or the full ID [kills: reason not shown, full ID kept after a decision]', async () => {
    const s = await mkStore();
    const rej = await diner(s);
    const acc = await diner(s);
    await claimIt(s, rej.cookie);
    await claimIt(s, acc.cookie);
    await decide(rej.entryId, 'rejected');
    await decide(acc.entryId, 'approved');
    const r = await read(s, rej.cookie);
    expect(r.body.claims).toHaveLength(1);
    expect(r.body.claims[0]).toMatchObject({ status: 'rejected', rejectReason: 'The card has expired.', idMasked: '****1187' });
    expectNoPii(r);
    const a = await read(s, acc.cookie);
    expect(a.body.claims[0]).toMatchObject({ status: 'approved', rejectReason: null, idMasked: '****1187' });
    expectNoPii(a);
  });
});

// ================================================================================================ C. cancelling
describe('C. POST /api/lobby/discount/cancel', () => {
  it('C1 the owner cancels her pending claim by claimId: 200, claims list shows it expired, row expired with name and ID NULL; cancelling again is 409 plain refusal [kills: cancel not written, name kept after cancel, cancel twice]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    const made = await claimIt(s, d.cookie);
    const claimId = made.body.claims[0].claimId;
    const r = await cancel(s, d.cookie, { storeCode: s.code, claimId });
    expect(r.status).toBe(200);
    expectNoStore(r);
    expect(r.body.claims[0]).toMatchObject({ claimId, status: 'expired' });
    expectNoPii(r);
    expect((await claimRows(d.entryId))[0]).toMatchObject({ status: 'expired', holder_name: null, id_number: null });
    expectPlainRefusal(await cancel(s, d.cookie, { storeCode: s.code, claimId }), 409);
  });

  it('C2 CANCEL OF ANOTHER DINER\'S CLAIM: with their claimId and my cookie -> 404 not-found sentence and their claim stays pending with its name; no cookie 401; my cookie at another store 404; a junk or missing claimId is 400/404 and never touches a row [kills: cancelling by claimId alone, cross-store cancel]', async () => {
    const a = await mkStore();
    const b = await mkStore();
    const mine = await diner(a);
    const theirs = await diner(a);
    const t = await claimIt(a, theirs.cookie);
    const theirId = t.body.claims[0].claimId;
    await claimIt(a, mine.cookie);
    const other = await cancel(a, mine.cookie, { storeCode: a.code, claimId: theirId });
    expect(other.status).toBe(404);
    expect(other.body).toEqual(SORRY_NOT_FOUND);
    const none = await cancel(a, null, { storeCode: a.code, claimId: theirId });
    expect(none.status).toBe(401);
    expect(none.body).toEqual(SORRY_NOT_FOUND);
    const cross = await cancel(b, theirs.cookie, { storeCode: b.code, claimId: theirId });
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(SORRY_NOT_FOUND);
    for (const claimId of ['junk', 7, undefined]) {
      const r = await cancel(a, mine.cookie, { storeCode: a.code, claimId });
      expect([400, 404], JSON.stringify(claimId)).toContain(r.status);
    }
    expect((await claimRows(theirs.entryId))[0]).toMatchObject({ status: 'pending', holder_name: HOLDER });
    expect((await claimRows(mine.entryId))[0]!.status).toBe('pending');
  });

  it('C3 a decided claim cannot be cancelled: approved and rejected -> 409 plain refusal and the row is unchanged; a body over 16 KB is 413, a broken body is 400 [kills: cancel after a decision, body cap missing on cancel]', async () => {
    const s = await mkStore();
    const d = await diner(s);
    const made = await claimIt(s, d.cookie);
    const id = made.body.claims[0].claimId;
    await decide(d.entryId, 'approved');
    const before = (await claimRows(d.entryId))[0];
    expectPlainRefusal(await cancel(s, d.cookie, { storeCode: s.code, claimId: id }), 409);
    expect((await claimRows(d.entryId))[0]).toEqual(before);
    const big = await cancel(s, d.cookie, JSON.stringify({ storeCode: s.code, claimId: id, pad: 'a'.repeat(17 * 1024) }));
    expect(big.status).toBe(413);
    expect(big.body).toEqual(SORRY_TOO_LARGE);
    const broken = await cancel(s, d.cookie, '{nope');
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual(SORRY_BAD_INPUT);
  });
});

// ================================================================================================ D. the same card twice
describe('D. a second pending claim with the same ID in one entry', () => {
  it('D1 the same ID again (spaced or hyphenated differently) is 409 with a plain sentence that does not echo it; one row stays [kills: duplicate card accepted, the ID echoed]', async () => {
    const s = await mkStore();
    const d = await diner(s, { party: 4 });
    expect((await claimIt(s, d.cookie)).status).toBe(200);
    const again = await claimIt(s, d.cookie, { holderName: 'Another Holder', idNumber: '004255661187' });
    expectPlainRefusal(again, 409);
    expect(await claimRows(d.entryId)).toHaveLength(1);
    expect((await claimIt(s, d.cookie, { idNumber: '3333-4444-5555' })).status).toBe(200);
  });
});
