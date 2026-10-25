import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S2 (TESTER) - the customer lobby, DOMAIN layer: docs/tasks/455-customer-lobby.md section 2.3, 2.4, 4.1, 4.7, the S2 row
 * of section 5, and "S1 audit notes". Real Postgres via TEST_DATABASE_URL (`_test` name guard).
 *
 * RED TODAY, for one reason: packages/domain/src/lobby/{checkin,staff,purge,refusal}.ts do not exist. CONTRACT.md (beside this
 * file) lists every name, parameter, return shape and constant assumed here. Anything the spec leaves open is marked
 * QUESTION in CONTRACT.md; the builder may change a name only together with this file.
 *
 * HOW A REFUSAL IS ASSERTED: the domain throws a `LobbyRefusal` (a RefusalError with a machine `code`, never a raw Postgres error),
 * so each refusal checks the class, the exact `code`, and a plain sentence. Section 4.1 says a refusal "never says which limit":
 * the codes differ (for the tests and the logs), the SENTENCE the diner reads does not. Every refusal is caught INSIDE the
 * transaction and followed by `select 1`: if the refusal came from a unique violation without a savepoint, the transaction is
 * aborted and that probe throws (kills "retry without savepoint").
 *
 * Fixtures are raw SQL for everything that is not the subject (S1 owns the schema). One org per describe; one fresh STORE per
 * test, so the per-store limits never leak between tests. Typed values are never hex-only (DEF-744). No employments are created
 * here (no staff_code needed); if one is ever added its code must be SE-NNN.
 *
 * MUTANT INDEX (each test title ends with "[kills: ...]"):
 *  ip limit off by one / absent / live-only / not windowed / global; cap off by one / hard-coded / counts closed or other stores;
 *  paused or disabled or missing-row or never-seen or stale-POS not refused; idempotent lookup after the limits; second row for the
 *  same cookie; closed entry blocks its cookie; collision not retried / retried without savepoint / retried forever / closed code
 *  not reusable; position counts seated, other-store or later entries; expiry on read ignored; cancel by anybody; seat
 *  without session or stand; handoff url returned twice / to another cookie / after expiry / listed to staff; purge column
 *  missed / by created_at / rows deleted / other org; claims not expired on close / approved claims expired / claims expired on
 *  seat / sweep ignoring age.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  cancelMyEntry,
  checkIn,
  getMyEntry,
  lobbyPartiesAhead,
  LOBBY_CHECKINS_PER_IP_HOUR,
  LOBBY_CODE_ATTEMPTS,
  LOBBY_ENTRY_TTL_HOURS,
  LOBBY_POS_STALE_MINUTES,
} from '../../src/lobby/checkin';
import { callEntry, listLobbyEntries, parkWalkIn, removeEntry, seatEntry } from '../../src/lobby/staff';
import {
  expireStaleLobbyEntries,
  LOBBY_PURGE_AFTER_HOURS,
  purgeLobbyPersonalData,
  runLobbyNightly,
  sweepStalePendingClaims,
} from '../../src/lobby/purge';
import { LobbyRefusal } from '../../src/lobby/refusal';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ------------------------------------------------------------------------------------------------ helpers

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const SENTENCE_LEAK = /violates|duplicate key|unique constraint|check constraint|trigger|relation "|SQLSTATE/i;
const COUNTER = /check in at the counter/i;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Run fn, catch what it throws INSIDE the transaction, probe the transaction is still usable, return the error (or undefined). */
async function refusedIn(orgId: string, fn: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  return asOrg(orgId, async (tx) => {
    let err: unknown;
    try {
      await fn(tx);
    } catch (e) {
      if (e instanceof TypeError && /is not a function|is not defined/.test(e.message)) throw e;
      err = e;
    }
    await tx.execute(dsql`select 1`); // throws "current transaction is aborted" if the refusal was a swallowed database error
    return err;
  });
}

function expectRefusal(err: unknown, code: string, what: string): LobbyRefusal {
  expect(err, `${what}: was not refused (or not a LobbyRefusal)`).toBeInstanceOf(LobbyRefusal);
  const e = err as LobbyRefusal;
  expect(e.code, `${what}: wrong code (${e.message})`).toBe(code);
  expect(typeof e.userMessage, `${what}: no userMessage`).toBe('string');
  expect(e.userMessage.length, `${what}: empty sentence`).toBeGreaterThan(0);
  expect(`${e.message} ${e.userMessage}`, `${what}: database wording in the sentence`).not.toMatch(SENTENCE_LEAK);
  return e;
}

type OrgFx = Awaited<ReturnType<typeof orgFixture>>;
type S = { orgId: string; storeId: string };

async function orgFixture(hint: string) {
  const code = uid(`t455s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Lobby Cashier') returning id`;
  // 'manager' holds record_sale (the cashier capability, store-scoped) in the default matrix; 'staff' does not. Store scope is added per store in mkStore.
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  const staff: Actor = { personId: p!.id, orgId };
  const [cat] = await sql<{ id: string }[]>`
    insert into menu_categories (org_id, name, sort_order, status, created_by) values (${orgId}, ${uid('Cat')}, 0, 'active', ${staff.personId}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${orgId}, ${cat!.id}, ${uid('Pork')}, 'a_la_carte', true, false, true, 0, 'active', ${staff.personId}) returning id`;
  const [variant] = await sql<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
    values (${orgId}, ${item!.id}, null, true, 0, 'active', ${staff.personId}) returning id`;
  const [grp] = await sql<{ id: string }[]>`
    insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
    values (${orgId}, ${uid('Grp')}, 'single', 1, 1, 'active', ${staff.personId}) returning id`;
  const [val] = await sql<{ id: string }[]>`
    insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by)
    values (${orgId}, ${grp!.id}, ${uid('Val')}, 0, 'active', ${staff.personId}) returning id`;

  /** A fresh store. Default: lobby enabled, not paused, cap 60, POS seen just now. posSeenMinutesAgo null = never; row false = no lobby_stores row. */
  const mkStore = async (o: { enabled?: boolean; paused?: boolean; max?: number; posSeenMinutesAgo?: number | null; row?: boolean } = {}): Promise<S> => {
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${staff.personId}, ${st!.id})`;
    if (o.row !== false) {
      const seen = o.posSeenMinutesAgo === undefined ? ago(0) : o.posSeenMinutesAgo === null ? null : ago(o.posSeenMinutesAgo);
      await sql`
        insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, pos_seen_at)
        values (${orgId}, ${st!.id}, ${o.enabled ?? true}, ${o.paused ?? false}, ${o.max ?? 60}, ${seen})`;
    }
    return { orgId, storeId: st!.id };
  };
  return { orgId, staff, variantId: variant!.id, valueId: val!.id, mkStore };
}

const codeSeq = new Map<string, number>();
/** A valid, never-repeating (per store) 4-digit code for raw rows. */
function rawCode(storeId: string): string {
  const n = (codeSeq.get(storeId) ?? Math.floor(Math.random() * 3000)) + 1;
  codeSeq.set(storeId, n);
  return String(1000 + (n % 9000));
}

type Raw = Record<string, string | number | boolean | null>;
/** A raw lobby_entries row (owner connection, bypasses the domain). `ageMin` backdates created_at; closed statuses get closed_at. */
async function rawEntry(s: S, o: { status?: string; ageMin?: number; closedMinAgo?: number | null; source?: 'lobby' | 'staff'; extra?: Raw } = {}): Promise<string> {
  const status = o.status ?? 'waiting';
  const terminal = ['seated', 'cancelled', 'removed', 'expired'].includes(status);
  const source = o.source ?? 'lobby';
  const row: Raw = {
    org_id: s.orgId,
    store_id: s.storeId,
    source,
    code: rawCode(s.storeId),
    display_name: 'Ana Reyes',
    party_size: 3,
    note: 'near the door',
    phone: source === 'staff' ? '+63 917 555 0100' : null,
    status,
    device_hash: source === 'lobby' ? uid('dev') : null,
    ip_hash: uid('ip'),
    client_request_id: uid('req'),
    created_at: ago(o.ageMin ?? 5),
    ...(status === 'seated' ? { session_ref: uid('SESS'), stand_label: '7' } : {}),
    ...(terminal ? { closed_at: o.closedMinAgo === null ? null : ago(o.closedMinAgo ?? 1) } : {}),
    ...(status === 'called' ? { called_at: ago(1) } : {}),
    ...(o.extra ?? {}),
  };
  const [r] = await sql<{ id: string }[]>`insert into lobby_entries ${sql(row)} returning id`;
  return r!.id;
}
const rawEntries = async (s: S, n: number, o: Parameters<typeof rawEntry>[1] = {}) => {
  for (let i = 0; i < n; i++) await rawEntry(s, o);
};

async function rawClaim(f: { orgId: string; staff: Actor }, entryId: string, status: 'pending' | 'approved' = 'pending'): Promise<string> {
  const row: Raw =
    status === 'pending'
      ? { holder_name: 'Lola Santos', id_number: 'OSCA-XY-5678', id_last4: '5678', status }
      : {
          holder_name: null, id_number: null, id_last4: '4321', status, session_ref: uid('SESS'), statutory_diner_ref: uid('diner'),
          acted_by_person_id: f.staff.personId, card_seen_at: ago(1),
        };
  const [r] = await sql<{ id: string }[]>`
    insert into lobby_discount_claims ${sql({ org_id: f.orgId, entry_id: entryId, kind: 'senior', ocr_assisted: false, ...row })} returning id`;
  return r!.id;
}
const claimOf = async (id: string) =>
  (await sql<{ status: string; holder_name: string | null; id_number: string | null; id_last4: string; kind: string }[]>`
    select status, holder_name, id_number, id_last4, kind from lobby_discount_claims where id = ${id}`)[0]!;
const entryOf = async (id: string) => (await sql<Record<string, unknown>[]>`select * from lobby_entries where id = ${id}`)[0]!;
const countEntries = async (s: S) => (await sql<{ n: number }[]>`select count(*)::int n from lobby_entries where store_id = ${s.storeId}`)[0]!.n;
const auditActions = async (orgId: string, entryId: string) =>
  await sql<{ action: string; actor_person_id: string | null }[]>`
    select action, actor_person_id from audit_log where org_id = ${orgId} and entity = 'lobby_entry' and entity_id = ${entryId} order by occurred_at, id`;

let ipN = 0;
type CheckInInput = Parameters<typeof checkIn>[1];
/** A check-in input with a fresh cookie hash and (unless given) a fresh ip hash. */
const inp = (s: S, o: Partial<CheckInInput> = {}): CheckInInput => ({
  orgId: s.orgId, storeId: s.storeId, deviceHash: uid('dev'), ipHash: uid(`ip${++ipN}`), displayName: 'Ben Cruz', partySize: 4, ...o,
});
const me = (s: S, deviceHash: string) => ({ orgId: s.orgId, storeId: s.storeId, deviceHash });
const SAME_SENTENCE_NOTE = 'a refusal never says which limit (section 4.1): same sentence for every limit';

// ================================================================================================ A. the happy path

describe('A. check-in happy path', () => {
  it('A1 creates a waiting lobby entry with a 4-digit code, the hashes, no phone, and returns it [kills: wrong source/status, code outside 1000-9999, hashes not stored]', async () => {
    const f = await orgFixture('a1');
    const s = await f.mkStore();
    const input = inp(s, { note: 'birthday table' });
    const r = await asOrg(f.orgId, (tx) => checkIn(tx, input));
    expect(r.created).toBe(true);
    expect(r.code).toMatch(/^[1-9][0-9]{3}$/);
    expect(r.status).toBe('waiting');
    expect(r.partiesAhead).toBe(0);
    const row = await entryOf(r.entryId);
    expect(row).toMatchObject({ source: 'lobby', status: 'waiting', code: r.code, display_name: 'Ben Cruz', party_size: 4, note: 'birthday table', phone: null });
    expect(row.device_hash).toBe(input.deviceHash);
    expect(row.ip_hash).toBe(input.ipHash);
    expect(row.store_id).toBe(s.storeId);
  });

  it('A2 stores the pre-order lines and their option values, and nothing priced [kills: lines dropped, options dropped, qty/kind lost]', async () => {
    const f = await orgFixture('a2');
    const s = await f.mkStore();
    const r = await asOrg(f.orgId, (tx) =>
      checkIn(tx, inp(s, { lines: [{ variantId: f.variantId, qty: 4, lineKind: 'package', optionValueIds: [f.valueId] }, { variantId: f.variantId, qty: 2, lineKind: 'a_la_carte' }] })),
    );
    const lines = await sql<{ id: string; qty: number; line_kind: string }[]>`select id, qty, line_kind from lobby_entry_lines where entry_id = ${r.entryId} order by qty desc`;
    expect(lines.map((l) => [l.qty, l.line_kind])).toEqual([[4, 'package'], [2, 'a_la_carte']]);
    const opts = await sql<{ line_id: string; option_value_id: string }[]>`select line_id, option_value_id from lobby_entry_line_options where line_id = ${lines[0]!.id}`;
    expect(opts).toEqual([{ line_id: lines[0]!.id, option_value_id: f.valueId }]);
    const none = await sql`select 1 from lobby_entry_line_options where line_id = ${lines[1]!.id}`;
    expect(none.length).toBe(0);
  });

  it('A3 input bounds: party 0 / 31, name blank / 41 chars, note 61 chars, 21 lines, qty 0 / 21 refused with LOBBY_BAD_INPUT; the edges 1 / 30 / 40 / 60 / 20 are accepted [kills: a missing or off-by-one bound]', async () => {
    const f = await orgFixture('a3');
    const s = await f.mkStore();
    const bad: Array<[string, Partial<CheckInInput>]> = [
      ['party 0', { partySize: 0 }],
      ['party 31', { partySize: 31 }],
      ['blank name', { displayName: '   ' }],
      ['name 41', { displayName: 'x'.repeat(41) }],
      ['note 61', { note: 'n'.repeat(61) }],
      ['21 lines', { lines: Array.from({ length: 21 }, () => ({ variantId: f.variantId, qty: 1, lineKind: 'a_la_carte' as const })) }],
      ['qty 0', { lines: [{ variantId: f.variantId, qty: 0, lineKind: 'a_la_carte' }] }],
      ['qty 21', { lines: [{ variantId: f.variantId, qty: 21, lineKind: 'a_la_carte' }] }],
    ];
    for (const [what, o] of bad) {
      const err = await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s, o)));
      expectRefusal(err, 'LOBBY_BAD_INPUT', what);
    }
    expect(await countEntries(s), 'a refused input left a row').toBe(0);
    const good: Array<Partial<CheckInInput>> = [
      { partySize: 1 }, { partySize: 30 }, { displayName: 'x'.repeat(40) }, { note: 'n'.repeat(60) },
      { lines: Array.from({ length: 20 }, () => ({ variantId: f.variantId, qty: 20, lineKind: 'a_la_carte' as const })) },
    ];
    for (const o of good) await asOrg(f.orgId, (tx) => checkIn(tx, inp(s, o)));
    expect(await countEntries(s)).toBe(good.length);
  });
});

// ================================================================================================ B. 5 per ip-hour

describe('B. the per-network limit (5 check-ins per ip_hash per store per hour)', () => {
  it('B1 the 5th check-in from one network is accepted, the 6th is refused LOBBY_IP_LIMIT with the plain counter sentence, no row is added [kills: limit absent, off by one either way]', async () => {
    expect(LOBBY_CHECKINS_PER_IP_HOUR).toBe(5);
    const f = await orgFixture('b1');
    const s = await f.mkStore();
    const ip = uid('ipB1');
    for (let i = 1; i <= 5; i++) {
      const r = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s, { ipHash: ip })));
      expect(r.created, `check-in ${i} of 5 must be accepted (positive control)`).toBe(true);
    }
    expect(await countEntries(s)).toBe(5);
    const err = await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s, { ipHash: ip })));
    const e = expectRefusal(err, 'LOBBY_IP_LIMIT', 'the 6th check-in');
    expect(e.userMessage).toMatch(COUNTER);
    expect(await countEntries(s), 'the refused 6th left a row').toBe(5);
  });

  it('B2 only the last hour counts: 5 check-ins 61 minutes old do not block, 5 that are 59 minutes old do [kills: no time window, wrong window]', async () => {
    const f = await orgFixture('b2');
    const old = await f.mkStore();
    const oldIp = uid('ipOld');
    await rawEntries(old, 5, { status: 'cancelled', ageMin: 61, extra: { ip_hash: oldIp } });
    const ok = await asOrg(f.orgId, (tx) => checkIn(tx, inp(old, { ipHash: oldIp })));
    expect(ok.created).toBe(true);
    const fresh = await f.mkStore();
    const freshIp = uid('ipFresh');
    await rawEntries(fresh, 5, { status: 'cancelled', ageMin: 59, extra: { ip_hash: freshIp } });
    expectRefusal(await refusedIn(f.orgId, (tx) => checkIn(tx, inp(fresh, { ipHash: freshIp }))), 'LOBBY_IP_LIMIT', '5 check-ins 59 minutes ago');
  });

  it('B3 closed (cancelled / removed / expired / seated) check-ins still count toward the hour [kills: limit that counts only live entries]', async () => {
    const f = await orgFixture('b3');
    const s = await f.mkStore();
    const ip = uid('ipB3');
    for (const status of ['cancelled', 'removed', 'expired', 'seated', 'cancelled']) await rawEntry(s, { status, ageMin: 10, extra: { ip_hash: ip } });
    expectRefusal(await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s, { ipHash: ip }))), 'LOBBY_IP_LIMIT', '5 closed check-ins this hour');
  });

  it('B4 the limit is per network AND per store: another network, and the same network at another store, are accepted [kills: global counter, counter that ignores the store]', async () => {
    const f = await orgFixture('b4');
    const s = await f.mkStore();
    const other = await f.mkStore();
    const ip = uid('ipB4');
    await rawEntries(s, 5, { ageMin: 5, extra: { ip_hash: ip } });
    expectRefusal(await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s, { ipHash: ip }))), 'LOBBY_IP_LIMIT', 'saturated network');
    expect((await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)))).created, 'another network at the same store').toBe(true);
    expect((await asOrg(f.orgId, (tx) => checkIn(tx, inp(other, { ipHash: ip })))).created, 'the same network at another store').toBe(true);
  });
});

// ================================================================================================ C. the 60-entry cap

describe('C. the store cap (max_live_entries, default 60)', () => {
  it('C1 the 60th live entry is accepted, the 61st is refused LOBBY_FULL with the counter sentence, no row is added [kills: cap absent, off by one either way]', async () => {
    const f = await orgFixture('c1');
    const s = await f.mkStore();
    await rawEntries(s, 29, { status: 'waiting' });
    await rawEntries(s, 30, { status: 'called', source: 'staff' }); // staff-parked entries are on the same list and count
    const r60 = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)));
    expect(r60.created, 'the 60th live entry (positive control)').toBe(true);
    const err = await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s)));
    const e = expectRefusal(err, 'LOBBY_FULL', 'the 61st live entry');
    expect(e.userMessage).toMatch(COUNTER);
    expect(await countEntries(s)).toBe(60);
  });

  it('C2 closed entries and other stores do not count toward the cap [kills: cap that counts every row, or every store]', async () => {
    const f = await orgFixture('c2');
    const s = await f.mkStore();
    const other = await f.mkStore();
    await rawEntries(s, 50, { status: 'waiting' });
    await rawEntries(s, 20, { status: 'cancelled' });
    await rawEntries(other, 60, { status: 'waiting' });
    expect((await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)))).created).toBe(true);
  });

  it("C3 the cap is the store's own max_live_entries, not a constant 60 [kills: hard-coded 60]", async () => {
    const f = await orgFixture('c3');
    const s = await f.mkStore({ max: 3 });
    await rawEntries(s, 2, { status: 'waiting' });
    expect((await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)))).created, 'the 3rd of 3').toBe(true);
    expectRefusal(await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s))), 'LOBBY_FULL', 'the 4th of 3');
  });

  it('C4 parkWalkIn ignores the 60-live cap (ruling 4): with the store full, staff can still park; a diner is still refused [kills: the cap applied to staff entries]', async () => {
    const f = await orgFixture('c4');
    const s = await f.mkStore({ max: 3 });
    await rawEntries(s, 3, { status: 'waiting' });
    expectRefusal(await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s))), 'LOBBY_FULL', 'diner at a full store');
    const r = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.staff, { storeId: s.storeId, displayName: 'Walk In', partySize: 2 }));
    expect(r.code).toMatch(/^[1-9][0-9]{3}$/);
    expect(await countEntries(s)).toBe(4);
    const paused = await f.mkStore({ paused: true, posSeenMinutesAgo: 30 });
    expect((await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.staff, { storeId: paused.storeId, displayName: 'Walk In', partySize: 2 }))).entryId).toBeTruthy();
  });
});

// ================================================================================================ D. paused / disabled / stale POS

describe('D. the store must be open: enabled, not paused, POS seen in the last 5 minutes', () => {
  it('D1 paused, disabled, no lobby_stores row, POS never seen and POS seen 6 minutes ago are each refused with their code and the SAME sentence [kills: any one of those checks missing; ' + SAME_SENTENCE_NOTE + ']', async () => {
    expect(LOBBY_POS_STALE_MINUTES).toBe(5);
    const f = await orgFixture('d1');
    const cases: Array<[string, Parameters<OrgFx['mkStore']>[0], string]> = [
      ['paused', { paused: true }, 'LOBBY_PAUSED'],
      ['disabled', { enabled: false }, 'LOBBY_DISABLED'],
      ['no lobby_stores row', { row: false }, 'LOBBY_DISABLED'],
      ['POS never seen', { posSeenMinutesAgo: null }, 'LOBBY_POS_STALE'],
      ['POS seen 6 minutes ago', { posSeenMinutesAgo: 6 }, 'LOBBY_POS_STALE'],
    ];
    const sentences = new Set<string>();
    for (const [what, o, code] of cases) {
      const s = await f.mkStore(o);
      const e = expectRefusal(await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s))), code, what);
      expect(e.userMessage, what).toMatch(COUNTER);
      sentences.add(e.userMessage);
      expect(await countEntries(s), `${what}: a refused check-in left a row`).toBe(0);
    }
    expect(sentences.size, SAME_SENTENCE_NOTE).toBe(1);
  });

  it('D2 positive control: enabled, not paused, POS seen 4 minutes ago is accepted [kills: a stale window shorter than 5 minutes]', async () => {
    const f = await orgFixture('d2');
    const s = await f.mkStore({ posSeenMinutesAgo: 4 });
    expect((await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)))).created).toBe(true);
  });

  it('D3 staff parking a walk-in is not blocked by a stale POS (the cashier is the POS) [kills: the diner-side checks leaking into parkWalkIn]', async () => {
    const f = await orgFixture('d3');
    const s = await f.mkStore({ posSeenMinutesAgo: 30 });
    const r = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.staff, { storeId: s.storeId, displayName: 'Walk In', partySize: 2 }));
    expect(r.code).toMatch(/^[1-9][0-9]{3}$/);
  });
});

// ================================================================================================ E. idempotent per cookie

describe('E. one live entry per cookie per store (idempotent check-in)', () => {
  it('E1 the same cookie again returns the SAME entry and code, creates no second row, and ignores the new name / party size [kills: a second row, a new code, an overwrite]', async () => {
    const f = await orgFixture('e1');
    const s = await f.mkStore();
    const first = inp(s);
    const a = await asOrg(f.orgId, (tx) => checkIn(tx, first));
    const b = await asOrg(f.orgId, (tx) => checkIn(tx, { ...first, ipHash: uid('ipOther'), displayName: 'Someone Else', partySize: 9 }));
    expect(b.entryId).toBe(a.entryId);
    expect(b.code).toBe(a.code);
    expect(b.created).toBe(false);
    expect(await countEntries(s)).toBe(1);
    expect(await entryOf(a.entryId)).toMatchObject({ display_name: 'Ben Cruz', party_size: 4 });
  });

  it('E2 an existing entry is returned even when its network is at the limit, and even when the store is full (assumption: the cookie lookup comes BEFORE the limits - CONTRACT QUESTION 6) [kills: limits checked first, locking a waiting diner out of their own place]', async () => {
    const f = await orgFixture('e2');
    const ipStore = await f.mkStore();
    const ip = uid('ipE2');
    const mineIp = inp(ipStore, { ipHash: ip });
    const a = await asOrg(f.orgId, (tx) => checkIn(tx, mineIp));
    await rawEntries(ipStore, 4, { status: 'waiting', extra: { ip_hash: ip } }); // 5 from this network this hour
    expectRefusal(await refusedIn(f.orgId, (tx) => checkIn(tx, inp(ipStore, { ipHash: ip }))), 'LOBBY_IP_LIMIT', 'a different cookie on the saturated network');
    const again = await asOrg(f.orgId, (tx) => checkIn(tx, mineIp));
    expect(again.entryId).toBe(a.entryId);
    expect(again.created).toBe(false);

    const fullStore = await f.mkStore({ max: 3 });
    const mineFull = inp(fullStore);
    const b = await asOrg(f.orgId, (tx) => checkIn(tx, mineFull));
    await rawEntries(fullStore, 2, { status: 'waiting' }); // 3 of 3 live
    expectRefusal(await refusedIn(f.orgId, (tx) => checkIn(tx, inp(fullStore))), 'LOBBY_FULL', 'a new cookie at a full store');
    const backAgain = await asOrg(f.orgId, (tx) => checkIn(tx, mineFull));
    expect(backAgain.entryId).toBe(b.entryId);
    expect(backAgain.created).toBe(false);
  });

  it('E3 after the entry is cancelled / removed / seated / expired the same cookie can check in again and gets a NEW entry [kills: a closed entry blocking its cookie]', async () => {
    const f = await orgFixture('e3');
    const s = await f.mkStore();
    for (const status of ['cancelled', 'removed', 'seated', 'expired']) {
      const dev = uid('devE3');
      const old = await rawEntry(s, { status, ageMin: 20, extra: { device_hash: dev } });
      const r = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s, { deviceHash: dev })));
      expect(r.created, `after ${status}`).toBe(true);
      expect(r.entryId).not.toBe(old);
    }
  });

  it('E4 the cookie is per store: the same cookie at another store gets its own entry; two cookies at one store get two [kills: a device lookup that ignores the store]', async () => {
    const f = await orgFixture('e4');
    const s1 = await f.mkStore();
    const s2 = await f.mkStore();
    const dev = uid('devE4');
    const a = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s1, { deviceHash: dev })));
    const b = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s2, { deviceHash: dev })));
    const c = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s1)));
    expect(new Set([a.entryId, b.entryId, c.entryId]).size).toBe(3);
  });

  it('E5 the same clientRequestId returns the same entry and creates no second row (ruling 10) [kills: a raw unique violation on replay, a second row]', async () => {
    const f = await orgFixture('e5');
    const s = await f.mkStore();
    const req = uid('reqE5');
    const dev = uid('devE5');
    const a = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s, { deviceHash: dev, clientRequestId: req })));
    const b = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s, { deviceHash: dev, clientRequestId: req })));
    expect(b.entryId).toBe(a.entryId);
    expect(b.code).toBe(a.code);
    expect(b.created).toBe(false);
    expect(await countEntries(s)).toBe(1);
  });
});

// ================================================================================================ F. the booking code

describe('F. the 4-digit booking code', () => {
  it('F1 a forced collision is retried and succeeds: 4 taken codes then a free one -> the free code, no error, transaction still usable [kills: no retry, retry without a savepoint (aborted transaction)]', async () => {
    expect(LOBBY_CODE_ATTEMPTS, 'ruling 3: 5 attempts in total').toBe(5);
    const f = await orgFixture('f1');
    const s = await f.mkStore();
    await rawEntry(s, { status: 'waiting', extra: { code: '4821' } });
    const queue = ['4821', '4821', '4821', '4821', '5555'];
    let calls = 0;
    const r = await asOrg(f.orgId, async (tx) => {
      const out = await checkIn(tx, inp(s), { randomCode: () => queue[Math.min(calls++, queue.length - 1)]! });
      await tx.execute(dsql`select 1`);
      return out;
    });
    expect(r.code).toBe('5555');
    expect(calls, 'the generator is called once per attempt').toBe(5);
    expect(await countEntries(s)).toBe(2);
  });

  it('F2 every attempt collides -> LOBBY_NO_CODE "Please check in at the counter", no row, transaction still usable [kills: infinite retry, retry count far above the spec, raw unique violation leaking]', async () => {
    const f = await orgFixture('f2');
    const s = await f.mkStore();
    await rawEntry(s, { status: 'called', extra: { code: '4821' } });
    let calls = 0;
    const err = await refusedIn(f.orgId, (tx) => checkIn(tx, inp(s), { randomCode: () => (calls++, '4821') }));
    const e = expectRefusal(err, 'LOBBY_NO_CODE', 'every attempt collides');
    expect(e.userMessage).toMatch(COUNTER);
    expect(calls, 'ruling 3: exactly 5 attempts in total (first try + 4 retries)').toBe(5);
    expect(await countEntries(s)).toBe(1);
  });

  it('F3 a code held by a CLOSED entry is free again: the first attempt with that code succeeds [kills: a full unique, a "never reuse" rule in the domain]', async () => {
    const f = await orgFixture('f3');
    const s = await f.mkStore();
    for (const status of ['cancelled', 'removed', 'expired', 'seated']) {
      await rawEntry(s, { status, ageMin: 30, extra: { code: '7777' } });
      let calls = 0;
      const r = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s), { randomCode: () => (calls++, '7777') }));
      expect(r.code, `closed ${status}`).toBe('7777');
      expect(calls).toBe(1);
      await sql`update lobby_entries set status = 'cancelled', closed_at = now() where id = ${r.entryId}`;
    }
  });

  it('F4 the default generator yields only 1000-9999 codes and is not a counter (20 check-ins on distinct networks) [kills: leading-zero codes, a sequential counter]', async () => {
    const f = await orgFixture('f4');
    const s = await f.mkStore();
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push(Number((await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)))).code));
    for (const c of codes) {
      expect(c).toBeGreaterThanOrEqual(1000);
      expect(c).toBeLessThanOrEqual(9999);
    }
    expect(new Set(codes).size, 'all live codes in one store are distinct').toBe(20);
    const consecutive = codes.every((c, i) => i === 0 || c === codes[i - 1]! + 1);
    expect(consecutive, 'codes must be random, not a counter (section 2.3)').toBe(false);
  });
});

// ================================================================================================ G. position

describe('G. position = earlier waiting|called entries of the SAME store', () => {
  it('G1 counts earlier waiting and called (lobby and staff-parked), not seated / cancelled / other-store / later [kills: counts closed, counts other stores, counts later arrivals, ignores staff entries]', async () => {
    const f = await orgFixture('g1');
    const s = await f.mkStore();
    const other = await f.mkStore();
    await rawEntry(s, { status: 'waiting', ageMin: 50 }); // ahead 1
    await rawEntry(s, { status: 'called', ageMin: 40, source: 'staff' }); // ahead 2 (called counts; staff-parked is on the same list)
    await rawEntry(s, { status: 'seated', ageMin: 45 }); // not counted
    await rawEntry(s, { status: 'cancelled', ageMin: 44 }); // not counted
    await rawEntry(s, { status: 'expired', ageMin: 43 }); // not counted
    await rawEntry(other, { status: 'waiting', ageMin: 46 }); // other store: not counted
    const dev = uid('devG1');
    const mineId = await rawEntry(s, { status: 'waiting', ageMin: 30, extra: { device_hash: dev } });
    await rawEntry(s, { status: 'waiting', ageMin: 10 }); // later: not counted for me
    const view = await asOrg(f.orgId, (tx) => getMyEntry(tx, me(s, dev)));
    expect(view?.entryId).toBe(mineId);
    expect(view?.partiesAhead).toBe(2);
    expect(await asOrg(f.orgId, (tx) => lobbyPartiesAhead(tx, f.orgId, mineId))).toBe(2);
  });

  it('G2 a new check-in joins at the back: ahead = every live entry before it; the first in an empty store has 0; a called entry still counts those before it [kills: position hard-coded, position that includes self]', async () => {
    const f = await orgFixture('g2');
    const s = await f.mkStore();
    const empty = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)));
    expect(empty.partiesAhead).toBe(0);
    await rawEntry(s, { status: 'waiting', ageMin: 20 });
    await rawEntry(s, { status: 'called', ageMin: 15 });
    const next = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)));
    expect(next.partiesAhead, 'the empty-store entry + the two raw ones').toBe(3);
    await asOrg(f.orgId, (tx) => callEntry(tx, f.staff, next.entryId));
    expect(await asOrg(f.orgId, (tx) => lobbyPartiesAhead(tx, f.orgId, next.entryId))).toBe(3);
  });
});

// ================================================================================================ H. expiry

describe('H. a live entry expires 3 hours after check-in (nightly job and on read)', () => {
  it('H1 expireStaleLobbyEntries expires waiting/called older than 3 h (closed_at set), leaves 2 h 50 m, seated and already-closed alone, returns the count [kills: no expiry, wrong cutoff, expiring seated]', async () => {
    expect(LOBBY_ENTRY_TTL_HOURS).toBe(3);
    const f = await orgFixture('h1');
    const s = await f.mkStore();
    const oldW = await rawEntry(s, { status: 'waiting', ageMin: 190 });
    const oldC = await rawEntry(s, { status: 'called', ageMin: 200, source: 'staff' });
    const young = await rawEntry(s, { status: 'waiting', ageMin: 170 });
    const seated = await rawEntry(s, { status: 'seated', ageMin: 300, closedMinAgo: 250 });
    const n = await asOrg(f.orgId, (tx) => expireStaleLobbyEntries(tx, f.orgId));
    expect(n).toBeGreaterThanOrEqual(2);
    for (const id of [oldW, oldC]) {
      const r = await entryOf(id);
      expect(r.status).toBe('expired');
      expect(r.closed_at, 'closed_at is set when an entry expires').not.toBeNull();
    }
    expect((await entryOf(young)).status).toBe('waiting');
    expect((await entryOf(seated)).status).toBe('seated');
    expect(await asOrg(f.orgId, (tx) => expireStaleLobbyEntries(tx, f.orgId)), 'a second run finds nothing').toBe(0);
  });

  it('H2 expiry on read: getMyEntry on a 3 h+ live entry reports it expired and persists that; the same cookie can then check in anew [kills: expiry only in the nightly job, a stale entry still returned by check-in]', async () => {
    const f = await orgFixture('h2');
    const s = await f.mkStore();
    const dev = uid('devH2');
    const stale = await rawEntry(s, { status: 'waiting', ageMin: 185, extra: { device_hash: dev } });
    const view = await asOrg(f.orgId, (tx) => getMyEntry(tx, me(s, dev)));
    expect(view?.entryId).toBe(stale);
    expect(view?.status).toBe('expired');
    expect((await entryOf(stale)).status).toBe('expired');
    const fresh = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s, { deviceHash: dev })));
    expect(fresh.created).toBe(true);
    expect(fresh.entryId).not.toBe(stale);
  });

  it('H3 check-in by a cookie whose live entry is already 3 h+ old (never read in between) expires it and creates a new one, not a unique violation [kills: stale entry returned as idempotent, partial unique leaking as a raw error]', async () => {
    const f = await orgFixture('h3');
    const s = await f.mkStore();
    const dev = uid('devH3');
    const stale = await rawEntry(s, { status: 'called', ageMin: 200, extra: { device_hash: dev } });
    const r = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s, { deviceHash: dev })));
    expect(r.created).toBe(true);
    expect(r.entryId).not.toBe(stale);
    expect((await entryOf(stale)).status).toBe('expired');
  });
});

// ================================================================================================ I. diner cancel

describe('I. the diner cancels their own entry', () => {
  it('I1 cancel -> cancelled with closed_at, and the code is free for the next diner [kills: status unchanged, closed_at missing]', async () => {
    const f = await orgFixture('i1');
    const s = await f.mkStore();
    const input = inp(s);
    await asOrg(f.orgId, (tx) => checkIn(tx, input));
    const out = await asOrg(f.orgId, (tx) => cancelMyEntry(tx, me(s, input.deviceHash)));
    expect(out.status).toBe('cancelled');
    const row = await entryOf(out.entryId);
    expect(row.status).toBe('cancelled');
    expect(row.closed_at).not.toBeNull();
    const reused = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s), { randomCode: () => String(row.code) }));
    expect(reused.code, 'a cancelled entry frees its code').toBe(row.code);
  });

  it('I2 another cookie cannot cancel it: LOBBY_NOT_FOUND, the entry stays waiting [kills: cancel keyed by code or entry id alone]', async () => {
    const f = await orgFixture('i2');
    const s = await f.mkStore();
    const a = await asOrg(f.orgId, (tx) => checkIn(tx, inp(s)));
    const err = await refusedIn(f.orgId, (tx) => cancelMyEntry(tx, me(s, uid('devStranger'))));
    expectRefusal(err, 'LOBBY_NOT_FOUND', 'a stranger cancelling');
    expect((await entryOf(a.entryId)).status).toBe('waiting');
  });

  it('I3 a seated entry cannot be cancelled by the diner: LOBBY_ENTRY_CLOSED [kills: cancel after seating]', async () => {
    const f = await orgFixture('i3');
    const s = await f.mkStore();
    const dev = uid('devI3');
    const id = await rawEntry(s, { status: 'seated', ageMin: 30, extra: { device_hash: dev } });
    expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyEntry(tx, me(s, dev))), 'LOBBY_ENTRY_CLOSED', 'cancel after seat');
    expect((await entryOf(id)).status).toBe('seated');
  });
});

// ================================================================================================ J. staff moves

describe('J. staff: park, list, call, seat, remove (every move writes audit_log)', () => {
  it('J1 parkWalkIn creates a source=staff entry with the phone, a code, on the same list, one audit row by the cashier [kills: phone dropped, source lobby, no audit, a second list]', async () => {
    const f = await orgFixture('j1');
    const s = await f.mkStore();
    const r = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.staff, { storeId: s.storeId, displayName: 'Walk In Family', partySize: 6, phone: '+63 917 555 0199', note: 'wheelchair' }));
    expect(r.code).toMatch(/^[1-9][0-9]{3}$/);
    expect(await entryOf(r.entryId)).toMatchObject({ source: 'staff', status: 'waiting', phone: '+63 917 555 0199', display_name: 'Walk In Family', party_size: 6, device_hash: null });
    const audit = await auditActions(f.orgId, r.entryId);
    expect(audit.map((a) => a.action)).toEqual(['lobby.park']);
    expect(audit[0]!.actor_person_id).toBe(f.staff.personId);
  });

  it("J2 listLobbyEntries returns this store's waiting|called entries oldest first, with code, name, size, status; no seated, closed or other-store rows; no hand-off url [kills: wrong order, closed rows listed, other store listed, url leaked to staff]", async () => {
    const f = await orgFixture('j2');
    const s = await f.mkStore();
    const other = await f.mkStore();
    const late = await rawEntry(s, { status: 'waiting', ageMin: 5 });
    const early = await rawEntry(s, { status: 'called', ageMin: 40 });
    await rawEntry(s, { status: 'seated', ageMin: 30, extra: { handoff_url: 'https://customer.example.test/join?token=tok-j2', handoff_expires_at: ago(-60) } });
    await rawEntry(s, { status: 'cancelled', ageMin: 20 });
    await rawEntry(other, { status: 'waiting', ageMin: 60 });
    const rows = await asOrg(f.orgId, (tx) => listLobbyEntries(tx, f.staff, s.storeId));
    expect(rows.map((r) => r.entryId)).toEqual([early, late]);
    expect(rows[0]).toMatchObject({ status: 'called', displayName: 'Ana Reyes', partySize: 3 });
    expect(rows[0]!.code).toMatch(/^[1-9][0-9]{3}$/);
    expect(JSON.stringify(rows), 'the hand-off url is a bearer link for the diner only').not.toMatch(/tok-j2|handoff/i);
  });

  it('J3 callEntry: waiting -> called, called_at and acted_by set, one lobby.call audit row; a closed entry cannot be called (LOBBY_ENTRY_CLOSED) [kills: no called_at, no audit, call after close]', async () => {
    const f = await orgFixture('j3');
    const s = await f.mkStore();
    const id = await rawEntry(s, { status: 'waiting' });
    const out = await asOrg(f.orgId, (tx) => callEntry(tx, f.staff, id));
    expect(out.status).toBe('called');
    const row = await entryOf(id);
    expect(row.status).toBe('called');
    expect(row.called_at).not.toBeNull();
    expect(row.acted_by_person_id).toBe(f.staff.personId);
    expect((await auditActions(f.orgId, id)).map((a) => a.action)).toEqual(['lobby.call']);
    const gone = await rawEntry(s, { status: 'cancelled' });
    expectRefusal(await refusedIn(f.orgId, (tx) => callEntry(tx, f.staff, gone)), 'LOBBY_ENTRY_CLOSED', 'calling a cancelled entry');
  });

  it('J4 seat WITHOUT a session is refused LOBBY_SEAT_NEEDS_SESSION (empty, spaces, missing), and without a stand too; the entry stays live and nothing is audited; WITH both it seats [kills: seat without session or stand, a raw CHECK violation leaking]', async () => {
    const f = await orgFixture('j4');
    const s = await f.mkStore();
    const id = await rawEntry(s, { status: 'called' });
    const bad: Array<[string, { sessionId: string; standLabel: string; joinUrl?: string | null }]> = [
      ['empty session', { sessionId: '', standLabel: '7' }],
      ['blank session', { sessionId: '   ', standLabel: '7' }],
      ['undefined session', { sessionId: undefined as unknown as string, standLabel: '7' }],
      ['empty stand', { sessionId: 'SESS-J4', standLabel: '' }],
    ];
    for (const [what, a] of bad) {
      const err = await refusedIn(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: id, ...a }));
      expectRefusal(err, 'LOBBY_SEAT_NEEDS_SESSION', what);
    }
    expect((await entryOf(id)).status, 'a refused seat moved the entry').toBe('called');
    expect((await auditActions(f.orgId, id)).length, 'a refused seat wrote an audit row').toBe(0);
    const out = await asOrg(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: id, sessionId: 'SESS-J4', standLabel: '7' }));
    expect(out.status).toBe('seated');
  });

  it('J5 seat from waiting or called records session_ref, stand_label, seated_at, closed_at, the cashier and one lobby.seat audit row; seating a cancelled entry is refused [kills: fields dropped, terminal entry re-seated]', async () => {
    const f = await orgFixture('j5');
    const s = await f.mkStore();
    for (const from of ['waiting', 'called']) {
      const id = await rawEntry(s, { status: from });
      await asOrg(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: id, sessionId: `SESS-${from}`, standLabel: '12' }));
      const row = await entryOf(id);
      expect(row).toMatchObject({ status: 'seated', session_ref: `SESS-${from}`, stand_label: '12', acted_by_person_id: f.staff.personId });
      expect(row.seated_at, `${from}: seated_at`).not.toBeNull();
      expect(row.closed_at, `${from}: closed_at (a seated entry is closed for the 24 h purge clock - CONTRACT QUESTION 8)`).not.toBeNull();
      expect((await auditActions(f.orgId, id)).map((a) => a.action)).toEqual(['lobby.seat']);
    }
    const dead = await rawEntry(s, { status: 'cancelled' });
    expectRefusal(await refusedIn(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: dead, sessionId: 'SESS-X', standLabel: '1' })), 'LOBBY_ENTRY_CLOSED', 'seating a cancelled entry');
  });

  it('J6 removeEntry: waiting|called -> removed with closed_at, the cashier and one lobby.remove audit row; a seated entry cannot be removed [kills: no audit, remove after seat]', async () => {
    const f = await orgFixture('j6');
    const s = await f.mkStore();
    const id = await rawEntry(s, { status: 'waiting' });
    const out = await asOrg(f.orgId, (tx) => removeEntry(tx, f.staff, id));
    expect(out.status).toBe('removed');
    const row = await entryOf(id);
    expect(row.status).toBe('removed');
    expect(row.closed_at).not.toBeNull();
    expect(row.acted_by_person_id).toBe(f.staff.personId);
    expect((await auditActions(f.orgId, id)).map((a) => a.action)).toEqual(['lobby.remove']);
    const seated = await rawEntry(s, { status: 'seated' });
    expectRefusal(await refusedIn(f.orgId, (tx) => removeEntry(tx, f.staff, seated)), 'LOBBY_ENTRY_CLOSED', 'removing a seated entry');
  });

  it('J7 an unknown entry id is LOBBY_NOT_FOUND for call, seat and remove, and an entry of ANOTHER org is not found either [kills: cross-org reach, raw FK error]', async () => {
    const f = await orgFixture('j7');
    const g = await orgFixture('j7b');
    const theirs = await rawEntry(await g.mkStore(), { status: 'waiting' });
    const ghost = '00000000-0000-7000-8000-000000000001';
    for (const id of [ghost, theirs]) {
      expectRefusal(await refusedIn(f.orgId, (tx) => callEntry(tx, f.staff, id)), 'LOBBY_NOT_FOUND', `call ${id}`);
      expectRefusal(await refusedIn(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: id, sessionId: 'S', standLabel: '1' })), 'LOBBY_NOT_FOUND', `seat ${id}`);
      expectRefusal(await refusedIn(f.orgId, (tx) => removeEntry(tx, f.staff, id)), 'LOBBY_NOT_FOUND', `remove ${id}`);
    }
    expect((await entryOf(theirs)).status).toBe('waiting');
  });
});

// ================================================================================================ K. hand-off url

describe('K. the hand-off url: returned once, to the owning cookie only', () => {
  const JOIN = 'https://customer.example.test/join?token=tok-k1';

  it("K1 after seat the owner's next read gets the url; the read after that gets null and the column is cleared [kills: url returned twice, never cleared]", async () => {
    const f = await orgFixture('k1');
    const s = await f.mkStore();
    const dev = uid('devK1');
    const id = await rawEntry(s, { status: 'called', extra: { device_hash: dev } });
    await asOrg(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: id, sessionId: 'SESS-K1', standLabel: '3', joinUrl: JOIN }));
    expect((await entryOf(id)).handoff_url, "stored for the diner's next poll").toBe(JOIN);
    const first = await asOrg(f.orgId, (tx) => getMyEntry(tx, me(s, dev)));
    expect(first?.status).toBe('seated');
    expect(first?.handoffUrl).toBe(JOIN);
    const second = await asOrg(f.orgId, (tx) => getMyEntry(tx, me(s, dev)));
    expect(second?.handoffUrl, 'the second read must not return the bearer link again').toBeNull();
    const row = await entryOf(id);
    expect(row.handoff_url).toBeNull();
    expect(row.handoff_expires_at, 'the pair CHECK: url and expiry are cleared together').toBeNull();
  });

  it("K2 seat sets the expiry about 2 hours ahead (the token's own life) [kills: no expiry, expiry in the past or days]", async () => {
    const f = await orgFixture('k2');
    const s = await f.mkStore();
    const id = await rawEntry(s, { status: 'waiting', extra: { device_hash: uid('devK2') } });
    await asOrg(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: id, sessionId: 'SESS-K2', standLabel: '4', joinUrl: JOIN }));
    const [r] = await sql<{ minutes: string }[]>`select extract(epoch from (handoff_expires_at - now())) / 60 as minutes from lobby_entries where id = ${id}`;
    expect(Number(r!.minutes)).toBeGreaterThan(110);
    expect(Number(r!.minutes)).toBeLessThanOrEqual(121);
  });

  it('K3 an expired url is never returned and is cleared on read [kills: returning a url past its expiry]', async () => {
    const f = await orgFixture('k3');
    const s = await f.mkStore();
    const dev = uid('devK3');
    const id = await rawEntry(s, {
      status: 'seated', ageMin: 200, closedMinAgo: 150,
      extra: { device_hash: dev, handoff_url: JOIN, handoff_expires_at: ago(30) },
    });
    const view = await asOrg(f.orgId, (tx) => getMyEntry(tx, me(s, dev)));
    expect(view?.handoffUrl).toBeNull();
    expect((await entryOf(id)).handoff_url).toBeNull();
  });

  it('K4 another cookie never gets the url and cannot clear it: getMyEntry for a stranger is null, the owner still gets it afterwards [kills: url keyed by entry id or code, a stranger consuming the one-time read]', async () => {
    const f = await orgFixture('k4');
    const s = await f.mkStore();
    const dev = uid('devK4');
    const id = await rawEntry(s, { status: 'waiting', extra: { device_hash: dev } });
    await asOrg(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: id, sessionId: 'SESS-K4', standLabel: '5', joinUrl: JOIN }));
    const stranger = await asOrg(f.orgId, (tx) => getMyEntry(tx, me(s, uid('devStranger'))));
    expect(stranger).toBeNull();
    const owner = await asOrg(f.orgId, (tx) => getMyEntry(tx, me(s, dev)));
    expect(owner?.handoffUrl).toBe(JOIN);
  });
});

// ================================================================================================ L. pending claims on close (S1 audit notes)

describe('L. closing an entry expires its pending discount claims (S1 audit note 1)', () => {
  type Closer = [string, (f: OrgFx, s: S, entryId: string, dev: string) => Promise<unknown>];
  const closers: Closer[] = [
    ['diner cancel', (f, s, _id, dev) => asOrg(f.orgId, (tx) => cancelMyEntry(tx, me(s, dev)))],
    ['staff remove', (f, _s, id) => asOrg(f.orgId, (tx) => removeEntry(tx, f.staff, id))],
    ['3 h expiry', (f) => asOrg(f.orgId, (tx) => expireStaleLobbyEntries(tx, f.orgId))],
  ];

  it.each(closers)("L1 %s: every PENDING claim becomes expired, name and ID number are NULL, last4 and kind stay; an approved claim and another entry's pending claim are untouched [kills: claims left pending, PII kept, approved claim expired, other entry swept]", async (name, close) => {
    const f = await orgFixture('l1');
    const s = await f.mkStore();
    const dev = uid('devL1');
    const id = await rawEntry(s, { status: 'waiting', ageMin: name === '3 h expiry' ? 200 : 20, extra: { device_hash: dev, party_size: 5 } });
    const bystander = await rawEntry(s, { status: 'waiting', ageMin: 10 });
    const p1 = await rawClaim(f, id);
    const p2 = await rawClaim(f, id);
    const approved = await rawClaim(f, id, 'approved');
    const others = await rawClaim(f, bystander);
    await close(f, s, id, dev);
    for (const c of [p1, p2]) {
      const row = await claimOf(c);
      expect(row.status, 'pending claim not expired').toBe('expired');
      expect(row.holder_name).toBeNull();
      expect(row.id_number).toBeNull();
      expect(row.id_last4).toBe('5678');
      expect(row.kind).toBe('senior');
    }
    expect((await claimOf(approved)).status, 'an approved claim is the receipt record, not ours to expire').toBe('approved');
    expect((await claimOf(others)).status, "another entry's claim").toBe('pending');
  });

  it('L2 SEATING an entry does NOT expire its pending claims (approval needs a seated entry with the claim still pending) [kills: expiring claims on seat]', async () => {
    const f = await orgFixture('l2');
    const s = await f.mkStore();
    const id = await rawEntry(s, { status: 'called', extra: { party_size: 4 } });
    const claim = await rawClaim(f, id);
    await asOrg(f.orgId, (tx) => seatEntry(tx, f.staff, { entryId: id, sessionId: 'SESS-L2', standLabel: '9' }));
    const row = await claimOf(claim);
    expect(row.status).toBe('pending');
    expect(row.holder_name).toBe('Lola Santos');
  });

  it('L3 sweepStalePendingClaims (ruling 7): a pending claim is swept when its entry is closed (any age, e.g. seated 1 h ago) OR the claim itself is more than 24 h old (even on a live entry); a young claim on a live entry and approved claims stay; PII NULL; returns the count [kills: sweep ignoring closed entries, ignoring claim age, sweeping young live claims, sweeping approved claims]', async () => {
    const f = await orgFixture('l3');
    const s = await f.mkStore();
    const seated = await rawEntry(s, { status: 'seated', ageMin: 120, closedMinAgo: 60, extra: { party_size: 4 } });
    const live = await rawEntry(s, { status: 'waiting', ageMin: 30, extra: { party_size: 4 } });
    const closedClaim = await rawClaim(f, seated);
    const closedApproved = await rawClaim(f, seated, 'approved');
    const oldLiveClaim = await rawClaim(f, live);
    await sql`update lobby_discount_claims set created_at = ${ago(25 * 60)} where id = ${oldLiveClaim}`;
    const youngLiveClaim = await rawClaim(f, live);
    const n = await asOrg(f.orgId, (tx) => sweepStalePendingClaims(tx, f.orgId));
    expect(n).toBe(2);
    expect(await claimOf(closedClaim)).toMatchObject({ status: 'expired', holder_name: null, id_number: null, id_last4: '5678' });
    expect(await claimOf(oldLiveClaim)).toMatchObject({ status: 'expired', holder_name: null, id_number: null });
    expect((await claimOf(closedApproved)).status).toBe('approved');
    expect((await claimOf(youngLiveClaim)).status, 'young claim on a live entry').toBe('pending');
    expect(await asOrg(f.orgId, (tx) => sweepStalePendingClaims(tx, f.orgId)), 'a second sweep finds nothing').toBe(0);
  });
});

// ================================================================================================ M. nightly purge

describe('M. the nightly purge (section 4.7): personal columns NULL on entries closed more than 24 h, counts stay', () => {
  const PERSONAL = ['display_name', 'phone', 'note', 'device_hash', 'ip_hash', 'handoff_url', 'handoff_expires_at'] as const;
  const KEPT = ['id', 'org_id', 'store_id', 'source', 'code', 'party_size', 'status', 'created_at', 'closed_at', 'seated_at', 'called_at', 'session_ref', 'stand_label'] as const;

  it('M1 purge nulls display_name, phone, note, device_hash, ip_hash, handoff_url (and its pair expiry) and the celebrant name on every entry closed > 24 h, of each terminal kind, and keeps every other column and every row [kills: a column missed, rows deleted, an outcome altered]', async () => {
    expect(LOBBY_PURGE_AFTER_HOURS).toBe(24);
    const f = await orgFixture('m1');
    const s = await f.mkStore();
    const ids: string[] = [];
    for (const [status, source] of [['cancelled', 'lobby'], ['removed', 'staff'], ['expired', 'lobby'], ['seated', 'lobby']] as const) {
      ids.push(
        await rawEntry(s, {
          status, source, ageMin: 2000, closedMinAgo: 25 * 60,
          extra: { handoff_url: 'https://customer.example.test/join?token=tok-m1', handoff_expires_at: ago(24 * 60) },
        }),
      );
    }
    const birthdays: string[] = [];
    for (const id of ids) {
      const [b] = await sql<{ id: string }[]>`insert into lobby_birthday_requests (org_id, entry_id, celebrant_name, status) values (${f.orgId}, ${id}, 'Ben', 'requested') returning id`;
      birthdays.push(b!.id);
    }
    const before = await Promise.all(ids.map(entryOf));
    const totalBefore = await countEntries(s);
    const out = await asOrg(f.orgId, (tx) => purgeLobbyPersonalData(tx, f.orgId));
    expect(out.entriesPurged).toBe(4);
    expect(await countEntries(s), 'the purge keeps the counts (rows are never deleted)').toBe(totalBefore);
    for (let i = 0; i < ids.length; i++) {
      const after = await entryOf(ids[i]!);
      for (const c of PERSONAL) expect(after[c], `${String(before[i]!.status)}: ${c} must be NULL`).toBeNull();
      for (const c of KEPT) expect(after[c], `${String(before[i]!.status)}: ${c} must be kept`).toEqual(before[i]![c]);
    }
    for (const b of birthdays) {
      const [r] = await sql<{ celebrant_name: string | null; status: string }[]>`select celebrant_name, status from lobby_birthday_requests where id = ${b}`;
      expect(r!.celebrant_name).toBeNull();
      expect(r!.status).toBe('requested');
    }
  });

  it('M2 only entries closed MORE than 24 h ago: 23 h closed, a live 30 h old entry are untouched (purge runs on closed_at, not created_at) [kills: purge by created_at, purging live entries, wrong cutoff]', async () => {
    const f = await orgFixture('m2');
    const s = await f.mkStore();
    const recent = await rawEntry(s, { status: 'cancelled', ageMin: 3000, closedMinAgo: 23 * 60 });
    const live = await rawEntry(s, { status: 'waiting', ageMin: 30 * 60 });
    const old = await rawEntry(s, { status: 'cancelled', ageMin: 3000, closedMinAgo: 25 * 60 });
    const out = await asOrg(f.orgId, (tx) => purgeLobbyPersonalData(tx, f.orgId));
    expect(out.entriesPurged).toBe(1);
    expect((await entryOf(recent)).display_name).toBe('Ana Reyes');
    expect((await entryOf(live)).display_name).toBe('Ana Reyes');
    expect((await entryOf(live)).device_hash).not.toBeNull();
    expect((await entryOf(old)).display_name).toBeNull();
  });

  it("M3 a second run purges nothing (idempotent); another org's old closed entries are untouched [kills: re-counting purged rows, a purge without the org filter]", async () => {
    const f = await orgFixture('m3');
    const g = await orgFixture('m3b');
    const s = await f.mkStore();
    const theirs = await rawEntry(await g.mkStore(), { status: 'cancelled', ageMin: 3000, closedMinAgo: 30 * 60 });
    await rawEntry(s, { status: 'cancelled', ageMin: 3000, closedMinAgo: 30 * 60 });
    expect((await asOrg(f.orgId, (tx) => purgeLobbyPersonalData(tx, f.orgId))).entriesPurged).toBe(1);
    expect((await asOrg(f.orgId, (tx) => purgeLobbyPersonalData(tx, f.orgId))).entriesPurged).toBe(0);
    expect((await entryOf(theirs)).display_name, "the other org's entry").toBe('Ana Reyes');
  });

  it('M4 runLobbyNightly runs expiry, claim sweep and purge in that order and reports all three: a 3 h+ live entry with a pending claim is expired and its claim expired; a seated-and-gone claim is swept; a 26 h closed entry is purged [kills: a step missing, steps in the wrong order, no summary]', async () => {
    const f = await orgFixture('m4');
    const s = await f.mkStore();
    const stale = await rawEntry(s, { status: 'waiting', ageMin: 200, extra: { party_size: 3 } });
    const staleClaim = await rawClaim(f, stale);
    const gone = await rawEntry(s, { status: 'seated', ageMin: 2000, closedMinAgo: 26 * 60, extra: { party_size: 3 } });
    const goneClaim = await rawClaim(f, gone);
    const out = await asOrg(f.orgId, (tx) => runLobbyNightly(tx, f.orgId));
    expect(out).toMatchObject({ entriesExpired: 1, claimsExpired: expect.any(Number), entriesPurged: 1 });
    expect((await entryOf(stale)).status).toBe('expired');
    expect((await claimOf(staleClaim)).status).toBe('expired');
    expect((await claimOf(goneClaim)).status).toBe('expired');
    expect((await entryOf(gone)).display_name, 'the seated-and-gone entry is purged in the same run').toBeNull();
    expect((await entryOf(stale)).display_name, 'just closed by step 1: its 24 h has not run yet').toBe('Ana Reyes');
  });
});
