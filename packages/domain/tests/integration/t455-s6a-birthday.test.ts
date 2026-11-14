import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S6a (TESTER) - the birthday-song request, DOMAIN, diner side + expiry + purge: docs/tasks/455-customer-lobby.md sections 2.4 (state machine),
 * 3.1 (/lobby/birthday), 4.1 (one request per entry), 4.7 (purge), and the S6a row of section 5. Real Postgres via TEST_DATABASE_URL.
 *
 * RED TODAY, for one reason: packages/domain/src/lobby/birthday.ts does not exist (the import below fails to resolve).
 *
 * CONTRACT ASSUMED (the orchestrator rules on every line marked ASSUMED in the hand-back; the builder may rename only together with this file):
 *   MyEntryKey = { orgId, storeId, deviceHash }                      (the S2 diner key, from checkin.ts)
 *   requestBirthday(tx, key, { celebrantName?: string | null }): Promise<{ requestId: string; status: 'requested' }>
 *   getMyBirthday(tx, key): Promise<null | { requestId, status, celebrantName: string | null, scheduledAt: Date | null, declineReason: string | null }>
 *   cancelMyBirthday(tx, key): Promise<{ requestId: string; status: 'cancelled' }>
 *   expireStaleBirthdayRequests(tx, orgId): Promise<number>          (DB clock: accepted and scheduled_at < now() - 30 min; returns the count)
 *   New LobbyRefusal codes (added to LOBBY_REFUSAL_CODES with ONE plain sentence each):
 *     LOBBY_BIRTHDAY_EXISTS (a second request for the entry), LOBBY_BIRTHDAY_CLOSED (a move the request's state does not allow),
 *     LOBBY_BIRTHDAY_NEEDS_TIME (accept without a time), LOBBY_BIRTHDAY_OFF (lobby_stores.birthday_enabled = false).
 *   Requests are only for a LIVE entry (waiting|called): a closed entry -> LOBBY_ENTRY_CLOSED; no entry for the key -> LOBBY_NOT_FOUND.
 *   Closing an entry UNSEATED (diner cancel, staff remove, 3 h expiry) expires its REQUESTED birthday request (spec 2.4); seating does not.
 *   Reading my birthday also expires a stale accepted request (expiry on read, like the entry itself).
 *
 * MUTANT INDEX (titles end with "[kills: ...]"): second request allowed / cancelled one not freeing the slot / declined or expired one not blocking; race
 * leaks a raw 23505; name > 40 or non-string accepted, blank kept as ''; another device or store reading or cancelling; request on a closed entry;
 * birthday_enabled ignored; cancel after play (or after decline / expire) allowed; expiry on created_at instead of scheduled_at, wrong boundary, expiring
 * requested/played/future ones; closing an entry leaving a requested request live; seat expiring it; nightly not running the expiry; purge missing the
 * celebrant name; a refusal that leaks database wording or has no plain sentence.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { cancelMyBirthday, expireStaleBirthdayRequests, getMyBirthday, requestBirthday } from '../../src/lobby/birthday';
import { cancelMyEntry } from '../../src/lobby/checkin';
import { expireStaleLobbyEntries, purgeLobbyPersonalData, runLobbyNightly } from '../../src/lobby/purge';
import { LOBBY_REFUSAL_CODES, LobbyRefusal } from '../../src/lobby/refusal';
import { removeEntry, seatEntry } from '../../src/lobby/staff';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ------------------------------------------------------------------------------------------------ helpers
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
/** Catch INSIDE the transaction, probe it is still usable, return what was thrown (or undefined). */
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
function expectRefusal(err: unknown, code: string, what: string): LobbyRefusal {
  expect(err, `${what}: was not refused (or not a LobbyRefusal)`).toBeInstanceOf(LobbyRefusal);
  const e = err as LobbyRefusal;
  expect(e.code, `${what}: wrong code (${e.message})`).toBe(code);
  return e;
}
/** One plain sentence for the diner: starts with a capital, ends with a full stop, no database or table wording, not the machine code. */
function expectPlain(e: LobbyRefusal, what: string) {
  expect(e.userMessage, `${what}: plain sentence`).toMatch(/^[A-Z][^\n]{8,160}[.]$/);
  expect(e.userMessage, `${what}: database wording`).not.toMatch(/violates|constraint|duplicate|relation|lobby_|null value|23\d{3}|LOBBY_/i);
}

type S = { orgId: string; storeId: string };
type Raw = Record<string, string | number | boolean | null>;
const DINER_NAME = 'Ana Reyes';

async function fx(hint: string) {
  const code = uid(`t455s6a-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const store = async (o: { birthday?: boolean } = {}): Promise<S> => {
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
    await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, birthday_enabled, pos_seen_at)
              values (${orgId}, ${st!.id}, true, false, 60, ${o.birthday ?? true}, now())`;
    return { orgId, storeId: st!.id };
  };
  const A = await store();
  const B = await store();
  /** A manager scoped to store A: holds record_sale there. */
  const cashierA = async () => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Cashier A') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${A.storeId})`;
    return { personId: p!.id, orgId };
  };
  return { orgId, A, B, store, cashierA };
}
type Fx = Awaited<ReturnType<typeof fx>>;

let codeN = Math.floor(Math.random() * 3000);
/** A lobby entry with its own device hash; returns the id and the diner key that owns it. */
async function entry(
  s: S,
  o: { status?: string; ageMin?: number; closedMinAgo?: number; extra?: Raw } = {},
): Promise<{ id: string; key: { orgId: string; storeId: string; deviceHash: string } }> {
  const deviceHash = uid('dev');
  const status = o.status ?? 'waiting';
  const row: Raw = {
    org_id: s.orgId, store_id: s.storeId, source: 'lobby', code: String(1000 + (++codeN % 9000)), display_name: DINER_NAME, party_size: 3,
    status, device_hash: deviceHash, ip_hash: uid('ip'), client_request_id: uid('req'), created_at: ago(o.ageMin ?? 5),
    ...(status === 'called' ? { called_at: ago(1) } : {}),
    ...(o.closedMinAgo !== undefined ? { closed_at: ago(o.closedMinAgo) } : {}),
    ...(o.extra ?? {}),
  };
  const [r] = await sql<{ id: string }[]>`insert into lobby_entries ${sql(row)} returning id`;
  return { id: r!.id, key: { orgId: s.orgId, storeId: s.storeId, deviceHash } };
}
const birthdayRows = async (entryId: string) => await sql<Record<string, any>[]>`select * from lobby_birthday_requests where entry_id = ${entryId} order by created_at, id`;
const birthdayOf = async (id: string) => (await sql<Record<string, any>[]>`select * from lobby_birthday_requests where id = ${id}`)[0]!;
/** Raw request row in any state (born requested, then moved by SQL; the trigger stamps accepted_at). scheduledMinAgo > 0 = in the past. */
async function rawBirthday(
  f: Fx,
  entryId: string,
  state: 'requested' | 'accepted' | 'declined' | 'played' | 'expired' | 'cancelled',
  o: { scheduledMinAgo?: number; name?: string | null } = {},
): Promise<string> {
  const [b] = await sql<{ id: string }[]>`insert into lobby_birthday_requests (org_id, entry_id, celebrant_name, status) values (${f.orgId}, ${entryId}, ${o.name === undefined ? 'Ben' : o.name}, 'requested') returning id`;
  const id = b!.id;
  const sched = ago(o.scheduledMinAgo ?? -20);
  if (state === 'accepted') await sql`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${sched} where id = ${id}`;
  if (state === 'played') {
    await sql`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${sched} where id = ${id}`;
    await sql`update lobby_birthday_requests set status = 'played', played_at = now() where id = ${id}`;
  }
  if (state === 'declined') await sql`update lobby_birthday_requests set status = 'declined', decline_reason = 'Not tonight' where id = ${id}`;
  if (state === 'expired') await sql`update lobby_birthday_requests set status = 'expired' where id = ${id}`;
  if (state === 'cancelled') await sql`update lobby_birthday_requests set status = 'cancelled' where id = ${id}`;
  return id;
}

// ================================================================================================ A. asking
describe('A. requestBirthday: one request per entry, name optional and limited', () => {
  it('A1 a diner on a waiting entry asks: one requested row for THAT entry, name stored trimmed, no time, no reason, nobody acted yet [kills: wrong entry, name not stored/trimmed, status other than requested]', async () => {
    const f = await fx('a1');
    const e = await entry(f.A);
    const r = await asOrg(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: '  Ben  ' }));
    expect(r.status).toBe('requested');
    const rows = await birthdayRows(e.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.requestId, entry_id: e.id, org_id: f.orgId, celebrant_name: 'Ben', status: 'requested', scheduled_at: null, decline_reason: null, played_at: null, acted_by_person_id: null });
    const mine = await asOrg(f.orgId, (tx) => getMyBirthday(tx, e.key));
    expect(mine).toMatchObject({ requestId: r.requestId, status: 'requested', celebrantName: 'Ben', scheduledAt: null, declineReason: null });
  });

  it('A2 a called entry may ask too; the celebrant name is optional: omitted, null and blank all store NULL (never an empty string) [kills: name required, blank kept as empty string]', async () => {
    const f = await fx('a2');
    const called = await entry(f.A, { status: 'called' });
    await asOrg(f.orgId, (tx) => requestBirthday(tx, called.key, {}));
    expect((await birthdayRows(called.id))[0]!.celebrant_name).toBeNull();
    for (const blank of [null, '', '   ']) {
      const e = await entry(f.A);
      await asOrg(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: blank }));
      expect((await birthdayRows(e.id))[0]!.celebrant_name, `blank ${JSON.stringify(blank)}`).toBeNull();
    }
  });

  it('A3 the name is limited to 40 characters after trimming: 40 is kept, 41, a number and an object are refused LOBBY_BAD_INPUT with a plain sentence and nothing is written [kills: no limit (or the DB CHECK as the only guard), off by one, non-string accepted]', async () => {
    const f = await fx('a3');
    const ok = await entry(f.A);
    await asOrg(f.orgId, (tx) => requestBirthday(tx, ok.key, { celebrantName: ` ${'x'.repeat(40)} ` }));
    expect((await birthdayRows(ok.id))[0]!.celebrant_name).toBe('x'.repeat(40));
    for (const bad of ['y'.repeat(41), 7, { a: 1 }] as unknown[]) {
      const e = await entry(f.A);
      const err = await refusedIn(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: bad as string }));
      expectPlain(expectRefusal(err, 'LOBBY_BAD_INPUT', `name ${JSON.stringify(bad)}`), 'bad name');
      expect(await birthdayRows(e.id)).toHaveLength(0);
    }
  });

  it('A4 SECOND REQUEST REFUSED: a second ask on the same entry is LOBBY_BIRTHDAY_EXISTS with a plain sentence; the first request is unchanged and there is still one row [kills: second row, replacing the first, raw DB error]', async () => {
    const f = await fx('a4');
    const e = await entry(f.A);
    const first = await asOrg(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: 'Ben' }));
    const err = await refusedIn(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: 'Other' }));
    expectPlain(expectRefusal(err, 'LOBBY_BIRTHDAY_EXISTS', 'second request'), 'second request');
    const rows = await birthdayRows(e.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.requestId, celebrant_name: 'Ben', status: 'requested' });
  });

  it('A5 a request that was accepted, declined, played or expired still blocks a new ask (spec 4.1: 1 per entry; only cancelled frees the slot) [kills: block only while requested, DB unique as the only guard]', async () => {
    const f = await fx('a5');
    for (const state of ['accepted', 'declined', 'played', 'expired'] as const) {
      const e = await entry(f.A);
      await rawBirthday(f, e.id, state);
      const err = await refusedIn(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: 'Again' }));
      expectRefusal(err, 'LOBBY_BIRTHDAY_EXISTS', `ask after ${state}`);
      expect(await birthdayRows(e.id), state).toHaveLength(1);
    }
  });

  it('A6 a CANCELLED request frees the slot: the diner may ask again, and both rows are kept (cancelled history + the new one) [kills: unique over all statuses, cancel deleting the row]', async () => {
    const f = await fx('a6');
    const e = await entry(f.A);
    const first = await asOrg(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: 'Ben' }));
    await asOrg(f.orgId, (tx) => cancelMyBirthday(tx, e.key));
    const second = await asOrg(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: 'Ben' }));
    expect(second.requestId).not.toBe(first.requestId);
    const rows = await birthdayRows(e.id);
    expect(rows.map((r) => r.status).sort()).toEqual(['cancelled', 'requested']);
    const mine = await asOrg(f.orgId, (tx) => getMyBirthday(tx, e.key));
    expect(mine!.requestId, 'getMyBirthday must report the live request, not the cancelled one').toBe(second.requestId);
  });

  it('A7 two simultaneous asks on one entry: exactly one wins, the other gets LOBBY_BIRTHDAY_EXISTS (not a raw unique violation) [kills: check-then-insert without the entry lock]', async () => {
    const f = await fx('a7');
    const e = await entry(f.A);
    const attempt = () =>
      asOrg(f.orgId, async (tx) => {
        try {
          await requestBirthday(tx, e.key, { celebrantName: 'Ben' });
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, err };
        }
      });
    const [x, y] = await Promise.all([attempt(), attempt()]);
    const winners = [x, y].filter((r) => r.ok);
    const losers = [x, y].filter((r): r is { ok: false; err: unknown } => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expectRefusal(losers[0]!.err, 'LOBBY_BIRTHDAY_EXISTS', 'the race loser');
    expect(await birthdayRows(e.id)).toHaveLength(1);
  });

  it('A8 a closed entry (cancelled, removed, expired) cannot ask: LOBBY_ENTRY_CLOSED, nothing written [kills: request on a dead entry]', async () => {
    const f = await fx('a8');
    for (const status of ['cancelled', 'removed', 'expired'] as const) {
      const e = await entry(f.A, { status, closedMinAgo: 1 });
      const err = await refusedIn(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: 'Ben' }));
      expectRefusal(err, 'LOBBY_ENTRY_CLOSED', `ask on ${status}`);
      expect(await birthdayRows(e.id)).toHaveLength(0);
    }
  });

  it('A9 a key that owns no entry is LOBBY_NOT_FOUND; another device cannot see or cancel my request; my device at ANOTHER store of the same org finds nothing [kills: lookup by entry id or code, ownership not checked, store not part of the key]', async () => {
    const f = await fx('a9');
    const mine = await entry(f.A);
    const mineBirthday = await asOrg(f.orgId, (tx) => requestBirthday(tx, mine.key, { celebrantName: 'Ben' }));
    const stranger = { orgId: f.orgId, storeId: f.A.storeId, deviceHash: uid('nobody') };
    expectRefusal(await refusedIn(f.orgId, (tx) => requestBirthday(tx, stranger, {})), 'LOBBY_NOT_FOUND', 'stranger asks');
    expect(await asOrg(f.orgId, (tx) => getMyBirthday(tx, stranger))).toBeNull();
    expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyBirthday(tx, stranger)), 'LOBBY_NOT_FOUND', 'stranger cancels');
    const otherStore = { ...mine.key, storeId: f.B.storeId };
    expectRefusal(await refusedIn(f.orgId, (tx) => requestBirthday(tx, otherStore, {})), 'LOBBY_NOT_FOUND', 'my device at store B asks');
    expect(await asOrg(f.orgId, (tx) => getMyBirthday(tx, otherStore))).toBeNull();
    expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyBirthday(tx, otherStore)), 'LOBBY_NOT_FOUND', 'my device at store B cancels');
    expect((await birthdayOf(mineBirthday.requestId)).status, 'a stranger or another store must not move my request').toBe('requested');
  });

  it('A10 a store with birthday_enabled = false refuses the ask with LOBBY_BIRTHDAY_OFF and a plain sentence [kills: the switch ignored]', async () => {
    const f = await fx('a10');
    const off = await f.store({ birthday: false });
    const e = await entry(off);
    const err = await refusedIn(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: 'Ben' }));
    expectPlain(expectRefusal(err, 'LOBBY_BIRTHDAY_OFF', 'birthday switch off'), 'switch off');
    expect(await birthdayRows(e.id)).toHaveLength(0);
  });

  it('A11 getMyBirthday is null before any ask [kills: throwing or inventing a request]', async () => {
    const f = await fx('a11');
    const e = await entry(f.A);
    expect(await asOrg(f.orgId, (tx) => getMyBirthday(tx, e.key))).toBeNull();
  });
});

// ================================================================================================ B. the diner cancels
describe('B. cancelMyBirthday: before play only', () => {
  it('B1 cancelling a requested or an accepted request sets cancelled; the accepted one keeps its time (history) [kills: cancel refused while accepted, time wiped]', async () => {
    const f = await fx('b1');
    const r = await entry(f.A);
    await rawBirthday(f, r.id, 'requested');
    const a = await entry(f.A);
    const accId = await rawBirthday(f, a.id, 'accepted');
    const before = await birthdayOf(accId);
    expect((await asOrg(f.orgId, (tx) => cancelMyBirthday(tx, r.key))).status).toBe('cancelled');
    expect((await asOrg(f.orgId, (tx) => cancelMyBirthday(tx, a.key))).status).toBe('cancelled');
    expect((await birthdayRows(r.id))[0]!.status).toBe('cancelled');
    const after = await birthdayOf(accId);
    expect(after.status).toBe('cancelled');
    expect(after.scheduled_at).toEqual(before.scheduled_at);
  });

  it('B2 CANCEL AFTER PLAY REFUSED: a played request is LOBBY_BIRTHDAY_CLOSED with a plain sentence and stays played with its play time [kills: cancel after play, DB trigger as the only guard]', async () => {
    const f = await fx('b2');
    const e = await entry(f.A);
    const id = await rawBirthday(f, e.id, 'played');
    const before = await birthdayOf(id);
    const err = await refusedIn(f.orgId, (tx) => cancelMyBirthday(tx, e.key));
    expectPlain(expectRefusal(err, 'LOBBY_BIRTHDAY_CLOSED', 'cancel after play'), 'cancel after play');
    expect(await birthdayOf(id)).toEqual(before);
  });

  it('B3 declined, expired and already-cancelled requests cannot be cancelled either; cancel with no request at all is LOBBY_NOT_FOUND [kills: cancel of a terminal request, cancel twice]', async () => {
    const f = await fx('b3');
    for (const state of ['declined', 'expired', 'cancelled'] as const) {
      const e = await entry(f.A);
      const id = await rawBirthday(f, e.id, state);
      const before = await birthdayOf(id);
      expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyBirthday(tx, e.key)), 'LOBBY_BIRTHDAY_CLOSED', `cancel ${state}`);
      expect(await birthdayOf(id)).toEqual(before);
    }
    const none = await entry(f.A);
    expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyBirthday(tx, none.key)), 'LOBBY_NOT_FOUND', 'cancel with no request');
  });

  it('B5 CANCEL RACING A STAFF PLAY: staff has the accepted row moved to played (not yet committed) while the diner cancels; the diner gets LOBBY_BIRTHDAY_CLOSED, not a trigger error, and the row stays played [kills: unlocked read then blind update hitting the forward-only trigger]', async () => {
    const f = await fx('b5');
    const e = await entry(f.A);
    const id = await rawBirthday(f, e.id, 'accepted');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let played!: () => void;
    const playedFlag = new Promise<void>((r) => (played = r));
    const staff = sql.begin(async (t) => {
      await t`update lobby_birthday_requests set status = 'played', played_at = now() where id = ${id}`;
      played();
      await hold;
    });
    await playedFlag;
    const cancel = refusedIn(f.orgId, (tx) => cancelMyBirthday(tx, e.key));
    await new Promise((r) => setTimeout(r, 400));
    release();
    await staff;
    const err = await cancel;
    expectPlain(expectRefusal(err, 'LOBBY_BIRTHDAY_CLOSED', 'cancel racing play'), 'cancel racing play');
    expect((await birthdayOf(id)).status).toBe('played');
  });

  it('B4 what the diner reads back: an accepted request shows its time, a declined one its reason [kills: time or reason missing from the diner view]', async () => {
    const f = await fx('b4');
    const a = await entry(f.A);
    const accId = await rawBirthday(f, a.id, 'accepted', { scheduledMinAgo: -45 });
    const d = await entry(f.A);
    await rawBirthday(f, d.id, 'declined');
    const accepted = await asOrg(f.orgId, (tx) => getMyBirthday(tx, a.key));
    expect(accepted).toMatchObject({ requestId: accId, status: 'accepted' });
    expect(accepted!.scheduledAt).toBeInstanceOf(Date);
    expect(Math.abs(accepted!.scheduledAt!.getTime() - (Date.now() + 45 * 60_000))).toBeLessThan(5_000);
    expect(await asOrg(f.orgId, (tx) => getMyBirthday(tx, d.key))).toMatchObject({ status: 'declined', declineReason: 'Not tonight', scheduledAt: null });
  });
});

// ================================================================================================ C. expiry
describe('C. accepted and not played 30 minutes after scheduled_at -> expired; closing an entry unseated expires a requested request', () => {
  it('C1 ACCEPTED-NOT-PLAYED 30 MIN -> EXPIRED: 31 min past the time expires; 29 min past, a future time, requested (however old) and played stay; the count is returned; a second run changes nothing [kills: expiry on created_at/accepted_at, wrong boundary, expiring requested/played, not idempotent]', async () => {
    const f = await fx('c1');
    const old = await entry(f.A, { ageMin: 100 });
    const stale = await rawBirthday(f, old.id, 'accepted', { scheduledMinAgo: 31 });
    const e2 = await entry(f.A);
    const recent = await rawBirthday(f, e2.id, 'accepted', { scheduledMinAgo: 29 });
    const e3 = await entry(f.A);
    const future = await rawBirthday(f, e3.id, 'accepted', { scheduledMinAgo: -60 });
    const e4 = await entry(f.A);
    const requested = await rawBirthday(f, e4.id, 'requested');
    await sql`update lobby_birthday_requests set created_at = ${ago(600)} where id = ${requested}`;
    const e5 = await entry(f.A);
    const played = await rawBirthday(f, e5.id, 'played', { scheduledMinAgo: 90 });
    const n = await asOrg(f.orgId, (tx) => expireStaleBirthdayRequests(tx, f.orgId));
    expect(n).toBe(1);
    expect((await birthdayOf(stale)).status).toBe('expired');
    expect((await birthdayOf(stale)).scheduled_at, 'an expired request keeps the time it was accepted for').not.toBeNull();
    expect((await birthdayOf(recent)).status).toBe('accepted');
    expect((await birthdayOf(future)).status).toBe('accepted');
    expect((await birthdayOf(requested)).status).toBe('requested');
    expect((await birthdayOf(played)).status).toBe('played');
    expect(await asOrg(f.orgId, (tx) => expireStaleBirthdayRequests(tx, f.orgId))).toBe(0);
  });

  it("C2 expiry is per organisation: another org's stale accepted request is untouched [kills: a sweep without the org filter]", async () => {
    const f = await fx('c2a');
    const g = await fx('c2b');
    const mine = await entry(f.A);
    const theirs = await entry(g.A);
    const mineId = await rawBirthday(f, mine.id, 'accepted', { scheduledMinAgo: 45 });
    const theirId = await rawBirthday(g, theirs.id, 'accepted', { scheduledMinAgo: 45 });
    await asOrg(f.orgId, (tx) => expireStaleBirthdayRequests(tx, f.orgId));
    expect((await birthdayOf(mineId)).status).toBe('expired');
    expect((await birthdayOf(theirId)).status).toBe('accepted');
  });

  it('C3 expiry on read: the diner reading a stale accepted request sees expired (and the row is expired) [kills: stale accepted shown as still coming]', async () => {
    const f = await fx('c3');
    const e = await entry(f.A);
    const id = await rawBirthday(f, e.id, 'accepted', { scheduledMinAgo: 40 });
    const mine = await asOrg(f.orgId, (tx) => getMyBirthday(tx, e.key));
    expect(mine).toMatchObject({ requestId: id, status: 'expired' });
    expect((await birthdayOf(id)).status).toBe('expired');
  });

  it('C4 the nightly job runs the birthday expiry too [kills: expiry not wired into runLobbyNightly]', async () => {
    const f = await fx('c4');
    const e = await entry(f.A);
    const id = await rawBirthday(f, e.id, 'accepted', { scheduledMinAgo: 40 });
    await asOrg(f.orgId, (tx) => runLobbyNightly(tx, f.orgId));
    expect((await birthdayOf(id)).status).toBe('expired');
  });

  it('C5 a requested request EXPIRES when its entry closes unseated: diner cancels the entry, staff removes it, the 3 h expiry closes it [kills: orphan live request on a dead entry]', async () => {
    const f = await fx('c5');
    const actor = await f.cashierA();
    const viaCancel = await entry(f.A);
    const viaRemove = await entry(f.A);
    const viaExpiry = await entry(f.A, { ageMin: 4 * 60 });
    const ids = [await rawBirthday(f, viaCancel.id, 'requested'), await rawBirthday(f, viaRemove.id, 'requested'), await rawBirthday(f, viaExpiry.id, 'requested')];
    await asOrg(f.orgId, (tx) => cancelMyEntry(tx, viaCancel.key));
    await asOrg(f.orgId, (tx) => removeEntry(tx, actor, viaRemove.id));
    await asOrg(f.orgId, (tx) => expireStaleLobbyEntries(tx, f.orgId));
    for (const [i, id] of ids.entries()) expect((await birthdayOf(id)).status, ['cancel', 'remove', 'expiry'][i]).toBe('expired');
  });

  it('C6 SEATING does not expire a requested request (the party is in; the cashier can still answer it) [kills: seat closing the birthday]', async () => {
    const f = await fx('c6');
    const actor = await f.cashierA();
    const e = await entry(f.A);
    const id = await rawBirthday(f, e.id, 'requested');
    await asOrg(f.orgId, (tx) => seatEntry(tx, actor, { entryId: e.id, sessionId: 'SESS-6', standLabel: '7' }));
    expect((await birthdayOf(id)).status).toBe('requested');
  });

  it('C7 an ACCEPTED request also EXPIRES when its entry closes unseated (S6a ruling 4), keeping the time it was accepted for; seating leaves it accepted [kills: an accepted request still live on a dead entry, seat expiring it]', async () => {
    const f = await fx('c7');
    const actor = await f.cashierA();
    const viaCancel = await entry(f.A);
    const viaRemove = await entry(f.A);
    const viaExpiry = await entry(f.A, { ageMin: 4 * 60 });
    const seated = await entry(f.A);
    const ids = [
      await rawBirthday(f, viaCancel.id, 'accepted'),
      await rawBirthday(f, viaRemove.id, 'accepted'),
      await rawBirthday(f, viaExpiry.id, 'accepted'),
    ];
    const seatedId = await rawBirthday(f, seated.id, 'accepted');
    const before = await Promise.all(ids.map(birthdayOf));
    await asOrg(f.orgId, (tx) => cancelMyEntry(tx, viaCancel.key));
    await asOrg(f.orgId, (tx) => removeEntry(tx, actor, viaRemove.id));
    await asOrg(f.orgId, (tx) => expireStaleLobbyEntries(tx, f.orgId));
    await asOrg(f.orgId, (tx) => seatEntry(tx, actor, { entryId: seated.id, sessionId: 'SESS-7', standLabel: '8' }));
    for (const [i, id] of ids.entries()) {
      const after = await birthdayOf(id);
      expect(after.status, ['cancel', 'remove', 'expiry'][i]).toBe('expired');
      expect(after.scheduled_at).toEqual(before[i]!.scheduled_at);
    }
    expect((await birthdayOf(seatedId)).status).toBe('accepted');
  });

  it('C8 NIGHTLY: an unanswered (requested or accepted) request on a SEATED entry expires once the entry closed more than 3 h ago; 2 h ago, a live entry and a played request stay [kills: seated requests living forever on the cashier list, wrong boundary, expiring played]', async () => {
    const f = await fx('c8');
    const seatedX = { session_ref: 'S1', stand_label: '7' };
    const oldReq = await entry(f.A, { status: 'seated', ageMin: 400, closedMinAgo: 181, extra: seatedX });
    const oldAcc = await entry(f.A, { status: 'seated', ageMin: 400, closedMinAgo: 181, extra: seatedX });
    const oldPlayed = await entry(f.A, { status: 'seated', ageMin: 400, closedMinAgo: 181, extra: seatedX });
    const recent = await entry(f.A, { status: 'seated', ageMin: 400, closedMinAgo: 120, extra: seatedX });
    const live = await entry(f.A, { ageMin: 100 });
    const a = await rawBirthday(f, oldReq.id, 'requested');
    const b = await rawBirthday(f, oldAcc.id, 'accepted', { scheduledMinAgo: -600 });
    const c = await rawBirthday(f, oldPlayed.id, 'played', { scheduledMinAgo: -600 });
    const d = await rawBirthday(f, recent.id, 'requested');
    const g = await rawBirthday(f, live.id, 'requested');
    await asOrg(f.orgId, (tx) => runLobbyNightly(tx, f.orgId));
    expect((await birthdayOf(a)).status, 'requested, seated 3h+ ago').toBe('expired');
    expect((await birthdayOf(b)).status, 'accepted, seated 3h+ ago').toBe('expired');
    expect((await birthdayOf(c)).status, 'played').toBe('played');
    expect((await birthdayOf(d)).status, 'seated 2h ago').toBe('requested');
    expect((await birthdayOf(g)).status, 'live entry').toBe('requested');
  });
});

// ================================================================================================ D. purge, refusal wording
describe('D. purge and wording', () => {
  it("D1 the 24 h purge NULLs celebrant_name on requests of entries closed more than 24 h ago (requested, accepted, played, declined alike), keeps status and times, leaves a live or recently closed entry's name; the count is birthdayNamesPurged [kills: name kept forever, purge by created_at, purging live entries]", async () => {
    const f = await fx('d1');
    const closedStates = ['requested', 'accepted', 'played', 'declined'] as const;
    const closed: string[] = [];
    for (const st of closedStates) {
      const e = await entry(f.A, { status: 'seated', ageMin: 2000, closedMinAgo: 25 * 60, extra: { session_ref: 'S1', stand_label: '7' } });
      closed.push(await rawBirthday(f, e.id, st, { name: 'Ben' }));
    }
    const live = await entry(f.A, { ageMin: 30 * 60 });
    const liveId = await rawBirthday(f, live.id, 'requested', { name: 'Keep' });
    const recent = await entry(f.A, { status: 'cancelled', closedMinAgo: 23 * 60 });
    const recentId = await rawBirthday(f, recent.id, 'requested', { name: 'Recent' });
    const before = await Promise.all(closed.map(birthdayOf));
    const out = await asOrg(f.orgId, (tx) => purgeLobbyPersonalData(tx, f.orgId));
    expect(out.birthdayNamesPurged).toBe(4);
    for (const [i, id] of closed.entries()) {
      const after = await birthdayOf(id);
      expect(after.celebrant_name, closedStates[i]).toBeNull();
      expect({ ...after, celebrant_name: null }).toEqual({ ...before[i]!, celebrant_name: null });
    }
    expect((await birthdayOf(liveId)).celebrant_name).toBe('Keep');
    expect((await birthdayOf(recentId)).celebrant_name).toBe('Recent');
  });

  it('D2 every new refusal code is registered with the other LOBBY codes [kills: a code thrown but missing from LOBBY_REFUSAL_CODES / the sentence table]', () => {
    for (const c of ['LOBBY_BIRTHDAY_EXISTS', 'LOBBY_BIRTHDAY_CLOSED', 'LOBBY_BIRTHDAY_NEEDS_TIME', 'LOBBY_BIRTHDAY_OFF']) {
      expect(LOBBY_REFUSAL_CODES as readonly string[], c).toContain(c);
    }
  });

  it('D3 each birthday refusal reads one plain sentence, none says the same as the counter sentence, and none names a limit or a table [kills: reusing the check-in counter sentence, database wording]', async () => {
    const f = await fx('d3');
    const e = await entry(f.A);
    await asOrg(f.orgId, (tx) => requestBirthday(tx, e.key, { celebrantName: 'Ben' }));
    const exists = expectRefusal(await refusedIn(f.orgId, (tx) => requestBirthday(tx, e.key, {})), 'LOBBY_BIRTHDAY_EXISTS', 'exists');
    const playedE = await entry(f.A);
    await rawBirthday(f, playedE.id, 'played');
    const closed = expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyBirthday(tx, playedE.key)), 'LOBBY_BIRTHDAY_CLOSED', 'closed');
    for (const r of [exists, closed]) {
      expectPlain(r, r.code);
      expect(r.userMessage).not.toBe('Please check in at the counter.');
    }
    expect(exists.userMessage).not.toBe(closed.userMessage);
  });
});
