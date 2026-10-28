import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S5 (TESTER) - the lobby moves a POS TABLET makes, DOMAIN layer: docs/tasks/455-customer-lobby.md "S5 rulings" 2, 3, 4 and
 * the S5 row of section 5. Real Postgres via TEST_DATABASE_URL (`_test` name guard).
 *
 * RED TODAY, for one reason: packages/domain/src/lobby/terminal.ts does not exist (the import below fails to resolve).
 *
 * CONTRACT ASSUMED (packages/domain/src/lobby/terminal.ts; the builder may rename only together with this file):
 *   interface TerminalActor { orgId: string; erpStoreId: string; terminalPersonId: string; cashierName: string }
 *   listForTerminal(tx, actor): Promise<{ lobbyEnabled: boolean; paused: boolean; entries: TerminalListRow[] }>
 *       TerminalListRow = { entryId, code, displayName, partySize, status, source, note, phone, createdAt, calledAt,
 *                           lines: { lineKind, qty, variantId, optionValueIds: string[], label: string, posItemKey: string | null }[] }
 *   parkForTerminal(tx, actor, { displayName, partySize, phone?, note? }, opts?: { randomCode? }): Promise<{ entryId, code }>
 *   callForTerminal(tx, actor, entryId): Promise<{ entryId, status: 'called' }>
 *   seatForTerminal(tx, actor, { entryId, sessionId, standLabel, joinUrl? }): Promise<{ entryId, status: 'seated' }>
 *   removeForTerminal(tx, actor, entryId): Promise<{ entryId, status: 'removed' }>
 *   setLobbyPausedForTerminal(tx, actor, paused: boolean): Promise<{ paused: boolean }>
 *   Refusals are LobbyRefusal (same class and codes as staff.ts). None of these calls authorize(): the terminal person below holds NO
 *   role and NO store scope, which is the whole point of ruling 2.
 * The audit entity/entityId of lobby.pause / lobby.resume is left to the builder: those two rows are found by org + action + store_id.
 *
 * MUTANT INDEX (test titles end with "[kills: ...]"): another store's entry acted on / answered differently from a ghost id; audit
 * actor = nobody or a diner; cashier name missing; diner name / phone / join link in the audit payload; list that does not stamp
 * pos_seen_at / fails without a lobby_stores row / creates one; pause without a row silently ok; pause not audited; hash or hand-off
 * secrets in the list; unlinked line dropped / inactive link used / other store's link used; terminal.ts calling authorize().
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import {
  callForTerminal,
  listForTerminal,
  parkForTerminal,
  removeForTerminal,
  seatForTerminal,
  setLobbyPausedForTerminal,
  type TerminalActor,
} from '../../src/lobby/terminal';
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
const itemCode = () => `${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'A')}-${String(1 + Math.floor(Math.random() * 998)).padStart(3, '0')}`;

const DINER_NAME = 'Ana Reyes';
const DINER_PHONE = '+63 917 555 0100';
const CASHIER = 'Cora Cashier';

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

type S = { orgId: string; storeId: string };

async function orgFixture(hint: string) {
  const code = uid(`t455s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  // The tablet's terminal person: NO person_roles row, NO person_store_scope row. If a move calls authorize() it is refused.
  const [tp] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Terminal 01') returning id`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Menu Admin') returning id`;
  const terminalPersonId = tp!.id;
  const adminId = admin!.id;
  const [cat] = await sql<{ id: string }[]>`
    insert into menu_categories (org_id, name, sort_order, status, created_by) values (${orgId}, ${uid('Cat')}, 0, 'active', ${adminId}) returning id`;
  const [stock] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${itemCode()}, ${uid('Stock')}, 'raw_material', 'kg', ${adminId}) returning id`;
  const [grp] = await sql<{ id: string }[]>`
    insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
    values (${orgId}, ${uid('Grp')}, 'single', 1, 1, 'active', ${adminId}) returning id`;
  const [val] = await sql<{ id: string }[]>`
    insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${orgId}, ${grp!.id}, ${uid('Val')}, 0, 'active', ${adminId}) returning id`;

  /** A menu item with one default variant and a depletion rule (a POS link needs a rule in force). Returns the variant and the item's name. */
  const mkVariant = async (kind: 'package' | 'a_la_carte' = 'a_la_carte') => {
    const name = uid(kind === 'package' ? 'Pkg' : 'Pork');
    const [item] = await sql<{ id: string }[]>`
      insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
      values (${orgId}, ${cat!.id}, ${name}, ${kind}, ${kind === 'a_la_carte'}, ${kind === 'package'}, true, 0, 'active', ${adminId}) returning id`;
    const [variant] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
      values (${orgId}, ${item!.id}, null, true, 0, 'active', ${adminId}) returning id`;
    await sql`
      insert into menu_depletion_rules (org_id, variant_id, mode, item_id, quantity_per_sale, created_by)
      values (${orgId}, ${variant!.id}, 'direct', ${stock!.id}, 0.2, ${adminId})`;
    return { variantId: variant!.id, itemName: name };
  };
  const link = async (storeId: string, variantId: string, key: string, status: 'active' | 'inactive' = 'active') => {
    await sql`
      insert into menu_pos_v1_links (org_id, store_id, pos_item_key, variant_id, status, created_by)
      values (${orgId}, ${storeId}, ${key}, ${variantId}, 'active', ${adminId})`;
    if (status === 'inactive') await sql`update menu_pos_v1_links set status = 'inactive' where store_id = ${storeId} and pos_item_key = ${key}`;
  };

  /** A fresh store. Default: a lobby_stores row, enabled, not paused, POS seen null. row false = no lobby_stores row. */
  const mkStore = async (o: { enabled?: boolean; paused?: boolean; posSeenMinutesAgo?: number | null; row?: boolean } = {}): Promise<S> => {
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
    if (o.row !== false) {
      const seen = o.posSeenMinutesAgo === undefined || o.posSeenMinutesAgo === null ? null : ago(o.posSeenMinutesAgo);
      await sql`
        insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, pos_seen_at)
        values (${orgId}, ${st!.id}, ${o.enabled ?? true}, ${o.paused ?? false}, 60, ${seen})`;
    }
    return { orgId, storeId: st!.id };
  };
  const actorFor = (s: S): TerminalActor => ({ orgId, erpStoreId: s.storeId, terminalPersonId, cashierName: CASHIER });
  return { orgId, terminalPersonId, adminId, mkVariant, link, mkStore, actorFor, valueId: val!.id };
}

const codeSeq = new Map<string, number>();
function rawCode(storeId: string): string {
  const n = (codeSeq.get(storeId) ?? Math.floor(Math.random() * 3000)) + 1;
  codeSeq.set(storeId, n);
  return String(1000 + (n % 9000));
}
type Raw = Record<string, string | number | boolean | null>;
async function rawEntry(s: S, o: { status?: string; source?: 'lobby' | 'staff'; ageMin?: number; extra?: Raw } = {}): Promise<string> {
  const status = o.status ?? 'waiting';
  const source = o.source ?? 'lobby';
  const row: Raw = {
    org_id: s.orgId,
    store_id: s.storeId,
    source,
    code: rawCode(s.storeId),
    display_name: DINER_NAME,
    party_size: 3,
    note: 'near the door',
    phone: source === 'staff' ? DINER_PHONE : null,
    status,
    device_hash: source === 'lobby' ? uid('devhash') : null,
    ip_hash: uid('iphash'),
    client_request_id: uid('req'),
    created_at: ago(o.ageMin ?? 5),
    ...(status === 'called' ? { called_at: ago(1) } : {}),
    ...(o.extra ?? {}),
  };
  const [r] = await sql<{ id: string }[]>`insert into lobby_entries ${sql(row)} returning id`;
  return r!.id;
}
const entryOf = async (id: string) => (await sql<Record<string, unknown>[]>`select * from lobby_entries where id = ${id}`)[0]!;
const lobbyStoreOf = async (s: S) => (await sql<{ paused: boolean; pos_seen_at: Date | null }[]>`select paused, pos_seen_at from lobby_stores where store_id = ${s.storeId}`)[0];
const auditFor = async (s: S, action?: string) =>
  await sql<{ action: string; actor_person_id: string | null; source: string; before: unknown; after: unknown; entity_id: string }[]>`
    select action, actor_person_id, source, before, after, entity_id from audit_log
     where org_id = ${s.orgId} and store_id = ${s.storeId} and action like 'lobby.%' ${action ? sql`and action = ${action}` : sql``} order by occurred_at, id`;
const auditAll = async (s: S) => (await sql`select * from audit_log where org_id = ${s.orgId} and store_id = ${s.storeId} and action like 'lobby.%'`).length;

// ================================================================================================ A. the tablet is the actor

describe('A. park / call / seat / remove by the tablet: the terminal person is the actor, the cashier is named, the diner is not', () => {
  it('A1 park creates a source=staff entry in the TABLET\'s store, with the phone, and one lobby.park audit row by the terminal person carrying after.cashier [kills: wrong store, phone dropped, actor not the terminal, cashier missing, authorize() demanded of a person with no role]', async () => {
    const f = await orgFixture('a1');
    const s = await f.mkStore();
    const r = await asOrg(f.orgId, (tx) => parkForTerminal(tx, f.actorFor(s), { displayName: DINER_NAME, partySize: 5, phone: DINER_PHONE, note: 'birthday' }));
    expect(r.code).toMatch(/^[1-9][0-9]{3}$/);
    const row = await entryOf(r.entryId);
    expect(row).toMatchObject({ source: 'staff', status: 'waiting', store_id: s.storeId, display_name: DINER_NAME, party_size: 5, phone: DINER_PHONE, note: 'birthday', device_hash: null });
    expect(row.acted_by_person_id).toBe(f.terminalPersonId);
    const audit = await auditFor(s);
    expect(audit.map((a) => a.action)).toEqual(['lobby.park']);
    expect(audit[0]!.actor_person_id).toBe(f.terminalPersonId);
    expect(audit[0]!.source).toBe('pos');
    expect(audit[0]!.entity_id).toBe(r.entryId);
    expect((audit[0]!.after as Record<string, unknown>).cashier).toBe(CASHIER);
  });

  it('A2 call, seat and remove each write one audit row by the terminal person with after.cashier, and NO payload anywhere holds the diner name, the phone or the join link [kills: actor = nobody, cashier missing, diner data or the bearer link in the audit]', async () => {
    const f = await orgFixture('a2');
    const s = await f.mkStore();
    const joinUrl = 'https://customer.shareat.net/join?token=SECRETJOINTOKEN123';
    const a = await rawEntry(s, { source: 'staff', extra: { phone: DINER_PHONE } });
    const b = await rawEntry(s, { source: 'lobby' });
    const c = await rawEntry(s, { source: 'lobby' });
    await asOrg(f.orgId, async (tx) => {
      await callForTerminal(tx, f.actorFor(s), a);
      await seatForTerminal(tx, f.actorFor(s), { entryId: a, sessionId: uid('SESS'), standLabel: '7' });
      await seatForTerminal(tx, f.actorFor(s), { entryId: b, sessionId: uid('SESS'), standLabel: '8', joinUrl });
      await removeForTerminal(tx, f.actorFor(s), c);
    });
    const audit = await auditFor(s);
    expect(audit.map((x) => x.action).sort()).toEqual(['lobby.call', 'lobby.remove', 'lobby.seat', 'lobby.seat']);
    for (const row of audit) {
      expect(row.actor_person_id, `${row.action} actor`).toBe(f.terminalPersonId);
      expect(row.source).toBe('pos');
      expect((row.after as Record<string, unknown>).cashier, `${row.action} after.cashier`).toBe(CASHIER);
    }
    const dump = JSON.stringify(audit);
    for (const secret of [DINER_NAME, DINER_PHONE, 'SECRETJOINTOKEN123', 'near the door']) {
      expect(dump.includes(secret), `the audit payload leaks ${secret}`).toBe(false);
    }
  });

  it('A3 seat stores session_ref, stand and the join link for a LOBBY entry (the phone picks it up); a staff entry has no phone to hand off to, so no link is kept; a closed entry is refused; seat without a session or stand is refused [kills: link dropped, link kept for a staff walk-in, closed entry re-seated, seat without session]', async () => {
    const f = await orgFixture('a3');
    const s = await f.mkStore();
    const lobby = await rawEntry(s, { source: 'lobby' });
    const staff = await rawEntry(s, { source: 'staff' });
    const gone = await rawEntry(s, { source: 'lobby' });
    await asOrg(f.orgId, async (tx) => {
      await seatForTerminal(tx, f.actorFor(s), { entryId: lobby, sessionId: 'SESS-1', standLabel: '7', joinUrl: 'https://customer.shareat.net/join?token=abc' });
      await seatForTerminal(tx, f.actorFor(s), { entryId: staff, sessionId: 'SESS-2', standLabel: '8', joinUrl: 'https://customer.shareat.net/join?token=def' });
      await removeForTerminal(tx, f.actorFor(s), gone);
    });
    expect(await entryOf(lobby)).toMatchObject({ status: 'seated', session_ref: 'SESS-1', stand_label: '7', handoff_url: 'https://customer.shareat.net/join?token=abc' });
    expect(await entryOf(staff)).toMatchObject({ status: 'seated', session_ref: 'SESS-2', handoff_url: null });
    expectRefusal(await refusedIn(f.orgId, (tx) => seatForTerminal(tx, f.actorFor(s), { entryId: gone, sessionId: 'S', standLabel: '1' })), 'LOBBY_ENTRY_CLOSED', 'seat a removed entry');
    expectRefusal(await refusedIn(f.orgId, (tx) => callForTerminal(tx, f.actorFor(s), gone)), 'LOBBY_ENTRY_CLOSED', 'call a removed entry');
    const live = await rawEntry(s);
    expectRefusal(await refusedIn(f.orgId, (tx) => seatForTerminal(tx, f.actorFor(s), { entryId: live, sessionId: '  ', standLabel: '1' })), 'LOBBY_SEAT_NEEDS_SESSION', 'blank session');
    expectRefusal(await refusedIn(f.orgId, (tx) => seatForTerminal(tx, f.actorFor(s), { entryId: live, sessionId: 'S', standLabel: '' })), 'LOBBY_SEAT_NEEDS_SESSION', 'blank stand');
    expect((await entryOf(live)).status).toBe('waiting');
  });
});

// ================================================================================================ B. another store's entry

describe('B. a tablet cannot touch, or tell apart, another store\'s entry', () => {
  it('B1 call / seat / remove on ANOTHER store\'s entry answer LOBBY_NOT_FOUND exactly like a ghost id, change nothing, audit nothing; list shows only its own store [kills: missing store check in one move, a different refusal that confirms the entry exists, store check after the write]', async () => {
    const f = await orgFixture('b1');
    const mine = await f.mkStore();
    const theirs = await f.mkStore();
    const foreign = await rawEntry(theirs, { source: 'lobby' });
    const ghost = '019e0000-0000-7000-8000-000000000001';
    const moves: Array<[string, (tx: Tx, id: string) => Promise<unknown>]> = [
      ['call', (tx, id) => callForTerminal(tx, f.actorFor(mine), id)],
      ['seat', (tx, id) => seatForTerminal(tx, f.actorFor(mine), { entryId: id, sessionId: 'S', standLabel: '1', joinUrl: 'https://x.test/j' })],
      ['remove', (tx, id) => removeForTerminal(tx, f.actorFor(mine), id)],
    ];
    for (const [name, move] of moves) {
      const asForeign = expectRefusal(await refusedIn(f.orgId, (tx) => move(tx, foreign)), 'LOBBY_NOT_FOUND', `${name} on another store's entry`);
      const asGhost = expectRefusal(await refusedIn(f.orgId, (tx) => move(tx, ghost)), 'LOBBY_NOT_FOUND', `${name} on a ghost id`);
      expect(asForeign.userMessage, `${name}: the sentence differs from a ghost's`).toBe(asGhost.userMessage);
    }
    expect(await entryOf(foreign)).toMatchObject({ status: 'waiting', session_ref: null, handoff_url: null });
    expect(await auditAll(theirs)).toBe(0);
    await rawEntry(mine, { source: 'staff' });
    const list = await asOrg(f.orgId, (tx) => listForTerminal(tx, f.actorFor(mine)));
    expect(list.entries.length).toBe(1);
    expect(list.entries.map((e) => e.entryId)).not.toContain(foreign);
  });
});

// ================================================================================================ C. list: stamp, switches, secrets

describe('C. list: stamps pos_seen_at, reports the switches, never returns secrets', () => {
  it('C1 list sets lobby_stores.pos_seen_at to now (from never, and from an hour ago) and returns lobbyEnabled / paused [kills: no stamp, stamp on the wrong store, switches not reported]', async () => {
    const f = await orgFixture('c1');
    const never = await f.mkStore({ posSeenMinutesAgo: null, paused: true });
    const stale = await f.mkStore({ posSeenMinutesAgo: 60 });
    const other = await f.mkStore({ posSeenMinutesAgo: 60 });
    const off = await f.mkStore({ enabled: false });
    const r1 = await asOrg(f.orgId, (tx) => listForTerminal(tx, f.actorFor(never)));
    const r2 = await asOrg(f.orgId, (tx) => listForTerminal(tx, f.actorFor(stale)));
    const r3 = await asOrg(f.orgId, (tx) => listForTerminal(tx, f.actorFor(off)));
    expect(r1).toMatchObject({ lobbyEnabled: true, paused: true });
    expect(r2).toMatchObject({ lobbyEnabled: true, paused: false });
    expect(r3).toMatchObject({ lobbyEnabled: false });
    const fresh = (d: Date | null | undefined) => d != null && Date.now() - d.getTime() < 60_000;
    expect(fresh((await lobbyStoreOf(never))!.pos_seen_at), 'never-seen store not stamped').toBe(true);
    expect(fresh((await lobbyStoreOf(stale))!.pos_seen_at), 'stale store not stamped').toBe(true);
    expect(fresh((await lobbyStoreOf(other))!.pos_seen_at), 'another store was stamped').toBe(false);
  });

  it('C2 a store with NO lobby_stores row: list still answers (empty switches, its walk-ins listed) and creates no row [kills: list fails or invents a row when the lobby was never set up]', async () => {
    const f = await orgFixture('c2');
    const s = await f.mkStore({ row: false });
    await rawEntry(s, { source: 'staff' });
    const r = await asOrg(f.orgId, (tx) => listForTerminal(tx, f.actorFor(s)));
    expect(r.lobbyEnabled).toBe(false);
    expect(r.paused).toBe(false);
    expect(r.entries.length).toBe(1);
    expect((await sql`select 1 from lobby_stores where store_id = ${s.storeId}`).length).toBe(0);
  });

  it('C3 list rows carry the staff fields, oldest first, live only; and NO hash, device or hand-off secret appears in the payload in any spelling [kills: handoff_url / device_hash / ip_hash returned, closed entries listed, wrong order]', async () => {
    const f = await orgFixture('c3');
    const s = await f.mkStore();
    const old = await rawEntry(s, { source: 'lobby', ageMin: 30 });
    const mid = await rawEntry(s, { source: 'staff', ageMin: 20 });
    const called = await rawEntry(s, { source: 'lobby', ageMin: 10, status: 'called' });
    await rawEntry(s, { source: 'lobby', ageMin: 8, status: 'removed', extra: { closed_at: ago(1) } });
    await rawEntry(s, { source: 'lobby', ageMin: 7, status: 'seated', extra: { session_ref: 'SESS-X', stand_label: '3', closed_at: ago(1), handoff_url: 'https://customer.shareat.net/join?token=LEAKME', handoff_expires_at: new Date(Date.now() + 3_600_000).toISOString() } });
    const r = await asOrg(f.orgId, (tx) => listForTerminal(tx, f.actorFor(s)));
    expect(r.entries.map((e) => e.entryId)).toEqual([old, mid, called]);
    expect(r.entries[1]).toMatchObject({ displayName: DINER_NAME, partySize: 3, status: 'waiting', source: 'staff', note: 'near the door', phone: DINER_PHONE, lines: [] });
    expect(r.entries[2]).toMatchObject({ status: 'called' });
    expect(r.entries[2]!.calledAt).toBeInstanceOf(Date);
    expect(r.entries[0]!.createdAt).toBeInstanceOf(Date);
    const dump = JSON.stringify(r);
    expect(dump).not.toMatch(/handoff|hand_off|device_?hash|ip_?hash|devhash|iphash|LEAKME/i);
  });
});

// ================================================================================================ D. pause / resume

describe('D. pause and resume', () => {
  it('D1 pause sets paused and writes lobby.pause; resume clears it and writes lobby.resume; both by the terminal person with after.cashier [kills: no flip, no audit, wrong action name, actor not the terminal, another store flipped]', async () => {
    const f = await orgFixture('d1');
    const s = await f.mkStore();
    const other = await f.mkStore();
    expect(await asOrg(f.orgId, (tx) => setLobbyPausedForTerminal(tx, f.actorFor(s), true))).toMatchObject({ paused: true });
    expect((await lobbyStoreOf(s))!.paused).toBe(true);
    expect((await lobbyStoreOf(other))!.paused).toBe(false);
    expect(await asOrg(f.orgId, (tx) => setLobbyPausedForTerminal(tx, f.actorFor(s), false))).toMatchObject({ paused: false });
    expect((await lobbyStoreOf(s))!.paused).toBe(false);
    const audit = await auditFor(s);
    expect(audit.map((a) => a.action)).toEqual(['lobby.pause', 'lobby.resume']);
    for (const a of audit) {
      expect(a.actor_person_id).toBe(f.terminalPersonId);
      expect(a.source).toBe('pos');
      expect((a.after as Record<string, unknown>).cashier).toBe(CASHIER);
    }
    expect(await auditAll(other)).toBe(0);
  });

  it('D2 pause or resume for a store with NO lobby_stores row is refused LOBBY_NOT_FOUND, creates no row and writes no audit [kills: silent success, a row invented by upsert]', async () => {
    const f = await orgFixture('d2');
    const s = await f.mkStore({ row: false });
    expectRefusal(await refusedIn(f.orgId, (tx) => setLobbyPausedForTerminal(tx, f.actorFor(s), true)), 'LOBBY_NOT_FOUND', 'pause without a row');
    expectRefusal(await refusedIn(f.orgId, (tx) => setLobbyPausedForTerminal(tx, f.actorFor(s), false)), 'LOBBY_NOT_FOUND', 'resume without a row');
    expect((await sql`select 1 from lobby_stores where store_id = ${s.storeId}`).length).toBe(0);
    expect(await auditAll(s)).toBe(0);
  });
});

// ================================================================================================ E. line -> POS key mapping

describe('E. the cashier\'s lines: variant -> posItemKey from the store\'s ACTIVE link; an unmapped line is kept as text', () => {
  it('E1 a linked variant carries its posItemKey and option ids; an unlinked one, one with only an INACTIVE link, and one linked only at ANOTHER store all come back with posItemKey null and a label naming the item - none is dropped [kills: silent drop of unmapped lines, inactive link used, another store\'s link used, label missing, options lost]', async () => {
    const f = await orgFixture('e1');
    const s = await f.mkStore();
    const elsewhere = await f.mkStore();
    const linked = await f.mkVariant('package');
    const unlinked = await f.mkVariant('a_la_carte');
    const inactive = await f.mkVariant('a_la_carte');
    const otherStoreOnly = await f.mkVariant('a_la_carte');
    await f.link(s.storeId, linked.variantId, 'PKG-PORK-CHICKEN');
    await f.link(s.storeId, inactive.variantId, 'OLD-KEY', 'inactive');
    await f.link(elsewhere.storeId, otherStoreOnly.variantId, 'ELSEWHERE-KEY');
    const entryId = await rawEntry(s, { source: 'lobby' });
    const addLine = async (variantId: string, qty: number, kind: 'package' | 'a_la_carte', withOption = false) => {
      const [l] = await sql<{ id: string }[]>`insert into lobby_entry_lines (org_id, entry_id, variant_id, qty, line_kind) values (${f.orgId}, ${entryId}, ${variantId}, ${qty}, ${kind}) returning id`;
      if (withOption) await sql`insert into lobby_entry_line_options (org_id, line_id, option_value_id) values (${f.orgId}, ${l!.id}, ${f.valueId})`;
    };
    await addLine(linked.variantId, 5, 'package', true);
    await addLine(unlinked.variantId, 2, 'a_la_carte');
    await addLine(inactive.variantId, 1, 'a_la_carte');
    await addLine(otherStoreOnly.variantId, 3, 'a_la_carte');
    const r = await asOrg(f.orgId, (tx) => listForTerminal(tx, f.actorFor(s)));
    const lines = r.entries.find((e) => e.entryId === entryId)!.lines;
    expect(lines.length, 'a line was dropped').toBe(4);
    const by = (variantId: string) => lines.find((l) => l.variantId === variantId)!;
    expect(by(linked.variantId)).toMatchObject({ lineKind: 'package', qty: 5, posItemKey: 'PKG-PORK-CHICKEN', optionValueIds: [f.valueId] });
    expect(by(linked.variantId).label).toContain(linked.itemName);
    for (const [name, v, qty] of [['unlinked', unlinked, 2], ['inactive link', inactive, 1], ['other store link', otherStoreOnly, 3]] as const) {
      const line = by(v.variantId);
      expect(line, `${name}: line missing`).toBeDefined();
      expect(line.posItemKey, `${name}: must be null`).toBeNull();
      expect(line.qty).toBe(qty);
      expect(line.label, `${name}: label must name the item so the cashier can tap it in by hand`).toContain(v.itemName);
      expect(line.optionValueIds).toEqual([]);
    }
  });
});

// ================================================================================================ F. one shared core, no authorize()

describe('F. staff.ts keeps working and terminal.ts shares its core', () => {
  it('F1 staff.ts still exports its six moves with the same names, and terminal.ts never calls authorize() (the trust chain is the route\'s terminal link) [kills: terminal moves demanding a capability, staff moves renamed or removed]', async () => {
    const staff = await import('../../src/lobby/staff');
    for (const name of ['parkWalkIn', 'listLobbyEntries', 'callEntry', 'seatEntry', 'removeEntry']) {
      expect(typeof (staff as Record<string, unknown>)[name], `staff.ts lost ${name}`).toBe('function');
    }
    const src = readFileSync(new URL('../../src/lobby/terminal.ts', import.meta.url), 'utf8');
    const staffSrc = readFileSync(new URL('../../src/lobby/staff.ts', import.meta.url), 'utf8');
    expect(/\bauthorize\s*\(/.test(src), 'terminal.ts must not call authorize()').toBe(false);
    expect((src.match(/lobbyRepo\.markCalled\s*\(/g) ?? []).length + (staffSrc.match(/lobbyRepo\.markCalled\s*\(/g) ?? []).length, 'the call move must exist once (shared core), not twice').toBeLessThanOrEqual(1);
  });
});
