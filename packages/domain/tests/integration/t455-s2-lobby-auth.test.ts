import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S2 audit gaps (TESTER), pinned RED before the fixes. Rulings (orchestrator, 25 Oct):
 *  - AUTH: every staff lobby function (listLobbyEntries, callEntry, seatEntry, removeEntry, parkWalkIn) calls
 *    authorize(tx, actor, 'record_sale', { storeId: the entry's / the list's store }) - store-scoped, no new capability.
 *    A1 other-store cashier refused (AuthorizationError, nothing changed) + positive control at their own store;
 *    A2 a role without record_sale ('staff' in the default matrix) refused at its own store, and a denial row is written.
 *  - R2 a clientRequestId replayed from a DIFFERENT device never yields the first entry's id or code.
 *  - C1 two real connections racing for the last place / the last ip-hour slot: exactly one wins, the other gets LOBBY_FULL / LOBBY_IP_LIMIT.
 *
 * MUTANTS: authorize missing in any one of the five functions; authorize called with the org's first store or with no storeId (so
 * a cashier of A passes at B); authorize against the wrong capability; the entry's store taken from the caller instead of the row;
 * a replay lookup keyed by clientRequestId alone (leak); a check-then-insert cap/ip count without the lobby_stores row lock.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, flushSecurityEvents, type Actor } from '@shareat/auth';
import { checkIn } from '../../src/lobby/checkin';
import { callEntry, listLobbyEntries, parkWalkIn, removeEntry, seatEntry } from '../../src/lobby/staff';
import { LobbyRefusal } from '../../src/lobby/refusal';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
/** Catch inside the transaction, probe it is still usable, return what was thrown (or undefined). */
async function refusedIn(orgId: string, fn: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  return asOrg(orgId, async (tx) => {
    let err: unknown;
    try {
      await fn(tx);
    } catch (e) {
      if (e instanceof TypeError && /is not a function|is not defined/.test(e.message)) throw e;
      err = e;
    }
    await tx.execute(dsql`select 1`);
    return err;
  });
}
function expectAuthRefusal(err: unknown, what: string) {
  expect(err, `${what}: not refused with AuthorizationError`).toBeInstanceOf(AuthorizationError);
  expect(`${(err as Error).message}`, `${what}: database wording`).not.toMatch(/violates|duplicate key|relation "/i);
}

type S = { orgId: string; storeId: string };
type Raw = Record<string, string | number | boolean | null>;

/** One org, two stores A and B (lobby enabled, POS fresh), three people: cashierA (manager, scope A only), cashierBoth, floorA (role staff, scope A: no record_sale). */
async function fx(hint: string) {
  const code = uid(`t455auth-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const store = async (): Promise<S> => {
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
    await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, pos_seen_at) values (${orgId}, ${st!.id}, true, false, 60, now())`;
    return { orgId, storeId: st!.id };
  };
  const A = await store();
  const B = await store();
  const person = async (name: string, role: string, scope: string[]): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const cashierA = await person('Cashier A', 'manager', [A.storeId]);
  const floorA = await person('Floor A', 'staff', [A.storeId]);
  return { orgId, A, B, cashierA, floorA, store };
}
type Fx = Awaited<ReturnType<typeof fx>>;

let codeN = Math.floor(Math.random() * 3000);
async function rawEntry(s: S, o: { status?: string; ageMin?: number; extra?: Raw } = {}): Promise<string> {
  const row: Raw = {
    org_id: s.orgId, store_id: s.storeId, source: 'lobby', code: String(1000 + (++codeN % 9000)), display_name: 'Ana Reyes', party_size: 3,
    status: o.status ?? 'waiting', device_hash: uid('dev'), ip_hash: uid('ip'), client_request_id: uid('req'), created_at: ago(o.ageMin ?? 5),
    ...(o.status === 'called' ? { called_at: ago(1) } : {}), ...(o.extra ?? {}),
  };
  const [r] = await sql<{ id: string }[]>`insert into lobby_entries ${sql(row)} returning id`;
  return r!.id;
}
const entryOf = async (id: string) => (await sql<Record<string, unknown>[]>`select * from lobby_entries where id = ${id}`)[0]!;
const countEntries = async (s: S) => (await sql<{ n: number }[]>`select count(*)::int n from lobby_entries where store_id = ${s.storeId}`)[0]!.n;
const denials = async (f: Fx, actor: Actor) => {
  await flushSecurityEvents(); // denials are written by the outbox after the refusal (T-402 S2)
  return sql<{ after: { capability?: string } | null }[]>`
    select after from audit_log where org_id = ${f.orgId} and action = 'security.authorize_denied' and actor_person_id = ${actor.personId}`;
};
let ipN = 0;
type CheckInInput = Parameters<typeof checkIn>[1];
const inp = (s: S, o: Partial<CheckInInput> = {}): CheckInInput => ({
  orgId: s.orgId, storeId: s.storeId, deviceHash: uid('dev'), ipHash: uid(`ip${++ipN}`), displayName: 'Ben Cruz', partySize: 4, ...o,
});

// ================================================================================================ A1 / A2

type Call = [string, (tx: Tx, who: Actor, s: S, entryId: string) => Promise<unknown>];
const staffCalls: Call[] = [
  ['listLobbyEntries', (tx, who, s) => listLobbyEntries(tx, who, s.storeId)],
  ['callEntry', (tx, who, _s, id) => callEntry(tx, who, id)],
  ['seatEntry', (tx, who, _s, id) => seatEntry(tx, who, { entryId: id, sessionId: 'SESS-AUTH', standLabel: '7' })],
  ['removeEntry', (tx, who, _s, id) => removeEntry(tx, who, id)],
  ['parkWalkIn', (tx, who, s) => parkWalkIn(tx, who, { storeId: s.storeId, displayName: 'Walk In', partySize: 2 })],
];

describe("A1. a cashier of store A cannot touch store B (same org): 'record_sale' is store-scoped", () => {
  it.each(staffCalls)('A1 %s at store B is refused with AuthorizationError, nothing changes [kills: authorize missing, wrong capability, no storeId, store taken from the caller instead of the row]', async (name, call) => {
    const f = await fx('a1');
    const bEntry = await rawEntry(f.B, { status: 'called' });
    const before = await entryOf(bEntry);
    const rowsBefore = await countEntries(f.B);
    const err = await refusedIn(f.orgId, (tx) => call(tx, f.cashierA, f.B, bEntry));
    expectAuthRefusal(err, `${name} at store B`);
    expect(await entryOf(bEntry), `${name}: the refused call changed the entry`).toEqual(before);
    expect(await countEntries(f.B), `${name}: the refused call added a row`).toBe(rowsBefore);
  });

  it('A1 positive control: the same cashier succeeds at her own store A with all five calls [kills: a blanket refusal]', async () => {
    const f = await fx('a1ok');
    const forCall = await rawEntry(f.A, { status: 'waiting' });
    const forSeat = await rawEntry(f.A, { status: 'called' });
    const forRemove = await rawEntry(f.A, { status: 'waiting' });
    await asOrg(f.orgId, async (tx) => {
      expect((await listLobbyEntries(tx, f.cashierA, f.A.storeId)).length).toBeGreaterThanOrEqual(3);
      expect((await callEntry(tx, f.cashierA, forCall)).status).toBe('called');
      expect((await seatEntry(tx, f.cashierA, { entryId: forSeat, sessionId: 'SESS-OK', standLabel: '3' })).status).toBe('seated');
      expect((await removeEntry(tx, f.cashierA, forRemove)).status).toBe('removed');
      expect((await parkWalkIn(tx, f.cashierA, { storeId: f.A.storeId, displayName: 'Walk In', partySize: 2 })).code).toMatch(/^[1-9][0-9]{3}$/);
    });
  });
});

describe("A2. a role without 'record_sale' is refused at its OWN store, and the denial is logged", () => {
  it.each(staffCalls)('A2 %s as role staff at store A: AuthorizationError, entry unchanged [kills: authorize missing, a cashier-only gate that lets any in-scope person through]', async (name, call) => {
    const f = await fx('a2');
    const entry = await rawEntry(f.A, { status: 'called' });
    const before = await entryOf(entry);
    const err = await refusedIn(f.orgId, (tx) => call(tx, f.floorA, f.A, entry));
    expectAuthRefusal(err, `${name} by a person without record_sale`);
    expect(await entryOf(entry)).toEqual(before);
  });

  it("A2 the refusal leaves a security.authorize_denied row for that person naming 'record_sale' (authorize() logs; a hand-rolled role check would not) [kills: a home-made check instead of authorize()]", async () => {
    const f = await fx('a2log');
    const entry = await rawEntry(f.A, { status: 'waiting' });
    expect((await denials(f, f.floorA)).length).toBe(0);
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => callEntry(tx, f.floorA, entry)), 'callEntry');
    const rows = await denials(f, f.floorA);
    expect(rows.length, 'no denial row written').toBeGreaterThanOrEqual(1);
    expect(rows[0]!.after?.capability).toBe('record_sale');
  });
});

// ================================================================================================ R2

describe('R2. a replayed clientRequestId from a DIFFERENT device never leaks the first entry', () => {
  it('R2 device 2 with device 1\'s request id gets neither the first entry\'s id nor its code (a fresh entry or a LOBBY_* refusal); device 1\'s entry is untouched; positive control: device 1 replaying gets its own entry back [kills: replay lookup keyed by clientRequestId alone]', async () => {
    const f = await fx('r2');
    const req = uid('reqR2');
    const dev1 = uid('devR2a');
    const first = await asOrg(f.orgId, (tx) => checkIn(tx, inp(f.A, { deviceHash: dev1, clientRequestId: req, displayName: 'First Diner' })));
    const same = await asOrg(f.orgId, (tx) => checkIn(tx, inp(f.A, { deviceHash: dev1, clientRequestId: req })));
    expect(same.entryId, 'positive control: same device + same request id').toBe(first.entryId);
    expect(same.created).toBe(false);

    const out = await asOrg(f.orgId, async (tx) => {
      try {
        return { ok: await checkIn(tx, inp(f.A, { deviceHash: uid('devR2b'), clientRequestId: req, displayName: 'Second Diner' })) };
      } catch (e) {
        await tx.execute(dsql`select 1`); // must still be usable: a refusal, not an aborted transaction
        return { err: e };
      }
    });
    if ('ok' in out && out.ok) {
      expect(out.ok.entryId, 'device 2 was handed device 1\'s entry id').not.toBe(first.entryId);
      expect(out.ok.code, 'device 2 was handed device 1\'s booking code').not.toBe(first.code);
    } else {
      expect(out.err, 'a refusal must be a LobbyRefusal, not a raw unique violation').toBeInstanceOf(LobbyRefusal);
      const e = out.err as LobbyRefusal;
      expect(e.code).toMatch(/^LOBBY_/);
      expect(`${e.message} ${e.userMessage}`).not.toContain(first.code);
      expect(`${e.message} ${e.userMessage}`).not.toContain(first.entryId);
    }
    expect(await entryOf(first.entryId)).toMatchObject({ display_name: 'First Diner', device_hash: dev1, status: 'waiting' });
  });
});

// ================================================================================================ C1

/** Two REAL connections: A does its work and keeps its transaction open; B starts only after A has finished its work; then A commits. */
async function race(orgId: string, doA: (tx: Tx) => Promise<unknown>, doB: (tx: Tx) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let aWorked!: () => void;
  const aReady = new Promise<void>((r) => (aWorked = r));
  const settle = async (tx: Tx, fn: (tx: Tx) => Promise<unknown>): Promise<{ ok?: unknown; err?: unknown }> => {
    try {
      return { ok: await fn(tx) };
    } catch (e) {
      if (e instanceof TypeError && /is not a function|is not defined/.test(e.message)) throw e;
      return { err: e };
    }
  };
  const a = asOrg(orgId, async (tx) => {
    const r = await settle(tx, doA);
    aWorked();
    await gate;
    return r;
  });
  await aReady;
  const b = asOrg(orgId, (tx) => settle(tx, doB));
  await sleep(700); // B is either blocked on A's lock (correct) or has already decided on a stale count (the bug)
  release();
  return Promise.all([a, b]);
}
function expectOneWinner(results: Array<{ ok?: unknown; err?: unknown }>, code: string) {
  const oks = results.filter((r) => r.ok !== undefined);
  const errs = results.filter((r) => r.err !== undefined);
  expect(errs.map((e) => (e.err as Error)?.message), 'unexpected errors').toHaveLength(1);
  expect(oks.length, `exactly one check-in wins; saw ${oks.length} winners`).toBe(1);
  expect(errs[0]!.err).toBeInstanceOf(LobbyRefusal);
  expect((errs[0]!.err as LobbyRefusal).code).toBe(code);
}

describe('C1. concurrent check-ins cannot overrun a limit (two connections, both started before either commits)', () => {
  it('C1 cap: max 5 with 4 live, two simultaneous check-ins -> exactly one succeeds, the other LOBBY_FULL, and the store ends with exactly 5 [kills: check-then-insert without the lobby_stores row lock]', async () => {
    const f = await fx('c1cap');
    const s = await f.store();
    await sql`update lobby_stores set max_live_entries = 5 where store_id = ${s.storeId}`;
    for (let i = 0; i < 4; i++) await rawEntry(s, { status: 'waiting' });
    const res = await race(f.orgId, (tx) => checkIn(tx, inp(s)), (tx) => checkIn(tx, inp(s)));
    expectOneWinner(res, 'LOBBY_FULL');
    expect(await countEntries(s)).toBe(5);
  });

  it('C1 ip-hour: 4 of 5 used by one network, two simultaneous check-ins from it -> exactly one succeeds, the other LOBBY_IP_LIMIT, the network ends with exactly 5 [kills: unlocked ip count]', async () => {
    const f = await fx('c1ip');
    const s = await f.store();
    const ip = uid('ipC1');
    for (let i = 0; i < 4; i++) await rawEntry(s, { status: 'cancelled', extra: { ip_hash: ip, closed_at: ago(1) } });
    const res = await race(f.orgId, (tx) => checkIn(tx, inp(s, { ipHash: ip })), (tx) => checkIn(tx, inp(s, { ipHash: ip })));
    expectOneWinner(res, 'LOBBY_IP_LIMIT');
    const [r] = await sql<{ n: number }[]>`select count(*)::int n from lobby_entries where store_id = ${s.storeId} and ip_hash = ${ip}`;
    expect(r!.n).toBe(5);
  });
});
