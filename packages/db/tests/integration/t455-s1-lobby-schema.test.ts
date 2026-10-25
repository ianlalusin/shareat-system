/**
 * T-455 S1 -- customer lobby tables, migration 0215 (docs/tasks/455-customer-lobby.md section 2, "Ian's answers 2026-10-24").
 * TESTER file: it asserts what the spec says the DATABASE enforces and writes NO production code. Real Postgres via
 * TEST_DATABASE_URL (`_test` name guard). Every behaviour leg runs as shareat_app inside a ROLLED-BACK transaction.
 *
 * RED TODAY, for one reason: 0215 does not exist, so the five lobby_* tables are absent. Every refusal leg asserts an
 * EXACT SQLSTATE (or "any refusal that is not 42P01/42703", for triggers whose code the spec does not fix), so a missing
 * table can never be mistaken for a refusal.
 *
 * ASSUMPTIONS the builder must meet (spec silent or inconsistent -> flagged in the tester report):
 *  - all five tables carry their own org_id (the section 2.2 heading says so; children list FK (org_id, entry_id)), so their RLS scope is
 *    'org_column', not 'derived' + `via`. Columns are named exactly as in the section 2.2 table; every table has id uuid (uuidv7 default).
 *  - lobby_stores: PK (org_id, store_id). The other four: UNIQUE (org_id, id).
 *  - purge (section 4.7) sets display_name/phone/note/device_hash/ip_hash/handoff_url to NULL on TERMINAL entries; so "terminal states never
 *    change" and "device_hash frozen" must still allow NULLing those columns (only STATUS is frozen on a terminal row; device_hash may go to NULL, never to another value).
 *  - lobby_entries 'seated' needs session_ref and stand_label non-null (a CHECK, so it holds on INSERT too).
 *
 * MUTANTS (each leg names the one it kills):
 *  plain FK instead of composite (org_id, x)           -> F1..F9, C1 (catalog)
 *  missing forward-only trigger / terminal not frozen   -> T1..T5, B2, K3
 *  full UNIQUE instead of partial (store, code/device)  -> U2, U3, U4
 *  partial UNIQUE that forgets status 'called'          -> U1b
 *  code CHECK missing or too loose                      -> E1
 *  party-size CHECK off by one                          -> E2
 *  phone allowed on a lobby entry                       -> E3
 *  claim keeps name/ID after leaving pending            -> K1, K2
 *  claim count not capped at party_size                 -> K4
 *  party shrunk below its live claims (DEF-774, T-479)  -> K5a..K5f
 *  a photo/bytea/price column                           -> P1, P2
 *  RLS missing / USING-only / FORCE missing             -> R1, R2, R3
 *  registry or classification entry missing             -> G1, G2
 *  0215 without lock_timeout first / budget header      -> L1
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { menuFixture, newOption, sql, uid, asApp, type PgErr, type MenuFx } from './_fixtures/t401-menu';
import { CROSS_ORG_BY_DESIGN, OPEN_DEF_491, ORG_LESS_TABLES } from '../../src/rls/same-org-fk-exemptions';
import { APP_ROLE, RLS_REGISTRY } from '../../src/rls/registry';
import { CUTOVER_CLASSIFICATION } from '../../src/cutover/classification';
import { TRIGGER_REGISTRY } from '../../src/triggers/registry';
import { MIGRATIONS_FOLDER } from './t398-s3-fixture';

config({ path: '.env.local' });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const LOBBY = ['lobby_stores', 'lobby_entries', 'lobby_entry_lines', 'lobby_entry_line_options', 'lobby_birthday_requests', 'lobby_discount_claims'] as const;
type Tx = postgres.TransactionSql;
const asSql = (q: Tx | postgres.Sql) => q as unknown as postgres.Sql;

// ------------------------------------------------------------------------------------------------ helpers

let codeSeq = Math.floor(Math.random() * 4000);
/** A valid, never-repeating 4-digit booking code (1000-9999) for this process. */
const nextCode = () => String(1000 + (codeSeq++ % 9000));

type Row = Record<string, string | number | boolean | null>;
async function ins(q: Tx | postgres.Sql, table: string, row: Row): Promise<string> {
  const s = asSql(q);
  const [r] = await s<{ id: string }[]>`insert into ${s(table)} ${s(row)} returning id`;
  return r!.id;
}
const entryRow = (f: { orgId: string; storeId: string }, o: Row = {}): Row => ({
  org_id: f.orgId,
  store_id: f.storeId,
  source: 'lobby',
  code: nextCode(),
  display_name: 'Ana',
  party_size: 3,
  status: 'waiting',
  device_hash: uid('dev'),
  ip_hash: 'iphash',
  client_request_id: uid('req'),
  ...o,
});
const seatedRow = (f: { orgId: string; storeId: string }, o: Row = {}): Row => entryRow(f, { status: 'seated', session_ref: 'S-1', stand_label: '7', ...o });
const insEntry = (q: Tx | postgres.Sql, f: { orgId: string; storeId: string }, o: Row = {}) => ins(q, 'lobby_entries', entryRow(f, o));
const claimRow = (f: { orgId: string }, entryId: string, o: Row = {}): Row => ({
  org_id: f.orgId,
  entry_id: entryId,
  kind: 'senior',
  holder_name: 'Ana Reyes',
  id_number: '1234-5678',
  id_last4: '5678',
  ocr_assisted: false,
  status: 'pending',
  ...o,
});
const birthdayRow = (f: { orgId: string }, entryId: string, o: Row = {}): Row => ({
  org_id: f.orgId,
  entry_id: entryId,
  celebrant_name: 'Ben',
  status: 'requested',
  ...o,
});
const lineRow = (f: { orgId: string; variantId: string }, entryId: string, o: Row = {}): Row => ({
  org_id: f.orgId,
  entry_id: entryId,
  variant_id: f.variantId,
  qty: 1,
  line_kind: 'a_la_carte',
  ...o,
});

/** Run fn inside the current transaction in a savepoint; resolves to the error it raised, or undefined if accepted. */
async function probe(tx: Tx, fn: (sp: Tx) => PromiseLike<unknown>): Promise<PgErr | undefined> {
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp as unknown as Tx);
    });
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}

/** Not a refusal: a missing table / column / function must never count as "the database refused it". */
const BROKEN = ['42P01', '42703', '42883', '42704'];
function expectRefused(err: PgErr | undefined, why: string, code?: string) {
  expect(err, `${why}: the statement was ACCEPTED`).toBeDefined();
  expect(BROKEN, `${why}: raised ${err?.code} ${err?.message} - the table/column is missing, that is not a refusal`).not.toContain(err?.code);
  if (code) expect(err?.code, `${why}: wrong SQLSTATE (${err?.message})`).toBe(code);
}

const fx: Record<string, MenuFx> = {};
async function fixture(name: string): Promise<MenuFx> {
  return (fx[name] ??= await menuFixture(`t455${name}`));
}

describe('S0 -- RED while 0215 is not applied: all five lobby tables exist', () => {
  it('lobby_stores, lobby_entries, lobby_entry_lines, lobby_birthday_requests, lobby_discount_claims are in public', async () => {
    const rows = await sql<{ relname: string }[]>`
      select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(${LOBBY as unknown as string[]})`;
    expect(rows.map((r) => r.relname).sort(), 'RED today: migration 0215 is not applied').toEqual([...LOBBY].sort());
  });
});

// ================================================================================================ shapes (catalog)

const COLUMNS: Record<(typeof LOBBY)[number], string[]> = {
  lobby_stores: ['org_id', 'store_id', 'enabled', 'paused', 'max_live_entries', 'birthday_enabled', 'claims_enabled', 'pos_seen_at'],
  lobby_entries: [
    'id', 'org_id', 'store_id', 'source', 'code', 'display_name', 'party_size', 'note', 'phone', 'status', 'device_hash', 'ip_hash',
    'client_request_id', 'session_ref', 'stand_label', 'handoff_url', 'handoff_expires_at', 'called_at', 'seated_at', 'closed_at', 'acted_by_person_id',
  ],
  lobby_entry_lines: ['id', 'org_id', 'entry_id', 'variant_id', 'qty', 'line_kind'],
  lobby_entry_line_options: ['id', 'org_id', 'line_id', 'option_value_id'],
  lobby_birthday_requests: ['id', 'org_id', 'entry_id', 'celebrant_name', 'status', 'scheduled_at', 'decline_reason', 'played_at', 'acted_by_person_id'],
  lobby_discount_claims: [
    'id', 'org_id', 'entry_id', 'kind', 'holder_name', 'id_number', 'id_last4', 'ocr_assisted', 'status', 'session_ref', 'statutory_diner_ref',
    'reject_reason', 'acted_by_person_id', 'card_seen_at',
  ],
};

async function columnsOf(table: string) {
  return sql<{ column_name: string; udt_name: string; data_type: string; is_nullable: string }[]>`
    select column_name, udt_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = ${table}`;
}

describe('C -- shapes and same-org keys, read from the catalog', () => {
  it.each(LOBBY)('C0 %s has every column section 2.2 names, and org_id is NOT NULL', async (t) => {
    const cols = await columnsOf(t);
    const names = cols.map((c) => c.column_name);
    for (const want of COLUMNS[t]) expect(names, `${t}.${want} missing`).toContain(want);
    expect(cols.find((c) => c.column_name === 'org_id')?.is_nullable, `${t}.org_id must be NOT NULL`).toBe('NO');
  });

  it('C0b party_size/qty are integers, times are timestamptz', async () => {
    const byName = async (t: string) => Object.fromEntries((await columnsOf(t)).map((c) => [c.column_name, c.udt_name]));
    const lines = await byName('lobby_entry_lines');
    const entries = await byName('lobby_entries');
    expect(Object.keys(lines), 'the uuid[] column is replaced by lobby_entry_line_options').not.toContain('option_value_ids');
    expect(lines.qty).toBe('int4');
    expect(entries.party_size).toBe('int4');
    for (const c of ['called_at', 'seated_at', 'closed_at', 'handoff_expires_at']) expect(entries[c], c).toBe('timestamptz');
    expect((await byName('lobby_stores')).pos_seen_at).toBe('timestamptz');
  });

  it('C0c keys: lobby_stores PK is (org_id, store_id); the four others have UNIQUE (org_id, id) (the target of children composite FKs)', async () => {
    const pk = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) def from pg_constraint where conrelid = to_regclass('public.lobby_stores') and contype = 'p'`;
    expect(pk.map((r) => r.def), 'RED today: no table').toEqual(['PRIMARY KEY (org_id, store_id)']);
    for (const t of LOBBY.filter((x) => x !== 'lobby_stores')) {
      const u = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) def from pg_constraint where conrelid = to_regclass(${'public.' + t}) and contype in ('u','p')`;
      expect(u.some((r) => /\(org_id, id\)/.test(r.def)), `${t}: no UNIQUE (org_id, id); saw ${JSON.stringify(u)}`).toBe(true);
    }
  });

  const FKS = [
    ['lobby_stores', 'store_id', 'stores'],
    ['lobby_entries', 'store_id', 'stores'],
    ['lobby_entries', 'acted_by_person_id', 'persons'],
    ['lobby_entry_lines', 'entry_id', 'lobby_entries'],
    ['lobby_entry_lines', 'variant_id', 'menu_item_variants'],
    ['lobby_entry_line_options', 'line_id', 'lobby_entry_lines'],
    ['lobby_entry_line_options', 'option_value_id', 'menu_option_values'],
    ['lobby_birthday_requests', 'entry_id', 'lobby_entries'],
    ['lobby_birthday_requests', 'acted_by_person_id', 'persons'],
    ['lobby_discount_claims', 'entry_id', 'lobby_entries'],
    ['lobby_discount_claims', 'acted_by_person_id', 'persons'],
  ] as const;

  it.each(FKS)('C1 %s.%s -> %s has a composite (org_id, col) -> parent (org_id, id) FK (kills a plain FK)', async (child, col, parent) => {
    const rows = await sql<{ cols: string[]; pcols: string[] }[]>`
      select array(select attname from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by o) cols,
             array(select attname from unnest(c.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by o) pcols
      from pg_constraint c where c.contype = 'f' and c.conrelid = to_regclass(${'public.' + child}) and c.confrelid = to_regclass(${'public.' + parent})`;
    expect(rows.some((r) => r.cols.join() === `org_id,${col}` && r.pcols.join() === 'org_id,id'), `${child}.${col}: saw ${JSON.stringify(rows)}`).toBe(true);
  });

  it('C2 census (same rule as t398-s1): every FK out of a lobby table is either org_id -> organizations or a composite (org_id, x) -> parent (org_id, id); none is plain', async () => {
    const rows = await sql<{ child: string; def: string; n: number; parent: string }[]>`
      select c.conrelid::regclass::text child, pg_get_constraintdef(c.oid) def, cardinality(c.conkey) n, c.confrelid::regclass::text parent
      from pg_constraint c where c.contype = 'f' and c.conrelid = any(array(select to_regclass('public.' || t) from unnest(${LOBBY as unknown as string[]}::text[]) t where to_regclass('public.' || t) is not null))`;
    expect(rows.length, 'RED today: no lobby FKs at all').toBeGreaterThanOrEqual(10);
    const bad = rows.filter((r) => !(r.parent === 'organizations' || (r.n === 2 && /^FOREIGN KEY \(org_id, \w+\) REFERENCES \w+\(org_id, id\)/.test(r.def))));
    expect(bad, `plain (single-column) FKs to org-bearing tables: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it('C3 the ratchet did not grow: OPEN_DEF_491 and CROSS_ORG_BY_DESIGN stay empty, no lobby table is exempted as org-less', () => {
    expect(OPEN_DEF_491.length, 'a new gap must be fixed, not listed').toBe(0);
    expect(CROSS_ORG_BY_DESIGN.length).toBe(0);
    for (const t of LOBBY) expect(ORG_LESS_TABLES).not.toContain(t);
  });

  it('C4 triggers exist on entries, birthday requests and claims (forward-only), and every lobby trigger is classified in TRIGGER_REGISTRY against its own table', async () => {
    const trg = await sql<{ tgname: string; tbl: string }[]>`
      select t.tgname, c.relname tbl from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname = any(${LOBBY as unknown as string[]})`;
    for (const t of ['lobby_entries', 'lobby_birthday_requests', 'lobby_discount_claims']) {
      expect(trg.some((r) => r.tbl === t), `${t}: no forward-only trigger (mutant: missing trigger)`).toBe(true);
    }
    for (const r of trg) {
      expect(TRIGGER_REGISTRY[r.tgname]?.table, `trigger ${r.tgname} on ${r.tbl} is not in triggers/registry.ts`).toBe(r.tbl);
    }
  });
});

// ================================================================================================ no photo, no price

describe('P -- row 353 / Ian 24 Oct: no card photo is kept; the phone never prices', () => {
  it.each(LOBBY)('P1 %s: no bytea column, no column named like a photo/image/scan/file/blob/ocr text', async (t) => {
    const cols = await columnsOf(t);
    expect(cols.length, 'RED today: no table').toBeGreaterThan(0);
    expect(cols.filter((c) => c.udt_name === 'bytea').map((c) => c.column_name), 'a binary column could hold a photo').toEqual([]);
    const sus = cols.map((c) => c.column_name).filter((n) => /photo|image|picture|scan|file|blob|ocr_text|raw_text|snapshot/i.test(n));
    expect(sus, 'mutant: a photo/scan column').toEqual([]);
  });

  it('P2 lobby_discount_claims holds ONLY the fields row 353 allows (+ id, org, bookkeeping timestamps); lobby_entry_lines has no money column', async () => {
    const allowed = new Set([...COLUMNS.lobby_discount_claims, 'created_at', 'updated_at', 'requested_at', 'decided_at', 'expires_at']);
    const cols = (await columnsOf('lobby_discount_claims')).map((c) => c.column_name);
    expect(cols.length, 'RED today: no table').toBeGreaterThan(0);
    expect(cols.filter((c) => !allowed.has(c)), 'mutant: an extra column on the claim (photo, full-text, etc.)').toEqual([]);
    const lines = (await columnsOf('lobby_entry_lines')).map((c) => c.column_name);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((n) => /price|amount|cost|total|peso|money|subtotal/i.test(n)), 'the phone never prices').toEqual([]);
  });
});

// ================================================================================================ lobby_stores

describe('S -- lobby_stores', () => {
  it('S1 max_live_entries defaults to 60; (org_id, store_id) is the key (a second row for the store is refused 23505)', async () => {
    const a = await fixture('s1');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      await tx`insert into lobby_stores (org_id, store_id, enabled, paused, birthday_enabled, claims_enabled) values (${a.orgId}, ${a.storeId}, true, false, true, true)`;
      const [r] = await tx<{ max_live_entries: number }[]>`select max_live_entries from lobby_stores where store_id = ${a.storeId}`;
      const dup = await probe(tx, (sp) => sp`insert into lobby_stores (org_id, store_id, enabled, paused, birthday_enabled, claims_enabled) values (${a.orgId}, ${a.storeId}, true, false, true, true)`);
      return { max: r?.max_live_entries, dup };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value?.max, 'default 60 (spec 2.2)').toBe(60);
    expectRefused(value?.dup, 'S1 second lobby_stores row for one store (kills a missing PK)', '23505');
  });
});

// ================================================================================================ lobby_entries: checks

describe('E -- lobby_entries CHECKs', () => {
  it('E1 code must match ^[1-9][0-9]{3}$: 1000 and 9999 accepted; 0999, 999, 10000, abcd, 12a4 refused 23514', async () => {
    const a = await fixture('e1');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const good: (PgErr | undefined)[] = [];
      for (const c of ['1000', '9999']) good.push(await probe(tx, (sp) => insEntry(sp, a, { code: c })));
      const bad: Record<string, PgErr | undefined> = {};
      for (const c of ['0999', '999', '10000', 'abcd', '12a4', '']) bad[c] = await probe(tx, (sp) => insEntry(sp, a, { code: c }));
      return { good, bad };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    value!.good.forEach((g, i) => expect(g, `valid code #${i} refused: ${g?.message}`).toBeUndefined());
    for (const [c, e] of Object.entries(value!.bad)) expectRefused(e, `E1 code "${c}" (mutant: CHECK missing or too loose)`, '23514');
  });

  it('E2 party_size 1 and 30 accepted; 0, 31, -1 refused 23514 (off-by-one mutants)', async () => {
    const a = await fixture('e2');
    const { value, err } = await asApp(a.orgId, async (tx) => ({
      ok1: await probe(tx, (sp) => insEntry(sp, a, { party_size: 1 })),
      ok30: await probe(tx, (sp) => insEntry(sp, a, { party_size: 30 })),
      b0: await probe(tx, (sp) => insEntry(sp, a, { party_size: 0 })),
      b31: await probe(tx, (sp) => insEntry(sp, a, { party_size: 31 })),
      bm: await probe(tx, (sp) => insEntry(sp, a, { party_size: -1 })),
    }));
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.ok1?.message).toBeUndefined();
    expect(value!.ok30?.message).toBeUndefined();
    expectRefused(value!.b0, 'party 0', '23514');
    expectRefused(value!.b31, 'party 31', '23514');
    expectRefused(value!.bm, 'party -1', '23514');
  });

  it('E2b display_name length 1..40: 40 chars accepted; 41 and "" refused 23514', async () => {
    const a = await fixture('e2b');
    const { value, err } = await asApp(a.orgId, async (tx) => ({
      ok: await probe(tx, (sp) => insEntry(sp, a, { display_name: 'x'.repeat(40) })),
      b41: await probe(tx, (sp) => insEntry(sp, a, { display_name: 'x'.repeat(41) })),
      b0: await probe(tx, (sp) => insEntry(sp, a, { display_name: '' })),
    }));
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.ok?.message).toBeUndefined();
    expectRefused(value!.b41, 'name 41 chars', '23514');
    expectRefused(value!.b0, 'empty name', '23514');
  });

  it('E3 phone is NULL unless source = staff: a lobby entry with a phone is refused 23514; a staff entry with one is accepted', async () => {
    const a = await fixture('e3');
    const { value, err } = await asApp(a.orgId, async (tx) => ({
      lobbyPhone: await probe(tx, (sp) => insEntry(sp, a, { source: 'lobby', phone: '09171234567' })),
      staffPhone: await probe(tx, (sp) => insEntry(sp, a, { source: 'staff', phone: '09171234567', device_hash: null, ip_hash: null })),
      staffNone: await probe(tx, (sp) => insEntry(sp, a, { source: 'staff', device_hash: null, ip_hash: null })),
    }));
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.lobbyPhone, 'phone on a lobby entry (mutant: no phone CHECK)', '23514');
    expect(value!.staffPhone?.message, 'staff-parked phone must be allowed').toBeUndefined();
    expect(value!.staffNone?.message).toBeUndefined();
  });

  it('E4 source and status are closed sets: source "other" and status "bogus" refused 23514; every legal status is accepted at insert (seated with session + stand)', async () => {
    const a = await fixture('e4');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const legal: Record<string, PgErr | undefined> = {};
      for (const s of ['waiting', 'called', 'cancelled', 'removed', 'expired']) legal[s] = await probe(tx, (sp) => insEntry(sp, a, { status: s }));
      legal.seated = await probe(tx, (sp) => ins(sp, 'lobby_entries', seatedRow(a)));
      return {
        legal,
        src: await probe(tx, (sp) => insEntry(sp, a, { source: 'other' })),
        st: await probe(tx, (sp) => insEntry(sp, a, { status: 'bogus' })),
        seatNoSession: await probe(tx, (sp) => insEntry(sp, a, { status: 'seated', stand_label: '7' })),
        seatNoStand: await probe(tx, (sp) => insEntry(sp, a, { status: 'seated', session_ref: 'S-1' })),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    for (const [s, e] of Object.entries(value!.legal)) expect(e?.message, `legal status ${s} refused`).toBeUndefined();
    expectRefused(value!.src, 'source other', '23514');
    expectRefused(value!.st, 'status bogus', '23514');
    expectRefused(value!.seatNoSession, 'seated without session_ref (spec 2.4)', '23514');
    expectRefused(value!.seatNoStand, 'seated without stand_label (spec 2.4)', '23514');
  });
});

// ================================================================================================ lobby_entries: uniqueness

describe('U -- booking code and device uniqueness are PARTIAL (live entries only)', () => {
  it('U1 two LIVE entries with the same code at one store: refused 23505 (waiting/waiting)', async () => {
    const a = await fixture('u1');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      await insEntry(tx, a, { code: '4821' });
      return probe(tx, (sp) => insEntry(sp, a, { code: '4821' }));
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value, 'U1 duplicate live code (mutant: no unique)', '23505');
  });

  it('U1b a CALLED entry still holds its code (mutant: partial index WHERE status = waiting only)', async () => {
    const a = await fixture('u1b');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      await insEntry(tx, a, { code: '4822', status: 'called' });
      return probe(tx, (sp) => insEntry(sp, a, { code: '4822', status: 'waiting' }));
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value, 'U1b called + waiting same code', '23505');
  });

  it.each(['cancelled', 'removed', 'expired'])('U2 a %s entry frees its code: a new live entry with the same code is accepted (mutant: full UNIQUE instead of partial)', async (closed) => {
    const a = await fixture('u2');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const id = await insEntry(tx, a, { code: '4823' });
      await tx`update lobby_entries set status = ${closed} where id = ${id}`;
      return probe(tx, (sp) => insEntry(sp, a, { code: '4823' }));
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value?.message, `a ${closed} entry must free its code`).toBeUndefined();
  });

  it('U2b a SEATED entry also frees its code', async () => {
    const a = await fixture('u2b');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      await ins(tx, 'lobby_entries', seatedRow(a, { code: '4824' }));
      return probe(tx, (sp) => insEntry(sp, a, { code: '4824' }));
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value?.message, 'seated is closed for code purposes').toBeUndefined();
  });

  it('U3 the same code at ANOTHER store of the org is fine (mutant: unique on code alone)', async () => {
    const a = await fixture('u3');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      await insEntry(tx, a, { code: '4825' });
      return probe(tx, (sp) => insEntry(sp, { orgId: a.orgId, storeId: a.store2Id }, { code: '4825' }));
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value?.message).toBeUndefined();
  });

  it('U4 one live entry per device per store: same device_hash refused 23505 while live; accepted once the first is closed; accepted at another store; many staff entries with NULL device_hash are fine', async () => {
    const a = await fixture('u4');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const first = await insEntry(tx, a, { device_hash: 'dev-same' });
      const sameLive = await probe(tx, (sp) => insEntry(sp, a, { device_hash: 'dev-same' }));
      const otherStore = await probe(tx, (sp) => insEntry(sp, { orgId: a.orgId, storeId: a.store2Id }, { device_hash: 'dev-same' }));
      const staff1 = await probe(tx, (sp) => insEntry(sp, a, { source: 'staff', device_hash: null, ip_hash: null }));
      const staff2 = await probe(tx, (sp) => insEntry(sp, a, { source: 'staff', device_hash: null, ip_hash: null }));
      await tx`update lobby_entries set status = 'cancelled' where id = ${first}`;
      const afterClose = await probe(tx, (sp) => insEntry(sp, a, { device_hash: 'dev-same' }));
      return { sameLive, otherStore, staff1, staff2, afterClose };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.sameLive, 'U4 same device live twice', '23505');
    expect(value!.otherStore?.message, 'other store').toBeUndefined();
    expect(value!.staff1?.message).toBeUndefined();
    expect(value!.staff2?.message, 'NULL device_hash must not collide').toBeUndefined();
    expect(value!.afterClose?.message, 'closed frees the device (mutant: full UNIQUE)').toBeUndefined();
  });

  it('U5 (store_id, client_request_id) is unique: a retried check-in with the same request id is refused 23505; the same id at another store is fine', async () => {
    const a = await fixture('u5');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      await insEntry(tx, a, { client_request_id: 'req-1' });
      return {
        dup: await probe(tx, (sp) => insEntry(sp, a, { client_request_id: 'req-1' })),
        other: await probe(tx, (sp) => insEntry(sp, { orgId: a.orgId, storeId: a.store2Id }, { client_request_id: 'req-1' })),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.dup, 'U5 duplicate client_request_id (idempotency key)', '23505');
    expect(value!.other?.message).toBeUndefined();
  });
});

// ================================================================================================ forward-only entry

describe('T -- lobby_entries state machine (section 2.4): forward-only, terminal frozen, key columns frozen', () => {
  const upd = (tx: Tx, id: string, set: Row) => asSql(tx)`update lobby_entries set ${asSql(tx)(set)} where id = ${id}`;

  it('T0 the legal path works: waiting -> called -> seated (with session + stand); waiting -> removed; waiting -> expired; called -> cancelled', async () => {
    const a = await fixture('t0');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await insEntry(tx, a);
      const toCalled = await probe(tx, (sp) => upd(sp, e, { status: 'called', called_at: new Date().toISOString() }));
      const toSeated = await probe(tx, (sp) => upd(sp, e, { status: 'seated', session_ref: 'S-9', stand_label: '4', seated_at: new Date().toISOString() }));
      const w1 = await insEntry(tx, a);
      const removed = await probe(tx, (sp) => upd(sp, w1, { status: 'removed' }));
      const w2 = await insEntry(tx, a);
      const expired = await probe(tx, (sp) => upd(sp, w2, { status: 'expired' }));
      const c = await insEntry(tx, a, { status: 'called' });
      const cancelled = await probe(tx, (sp) => upd(sp, c, { status: 'cancelled' }));
      const w3 = await insEntry(tx, a);
      const waitingToSeated = await probe(tx, (sp) => upd(sp, w3, { status: 'seated', session_ref: 'S-8', stand_label: '3' }));
      return { toCalled, toSeated, removed, expired, cancelled, waitingToSeated };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    for (const [k, v] of Object.entries(value!)) {
      if (k === 'waitingToSeated') continue; // spec 2.4 lists waiting -> called -> seated; a direct seat is a spec question (reported)
      expect(v?.message, `legal move ${k} refused (mutant: trigger too strict)`).toBeUndefined();
    }
  });

  it('T1 BACKWARD moves are refused: called -> waiting, seated -> called, seated -> waiting (kills a missing forward-only trigger)', async () => {
    const a = await fixture('t1');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const c = await insEntry(tx, a, { status: 'called' });
      const s = await ins(tx, 'lobby_entries', seatedRow(a));
      const s2 = await ins(tx, 'lobby_entries', seatedRow(a));
      return {
        calledToWaiting: await probe(tx, (sp) => upd(sp, c, { status: 'waiting' })),
        seatedToCalled: await probe(tx, (sp) => upd(sp, s, { status: 'called' })),
        seatedToWaiting: await probe(tx, (sp) => upd(sp, s2, { status: 'waiting' })),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    for (const [k, v] of Object.entries(value!)) expectRefused(v, `T1 ${k}`);
  });

  it.each(['cancelled', 'removed', 'expired'])('T2 terminal %s never changes: back to waiting/called refused; to another terminal state refused', async (term) => {
    const a = await fixture('t2');
    const others = ['cancelled', 'removed', 'expired'].filter((x) => x !== term);
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await insEntry(tx, a, { status: term });
      const out: Record<string, PgErr | undefined> = {
        waiting: await probe(tx, (sp) => upd(sp, e, { status: 'waiting' })),
        called: await probe(tx, (sp) => upd(sp, e, { status: 'called' })),
      };
      for (const o of others) out[o] = await probe(tx, (sp) => upd(sp, e, { status: o }));
      return out;
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    for (const [k, v] of Object.entries(value!)) expectRefused(v, `T2 ${term} -> ${k} (mutant: terminal not frozen)`);
  });

  it('T3 seated is terminal too: seated -> cancelled/removed/expired refused (spec: cancelled is waiting|called only)', async () => {
    const a = await fixture('t3');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const out: Record<string, PgErr | undefined> = {};
      for (const to of ['cancelled', 'removed', 'expired']) {
        const s = await ins(tx, 'lobby_entries', seatedRow(a));
        out[to] = await probe(tx, (sp) => upd(sp, s, { status: to }));
      }
      return out;
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    for (const [k, v] of Object.entries(value!)) expectRefused(v, `T3 seated -> ${k}`);
  });

  it('T4 key columns are frozen: code, store_id, source, device_hash cannot change on a live entry', async () => {
    const a = await fixture('t4');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await insEntry(tx, a, { source: 'lobby', device_hash: 'dev-frozen' });
      return {
        code: await probe(tx, (sp) => upd(sp, e, { code: nextCode() })),
        store: await probe(tx, (sp) => upd(sp, e, { store_id: a.store2Id })),
        source: await probe(tx, (sp) => upd(sp, e, { source: 'staff', device_hash: null, ip_hash: null })),
        device: await probe(tx, (sp) => upd(sp, e, { device_hash: 'dev-other' })),
        ok: await probe(tx, (sp) => upd(sp, e, { note: 'no onions', party_size: 4 })),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.code, 'T4 code frozen (a code is a counter label, never re-keyed)');
    expectRefused(value!.store, 'T4 store_id frozen');
    expectRefused(value!.source, 'T4 source frozen');
    expectRefused(value!.device, 'T4 device_hash frozen to another value');
    expect(value!.ok?.message, 'non-key columns stay editable').toBeUndefined();
  });

  it('T5 retention (section 4.7): on a TERMINAL entry display_name, phone, note, device_hash, ip_hash, handoff_url may be set to NULL (the purge), but the status stays frozen', async () => {
    const a = await fixture('t5');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await insEntry(tx, a, { status: 'cancelled', note: 'secret note', handoff_url: 'https://x/y', handoff_expires_at: new Date(Date.now() + 7_200_000).toISOString() });
      const purge = await probe(tx, (sp) => upd(sp, e, { display_name: null, phone: null, note: null, device_hash: null, ip_hash: null, handoff_url: null, handoff_expires_at: null }));
      const still = await probe(tx, (sp) => upd(sp, e, { status: 'waiting' }));
      const [row] = await tx<{ display_name: string | null; closed_status: string }[]>`select display_name, status closed_status from lobby_entries where id = ${e}`;
      return { purge, still, row };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.purge?.message, 'the nightly purge must be able to NULL these on a closed entry (spec 4.7 vs 2.4 reconcile)').toBeUndefined();
    expect(value!.row?.display_name).toBeNull();
    expectRefused(value!.still, 'T5 status frozen after purge');
  });

  it('T5b handoff_url and handoff_expires_at are both set or both NULL: one without the other is refused 23514 (insert and update); both together, or neither, accepted', async () => {
    const a = await fixture('t5b');
    const exp = new Date(Date.now() + 7_200_000).toISOString();
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await insEntry(tx, a);
      return {
        insUrlOnly: await probe(tx, (sp) => insEntry(sp, a, { handoff_url: 'https://x/y' })),
        insExpOnly: await probe(tx, (sp) => insEntry(sp, a, { handoff_expires_at: exp })),
        updUrlOnly: await probe(tx, (sp) => upd(sp, e, { handoff_url: 'https://x/y' })),
        updExpOnly: await probe(tx, (sp) => upd(sp, e, { handoff_expires_at: exp })),
        both: await probe(tx, (sp) => upd(sp, e, { handoff_url: 'https://x/y', handoff_expires_at: exp })),
        clearUrlOnly: await probe(tx, (sp) => upd(sp, e, { handoff_url: null })),
        insBoth: await probe(tx, (sp) => insEntry(sp, a, { handoff_url: 'https://x/z', handoff_expires_at: exp })),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    for (const k of ['insUrlOnly', 'insExpOnly', 'updUrlOnly', 'updExpOnly', 'clearUrlOnly'] as const) expectRefused(value![k], `T5b ${k} (mutant: pair CHECK missing)`, '23514');
    expect(value!.both?.message, 'both together is legal').toBeUndefined();
    expect(value!.insBoth?.message).toBeUndefined();
  });

  it('T6 the three forward-only triggers are ENABLE ALWAYS: under session_replication_role = replica a terminal entry, a terminal birthday request and a terminal claim stay frozen (mutant: trigger left origin)', async () => {
    const a = await fixture('t6');
    const trg = await sql<{ tgname: string; tbl: string; tgenabled: string }[]>`
      select t.tgname, c.relname tbl, t.tgenabled::text tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname in ('lobby_entries', 'lobby_birthday_requests', 'lobby_discount_claims') and t.tgname like '%forward%'`;
    for (const t of ['lobby_entries', 'lobby_birthday_requests', 'lobby_discount_claims']) {
      expect(trg.filter((r) => r.tbl === t).length, `${t}: RED today, no trigger whose name contains 'forward'`).toBeGreaterThan(0);
    }
    expect(trg.filter((r) => r.tgenabled !== 'A').map((r) => `${r.tbl}.${r.tgname}=${r.tgenabled}`), 'every forward-only trigger is ENABLE ALWAYS (history_guard)').toEqual([]);
    // superuser connection in replica mode: only ALWAYS triggers still fire; the transaction is rolled back.
    let out: Record<string, PgErr | undefined> = {};
    class Rb extends Error {}
    try {
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        const e = await insEntry(tx, a, { status: 'cancelled' });
        const ent = await probe(tx, (sp) => upd(sp, e, { status: 'waiting' }));
        const entKey = await probe(tx, (sp) => upd(sp, e, { code: nextCode() }));
        const live = await insEntry(tx, a);
        const entBack = await ins(tx, 'lobby_entries', seatedRow(a));
        const entSeatedBack = await probe(tx, (sp) => upd(sp, entBack, { status: 'called' }));
        const b = await ins(tx, 'lobby_birthday_requests', birthdayRow(a, live));
        await asSql(tx)`update lobby_birthday_requests set status = 'declined', decline_reason = 'busy' where id = ${b}`;
        const bd = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'requested', decline_reason = null where id = ${b}`);
        const c = await ins(tx, 'lobby_discount_claims', claimRow(a, entBack));
        await asSql(tx)`update lobby_discount_claims set status = 'rejected', reject_reason = 'x', holder_name = null, id_number = null where id = ${c}`;
        const cl = await probe(tx, (sp) => asSql(sp)`update lobby_discount_claims set status = 'pending' where id = ${c}`);
        out = { ent, entKey, entSeatedBack, bd, cl };
        throw new Rb();
      });
    } catch (e) {
      if (!(e instanceof Rb)) throw e;
    }
    expect(Object.keys(out).length, 'RED today: no table').toBeGreaterThan(0);
    for (const [k, v] of Object.entries(out)) expectRefused(v, `T6 ${k} under replica mode (mutant: trigger left origin)`);
  });
});

// ================================================================================================ lines

describe('L -- lobby_entry_lines', () => {
  it('B0 qty 1 and 20 accepted; 0, 21 refused 23514; line_kind package/a_la_carte only; the row stores variant + option values + qty', async () => {
    const a = await fixture('b0');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await insEntry(tx, a);
      return {
        q1: await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow(a, e, { qty: 1 }))),
        q20: await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow(a, e, { qty: 20, line_kind: 'package' }))),
        q0: await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow(a, e, { qty: 0 }))),
        q21: await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow(a, e, { qty: 21 }))),
        kind: await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow(a, e, { line_kind: 'refill' }))),
        opts: await probe(tx, (sp) => (async () => {
          const line = await ins(sp, 'lobby_entry_lines', lineRow(a, e, { qty: 2, line_kind: 'package' }));
          const v1 = await newOption(a);
          const v2 = await newOption(a);
          await ins(sp, 'lobby_entry_line_options', { org_id: a.orgId, line_id: line, option_value_id: v1.valueId });
          await ins(sp, 'lobby_entry_line_options', { org_id: a.orgId, line_id: line, option_value_id: v2.valueId });
        })()),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.q1?.message).toBeUndefined();
    expect(value!.q20?.message).toBeUndefined();
    expect(value!.opts?.message, 'a line takes one option row per flavour').toBeUndefined();
    expectRefused(value!.q0, 'qty 0', '23514');
    expectRefused(value!.q21, 'qty 21', '23514');
    expectRefused(value!.kind, 'line_kind refill', '23514');
  });
});

// ================================================================================================ birthday

describe('B -- lobby_birthday_requests', () => {
  it('B1 one request per entry unless cancelled (partial UNIQUE (entry_id) WHERE status <> cancelled)', async () => {
    const a = await fixture('b1');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await insEntry(tx, a);
      const r1 = await ins(tx, 'lobby_birthday_requests', birthdayRow(a, e));
      const second = await probe(tx, (sp) => ins(sp, 'lobby_birthday_requests', birthdayRow(a, e)));
      await tx`update lobby_birthday_requests set status = 'cancelled' where id = ${r1}`;
      const afterCancel = await probe(tx, (sp) => ins(sp, 'lobby_birthday_requests', birthdayRow(a, e)));
      const thirdLive = await probe(tx, (sp) => ins(sp, 'lobby_birthday_requests', birthdayRow(a, e)));
      const e2 = await insEntry(tx, a);
      const otherEntry = await probe(tx, (sp) => ins(sp, 'lobby_birthday_requests', birthdayRow(a, e2)));
      return { second, afterCancel, thirdLive, otherEntry };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.second, 'B1 second live request on one entry (mutant: no unique)', '23505');
    expect(value!.afterCancel?.message, 'a cancelled request frees the slot (mutant: full UNIQUE)').toBeUndefined();
    expectRefused(value!.thirdLive, 'B1 the new request is live again', '23505');
    expect(value!.otherEntry?.message).toBeUndefined();
  });

  it('B2 INSERT is only ever "requested" (accepted/played/declined/expired/cancelled/bogus refused 23514); a requested row with a scheduled_at is refused; accept = UPDATE with scheduled_at, then played = UPDATE with played_at', async () => {
    const a = await fixture('b2');
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const mk = async (o: Row) => {
        const e = await insEntry(tx, a);
        return probe(tx, (sp) => ins(sp, 'lobby_birthday_requests', birthdayRow(a, e, o)));
      };
      const e = await insEntry(tx, a);
      const r = await ins(tx, 'lobby_birthday_requests', birthdayRow(a, e));
      const toAccepted = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${at} where id = ${r}`);
      const toPlayed = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'played', played_at = ${at} where id = ${r}`);
      return {
        insAccepted: await mk({ status: 'accepted', scheduled_at: at, accepted_at: at }),
        insPlayed: await mk({ status: 'played', scheduled_at: at, accepted_at: at, played_at: at }),
        insDeclined: await mk({ status: 'declined', decline_reason: 'busy' }),
        insExpired: await mk({ status: 'expired' }),
        insCancelled: await mk({ status: 'cancelled' }),
        insBogus: await mk({ status: 'bogus' }),
        requestedWithTime: await mk({ status: 'requested', scheduled_at: at }),
        requestedOk: await mk({}),
        toAccepted,
        toPlayed,
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    for (const k of ['insAccepted', 'insPlayed', 'insDeclined', 'insExpired', 'insCancelled', 'insBogus', 'requestedWithTime'] as const) {
      expectRefused(value![k], `B2 ${k} (mutant: INSERT as any state / time on requested)`, '23514');
    }
    expect(value!.requestedOk?.message).toBeUndefined();
    expect(value!.toAccepted?.message, 'requested -> accepted with a time is legal').toBeUndefined();
    expect(value!.toPlayed?.message, 'accepted -> played is legal').toBeUndefined();
  });

  it('B2b accepted_at is stamped by the server: a caller-supplied accepted_at is overwritten; scheduled_at is fixed after acceptance; requested -> declined with a scheduled_at is refused 23514; accepted -> expired/cancelled keep the time and are legal', async () => {
    const a = await fixture('b2b');
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const mkReq = async () => ins(tx, 'lobby_birthday_requests', birthdayRow(a, await insEntry(tx, a)));
      const r1 = await mkReq();
      await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${at}, accepted_at = '2000-01-01T00:00:00Z' where id = ${r1}`);
      const [row] = await tx<{ fresh: boolean | null }[]>`select (accepted_at > now() - interval '5 minutes') fresh from lobby_birthday_requests where id = ${r1}`;
      const retime = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set scheduled_at = ${new Date(Date.now() + 7_200_000).toISOString()} where id = ${r1}`);
      const r2 = await mkReq();
      const declineWithTime = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'declined', decline_reason = 'busy', scheduled_at = ${at} where id = ${r2}`);
      const r3 = await mkReq();
      await asSql(tx)`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${at} where id = ${r3}`;
      const toExpired = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'expired' where id = ${r3}`);
      const r4 = await mkReq();
      await asSql(tx)`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${at} where id = ${r4}`;
      const toCancelled = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'cancelled' where id = ${r4}`);
      return { fresh: row?.fresh, retime, declineWithTime, toExpired, toCancelled };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.fresh, 'mutant: caller-supplied accepted_at kept (2000-01-01)').toBe(true);
    expectRefused(value!.retime, 'B2b scheduled_at changed after acceptance');
    expectRefused(value!.declineWithTime, 'B2b requested -> declined carrying a scheduled_at', '23514');
    expect(value!.toExpired?.message, 'accepted -> expired is legal').toBeUndefined();
    expect(value!.toCancelled?.message, 'accepted -> cancelled is legal').toBeUndefined();
  });

  it('B3 forward-only: requested -> accepted -> played, requested -> declined work; played -> requested/cancelled, declined -> accepted, accepted -> requested, requested -> played refused', async () => {
    const a = await fixture('b3');
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const mkReq = async () => ins(tx, 'lobby_birthday_requests', birthdayRow(a, await insEntry(tx, a)));
      const r1 = await mkReq();
      const toAccepted = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${at} where id = ${r1}`);
      const toPlayed = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'played', played_at = ${at} where id = ${r1}`);
      const playedBack = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'requested', played_at = null where id = ${r1}`);
      const playedCancel = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'cancelled', played_at = null where id = ${r1}`);
      const r2 = await mkReq();
      const toDeclined = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'declined', decline_reason = 'busy' where id = ${r2}`);
      const declinedToAccepted = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'accepted', decline_reason = null, scheduled_at = ${at} where id = ${r2}`);
      const r3 = await mkReq();
      const skipPlay = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'played', scheduled_at = ${at}, played_at = ${at} where id = ${r3}`);
      const r4 = await mkReq();
      await asSql(tx)`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${at} where id = ${r4}`;
      const acceptedBack = await probe(tx, (sp) => asSql(sp)`update lobby_birthday_requests set status = 'requested' where id = ${r4}`);
      return { toAccepted, toPlayed, toDeclined, playedBack, playedCancel, declinedToAccepted, skipPlay, acceptedBack };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    for (const k of ['toAccepted', 'toPlayed', 'toDeclined'] as const) expect(value![k]?.message, `legal ${k} refused`).toBeUndefined();
    for (const k of ['playedBack', 'playedCancel', 'declinedToAccepted', 'skipPlay', 'acceptedBack'] as const) expectRefused(value![k], `B3 ${k} (mutant: no forward-only trigger)`);
  });
});

// ================================================================================================ claims

describe('K -- lobby_discount_claims (row 353: no photo, name/ID die with the pending state)', () => {
  const NOW = () => new Date().toISOString();
  const approve = (tx: Tx, id: string, who: string, o: Row = {}) =>
    asSql(tx)`update lobby_discount_claims set ${asSql(tx)({
      status: 'approved', holder_name: null, id_number: null, card_seen_at: NOW(), session_ref: 'S-1', statutory_diner_ref: 'D-1', acted_by_person_id: who, ...o,
    })} where id = ${id}`;

  it('K0 a pending claim holds name + ID + last 4; kind is senior|pwd only; status is a closed set', async () => {
    const a = await fixture('k0');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await ins(tx, 'lobby_entries', seatedRow(a, { party_size: 5 }));
      return {
        senior: await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e, { kind: 'senior' }))),
        pwd: await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e, { kind: 'pwd' }))),
        kind: await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e, { kind: 'student' }))),
        status: await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e, { status: 'bogus', holder_name: null, id_number: null }))),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.senior?.message).toBeUndefined();
    expect(value!.pwd?.message).toBeUndefined();
    expectRefused(value!.kind, 'kind student', '23514');
    expectRefused(value!.status, 'status bogus', '23514');
  });

  it('K1 a claim leaving pending with the name or ID kept is refused 23514 (approve, reject, expire); inserting a non-pending row carrying a name is refused too', async () => {
    const a = await fixture('k1');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await ins(tx, 'lobby_entries', seatedRow(a, { party_size: 5 }));
      const mk = () => ins(tx, 'lobby_discount_claims', claimRow(a, e));
      const c1 = await mk();
      const c2 = await mk();
      const c3 = await mk();
      const c4 = await mk();
      const c5 = await mk();
      return {
        approveKeepName: await probe(tx, (sp) => approve(sp, c1, a.personId, { holder_name: 'Ana Reyes' })),
        approveKeepId: await probe(tx, (sp) => approve(sp, c2, a.personId, { id_number: '1234-5678' })),
        rejectKeep: await probe(tx, (sp) => asSql(sp)`update lobby_discount_claims set status = 'rejected', reject_reason = 'blurry', acted_by_person_id = ${a.personId} where id = ${c3}`),
        expireKeep: await probe(tx, (sp) => asSql(sp)`update lobby_discount_claims set status = 'expired' where id = ${c4}`),
        insertApprovedWithName: await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e, { status: 'approved', card_seen_at: NOW() }))),
        approveClean: await probe(tx, (sp) => approve(sp, c5, a.personId)),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.approveKeepName, 'K1 approve keeping holder_name (mutant: CHECK missing)', '23514');
    expectRefused(value!.approveKeepId, 'K1 approve keeping id_number', '23514');
    expectRefused(value!.rejectKeep, 'K1 reject keeping name/ID', '23514');
    expectRefused(value!.expireKeep, 'K1 expire keeping name/ID', '23514');
    expectRefused(value!.insertApprovedWithName, 'K1 insert approved with a name', '23514');
    expect(value!.approveClean?.message, 'approving with name+ID nulled and card seen is legal (mutant: over-strict)').toBeUndefined();
  });

  it('K2 card_seen_at is NOT NULL exactly when status = approved: approved without it, pending with it, rejected with it all refused 23514; last 4 and outcome survive an approval', async () => {
    const a = await fixture('k2');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await ins(tx, 'lobby_entries', seatedRow(a, { party_size: 5 }));
      const approvedNoSeen = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e, { status: 'approved', holder_name: null, id_number: null })));
      const pendingSeen = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e, { card_seen_at: NOW() })));
      const rejectedSeen = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e, { status: 'rejected', holder_name: null, id_number: null, card_seen_at: NOW(), reject_reason: 'x' })));
      const c = await ins(tx, 'lobby_discount_claims', claimRow(a, e));
      await approve(tx, c, a.personId);
      const [row] = await tx<{ id_last4: string; status: string; acted_by_person_id: string; holder_name: string | null; id_number: string | null }[]>`
        select id_last4, status, acted_by_person_id, holder_name, id_number from lobby_discount_claims where id = ${c}`;
      return { approvedNoSeen, pendingSeen, rejectedSeen, row };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.approvedNoSeen, 'approved without card_seen_at', '23514');
    expectRefused(value!.pendingSeen, 'pending with card_seen_at', '23514');
    expectRefused(value!.rejectedSeen, 'rejected with card_seen_at', '23514');
    expect(value!.row).toMatchObject({ id_last4: '5678', status: 'approved', acted_by_person_id: a.personId, holder_name: null, id_number: null });
  });

  it('K3 forward-only: pending -> approved|rejected|expired; approved/rejected/expired are terminal (approved -> pending/rejected, rejected -> approved, expired -> pending refused)', async () => {
    const a = await fixture('k3');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await ins(tx, 'lobby_entries', seatedRow(a, { party_size: 9 }));
      const mk = (o: Row = {}) => ins(tx, 'lobby_discount_claims', claimRow(a, e, o));
      const rejected = await mk();
      const rejectOk = await probe(tx, (sp) => asSql(sp)`update lobby_discount_claims set status = 'rejected', reject_reason = 'blurry', holder_name = null, id_number = null where id = ${rejected}`);
      const expired = await mk();
      const expireOk = await probe(tx, (sp) => asSql(sp)`update lobby_discount_claims set status = 'expired', holder_name = null, id_number = null where id = ${expired}`);
      const approved = await mk();
      await approve(tx, approved, a.personId);
      return {
        rejectOk,
        expireOk,
        approvedToPending: await probe(tx, (sp) => asSql(sp)`update lobby_discount_claims set status = 'pending' where id = ${approved}`),
        approvedToRejected: await probe(tx, (sp) => asSql(sp)`update lobby_discount_claims set status = 'rejected', reject_reason = 'x', card_seen_at = null where id = ${approved}`),
        rejectedToApproved: await probe(tx, (sp) => approve(sp, rejected, a.personId)),
        expiredToPending: await probe(tx, (sp) => asSql(sp)`update lobby_discount_claims set status = 'pending' where id = ${expired}`),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.rejectOk?.message, 'pending -> rejected is legal').toBeUndefined();
    expect(value!.expireOk?.message, 'pending -> expired is legal').toBeUndefined();
    for (const k of ['approvedToPending', 'approvedToRejected', 'rejectedToApproved', 'expiredToPending'] as const) expectRefused(value![k], `K3 ${k} (mutant: no forward-only trigger)`);
  });

  it('K4 at most party_size claims per entry: party of 2 takes 2 claims, the 3rd is refused (mutant: no cap trigger); a party of 1 takes exactly 1', async () => {
    const a = await fixture('k4');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e2 = await ins(tx, 'lobby_entries', seatedRow(a, { party_size: 2 }));
      const one = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e2)));
      const two = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e2, { kind: 'pwd' })));
      const three = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e2)));
      const e1 = await ins(tx, 'lobby_entries', seatedRow(a, { party_size: 1 }));
      const solo1 = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e1)));
      const solo2 = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, e1)));
      return { one, two, three, solo1, solo2 };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.one?.message).toBeUndefined();
    expect(value!.two?.message, 'the 2nd claim of a party of 2 must be accepted').toBeUndefined();
    expect(value!.solo1?.message).toBeUndefined();
    expectRefused(value!.three, 'K4 3rd claim, party of 2');
    expectRefused(value!.solo2, 'K4 2nd claim, party of 1');
  });
});

describe('K5 -- DEF-774 / T-479: shrinking a waiting party cannot leave more live claims than diners', () => {
  const NOW = () => new Date().toISOString();
  const setParty = (sp: Tx, entry: string, n: number) => asSql(sp)`update lobby_entries set party_size = ${n} where id = ${entry}`;
  const partyOf = async (tx: Tx, entry: string) => (await tx<{ party_size: number }[]>`select party_size from lobby_entries where id = ${entry}`)[0]!.party_size;

  it('K5a party 3 with three pending claims: party_size = 1 and = 2 are refused 23514 and the row is unchanged (mutant: no shrink trigger)', async () => {
    const a = await fixture('k5a');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await ins(tx, 'lobby_entries', entryRow(a, { party_size: 3 }));
      for (let i = 0; i < 3; i++) await ins(tx, 'lobby_discount_claims', claimRow(a, e));
      const toOne = await probe(tx, (sp) => setParty(sp, e, 1));
      const toTwo = await probe(tx, (sp) => setParty(sp, e, 2));
      return { toOne, toTwo, party: await partyOf(tx, e) };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.toOne, 'K5a 3 pending claims, party 3 -> 1', '23514');
    expectRefused(value!.toTwo, 'K5a 3 pending claims, party 3 -> 2', '23514');
    expect(value!.party, 'a refused shrink leaves the row unchanged').toBe(3);
  });

  it('K5b only pending and approved claims count: party 3 with two pending + one rejected shrinks to 2, not to 1', async () => {
    const a = await fixture('k5b');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await ins(tx, 'lobby_entries', entryRow(a, { party_size: 3 }));
      await ins(tx, 'lobby_discount_claims', claimRow(a, e));
      await ins(tx, 'lobby_discount_claims', claimRow(a, e, { kind: 'pwd' }));
      const rejected = await ins(tx, 'lobby_discount_claims', claimRow(a, e));
      await asSql(tx)`update lobby_discount_claims set status = 'rejected', reject_reason = 'blurry', holder_name = null, id_number = null where id = ${rejected}`;
      const toTwo = await probe(tx, (sp) => setParty(sp, e, 2));
      const toOne = await probe(tx, (sp) => setParty(sp, e, 1));
      return { toTwo, toOne, party: await partyOf(tx, e) };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.toTwo?.message, 'a rejected claim does not count: 3 -> 2 is legal with 2 live claims').toBeUndefined();
    expectRefused(value!.toOne, 'K5b 2 live claims, party 2 -> 1', '23514');
    expect(value!.party).toBe(2);
  });

  it('K5c approved claims count the same as pending ones', async () => {
    const a = await fixture('k5c');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await ins(tx, 'lobby_entries', entryRow(a, { party_size: 3 }));
      const c1 = await ins(tx, 'lobby_discount_claims', claimRow(a, e));
      const c2 = await ins(tx, 'lobby_discount_claims', claimRow(a, e));
      for (const c of [c1, c2]) {
        await asSql(tx)`update lobby_discount_claims set ${asSql(tx)({
          status: 'approved', holder_name: null, id_number: null, card_seen_at: NOW(), session_ref: 'S-1', statutory_diner_ref: `D-${c.slice(-4)}`, acted_by_person_id: a.personId,
        })} where id = ${c}`;
      }
      return { toOne: await probe(tx, (sp) => setParty(sp, e, 1)), toTwo: await probe(tx, (sp) => setParty(sp, e, 2)) };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expectRefused(value!.toOne, 'K5c 2 approved claims, party 3 -> 1 (mutant: only pending counted)', '23514');
    expect(value!.toTwo?.message, 'party 3 -> 2 with 2 approved claims is legal').toBeUndefined();
  });

  it('K5d growing the party, and an update that leaves party_size alone, are allowed with claims at the cap', async () => {
    const a = await fixture('k5d');
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const e = await ins(tx, 'lobby_entries', entryRow(a, { party_size: 3 }));
      for (let i = 0; i < 3; i++) await ins(tx, 'lobby_discount_claims', claimRow(a, e));
      return {
        grow: await probe(tx, (sp) => setParty(sp, e, 5)),
        same: await probe(tx, (sp) => setParty(sp, e, 5)),
        note: await probe(tx, (sp) => asSql(sp)`update lobby_entries set note = 'near the door' where id = ${e}`),
        called: await probe(tx, (sp) => asSql(sp)`update lobby_entries set status = 'called' where id = ${e}`),
        party: await partyOf(tx, e),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    expect(value!.grow?.message, 'growing 3 -> 5 is untouched (mutant: any party_size change checked)').toBeUndefined();
    expect(value!.same?.message, 'setting party_size to its own value is untouched').toBeUndefined();
    expect(value!.note?.message, 'an update that does not touch party_size is untouched').toBeUndefined();
    expect(value!.called?.message, 'a status move at the cap is untouched').toBeUndefined();
    expect(value!.party).toBe(5);
  });

  describe('concurrency: the entry row lock orders a claim insert against a shrink (DEF-774)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** A COMMITTED entry (not rolled back) with `claims` pending claims, written by the admin connection; removed again afterwards. */
    async function committedEntry(a: MenuFx, party: number, claims: number) {
      const entry = await insEntry(sql, a, { party_size: party });
      for (let i = 0; i < claims; i++) await ins(sql, 'lobby_discount_claims', claimRow(a, entry));
      return entry;
    }
    const cleanup = async (entry: string) => {
      await sql`delete from lobby_discount_claims where entry_id = ${entry}`;
      await sql`delete from lobby_entries where id = ${entry}`;
    };
    const settled = (p: Promise<unknown>) => {
      const s = { done: false };
      void p.then(
        () => (s.done = true),
        () => (s.done = true),
      );
      return s;
    };

    it('K5e tx A inserts the 3rd claim (holds the entry lock), tx B tries party_size = 2 and BLOCKS; A commits -> B is refused 23514', async () => {
      const a = await fixture('k5e');
      const entry = await committedEntry(a, 3, 2);
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let aHasLock!: () => void;
        const aReady = new Promise<void>((r) => (aHasLock = r));
        const txA = sql.begin(async (tx) => {
          await ins(tx, 'lobby_discount_claims', claimRow(a, entry));
          aHasLock();
          await gate;
        });
        await aReady;
        const txB = sql
          .begin(async (tx) => {
            await setParty(tx, entry, 2);
          })
          .then(
            () => undefined,
            (e: PgErr) => e,
          );
        const bState = settled(txB);
        await sleep(500);
        expect(bState.done, 'B must wait on the entry row lock A holds, not decide on a stale count').toBe(false);
        release();
        await txA;
        const bErr = await txB;
        expectRefused(bErr, 'K5e shrink to 2 after A committed a 3rd claim', '23514');
        expect(await sql`select party_size from lobby_entries where id = ${entry}`).toMatchObject([{ party_size: 3 }]);
        expect(await sql`select count(*)::int as n from lobby_discount_claims where entry_id = ${entry}`).toMatchObject([{ n: 3 }]);
      } finally {
        await cleanup(entry);
      }
    });

    it('K5f reverse order: tx B shrinks to 2 first (holds the entry lock), tx A inserts the 3rd claim and BLOCKS; B commits -> the insert is refused', async () => {
      const a = await fixture('k5f');
      const entry = await committedEntry(a, 3, 2);
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let bHasLock!: () => void;
        const bReady = new Promise<void>((r) => (bHasLock = r));
        const txB = sql.begin(async (tx) => {
          await setParty(tx, entry, 2);
          bHasLock();
          await gate;
        });
        await bReady;
        const txA = sql
          .begin(async (tx) => {
            await ins(tx, 'lobby_discount_claims', claimRow(a, entry));
          })
          .then(
            () => undefined,
            (e: PgErr) => e,
          );
        const aState = settled(txA);
        await sleep(500);
        expect(aState.done, 'the claim insert must wait on the entry row lock B holds').toBe(false);
        release();
        await txB;
        const aErr = await txA;
        expectRefused(aErr, 'K5f 3rd claim after the party shrank to 2', '23514');
        expect(await sql`select party_size from lobby_entries where id = ${entry}`).toMatchObject([{ party_size: 2 }]);
        expect(await sql`select count(*)::int as n from lobby_discount_claims where entry_id = ${entry}`).toMatchObject([{ n: 2 }]);
      } finally {
        await cleanup(entry);
      }
    });
  });
});

// ================================================================================================ cross-org FKs (as shareat_app)

describe('F -- same-org: as shareat_app (org A) a row pointing at ORG B parents is refused 23503 (a plain FK would accept it)', () => {
  it('F1..F11: stores, persons, entries, variants, on every lobby table', async () => {
    const a = await fixture('fa');
    const b = await fixture('fb');
    const bEntry = await insEntry(sql, b, {});
    const bLine = await ins(sql, 'lobby_entry_lines', lineRow(b, bEntry));
    const bOpt = await newOption(b);
    const aOpt = await newOption(a); // B's parent rows, written as the owner
    const aStoreBase = { orgId: a.orgId, storeId: a.storeId };
    const { value, err } = await asApp(a.orgId, async (tx) => {
      const aEntry = await insEntry(tx, a);
      const aLine = await ins(tx, 'lobby_entry_lines', lineRow(a, aEntry, { qty: 3 }));
      return {
        F1_lobby_stores_store: await probe(tx, (sp) => asSql(sp)`insert into lobby_stores (org_id, store_id, enabled, paused, birthday_enabled, claims_enabled) values (${a.orgId}, ${b.storeId}, true, false, true, true)`),
        F2_entries_store: await probe(tx, (sp) => insEntry(sp, { orgId: a.orgId, storeId: b.storeId })),
        F3_entries_actor: await probe(tx, (sp) => insEntry(sp, aStoreBase, { acted_by_person_id: b.personId })),
        F4_lines_entry: await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow(a, bEntry))),
        F5_lines_variant: await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow({ orgId: a.orgId, variantId: b.variantId }, aEntry))),
        F6_birthday_entry: await probe(tx, (sp) => ins(sp, 'lobby_birthday_requests', birthdayRow(a, bEntry))),
        F7_birthday_actor: await probe(tx, (sp) => ins(sp, 'lobby_birthday_requests', birthdayRow(a, aEntry, { acted_by_person_id: b.personId }))),
        F8_claims_entry: await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, bEntry))),
        F9_claims_actor: await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, aEntry, { acted_by_person_id: b.personId }))),
        F10_option_line: await probe(tx, (sp) => ins(sp, 'lobby_entry_line_options', { org_id: a.orgId, line_id: bLine, option_value_id: aOpt.valueId })),
        F11_option_value: await probe(tx, (sp) => ins(sp, 'lobby_entry_line_options', { org_id: a.orgId, line_id: aLine, option_value_id: bOpt.valueId })),
        control_option_own: await probe(tx, (sp) => ins(sp, 'lobby_entry_line_options', { org_id: a.orgId, line_id: aLine, option_value_id: aOpt.valueId })),
        control_own_parents: await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow(a, aEntry))),
      };
    });
    expect(err?.message, 'RED today: no table').toBeUndefined();
    const { control_own_parents, control_option_own, ...bad } = value!;
    expect(control_own_parents?.message, 'control: own-org parents must be accepted').toBeUndefined();
    expect(control_option_own?.message, 'control: own-org option row must be accepted').toBeUndefined();
    for (const [k, v] of Object.entries(bad)) expectRefused(v, `${k} (mutant: plain FK instead of composite)`, '23503');
  });
});

// ================================================================================================ RLS

describe('R -- RLS: a second org cannot read or write the first org lobby rows', () => {
  it('R1 catalog: ENABLE + FORCE row level security and a policy whose USING and WITH CHECK both use app_current_org()', async () => {
    for (const t of LOBBY) {
      const [c] = await sql<{ rls: boolean; force: boolean }[]>`select relrowsecurity rls, relforcerowsecurity "force" from pg_class where oid = to_regclass(${'public.' + t})`;
      expect(c, `${t}: RED today, no table`).toBeDefined();
      expect(c!.rls, `${t}: RLS not enabled`).toBe(true);
      expect(c!.force, `${t}: FORCE missing (the owner would bypass it)`).toBe(true);
      const pols = await sql<{ qual: string | null; with_check: string | null }[]>`select qual, with_check from pg_policies where schemaname = 'public' and tablename = ${t}`;
      expect(pols.length, `${t}: no policy`).toBeGreaterThan(0);
      expect(pols.some((p) => /app_current_org\(\)/.test(p.qual ?? '') && /app_current_org\(\)/.test(p.with_check ?? '')), `${t}: no policy with both USING and WITH CHECK on app_current_org() (DEF-183)`).toBe(true);
    }
  });

  it('R2 grants: shareat_app has SELECT, INSERT, UPDATE and NOT TRUNCATE / REFERENCES / TRIGGER on every lobby table', async () => {
    for (const t of LOBBY) {
      const [p] = await sql<{ sel: boolean | null; ins: boolean | null; upd: boolean | null; trunc: boolean | null; refs: boolean | null; trg: boolean | null }[]>`
        select has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'SELECT') sel, has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'INSERT') ins,
               has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'UPDATE') upd, has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'TRUNCATE') trunc,
               has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'REFERENCES') refs, has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'TRIGGER') trg`;
      expect(p, `${t}: RED today, no table`).toMatchObject({ sel: true, ins: true, upd: true, trunc: false, refs: false, trg: false });
    }
  });

  it('R3 behaviour: org B sees none of org A rows in any of the five tables, cannot update them, cannot INSERT a row labelled org A (42501); org A still sees its own', async () => {
    const a = await fixture('ra');
    const b = await fixture('rb');
    const entryId = await ins(sql, 'lobby_entries', seatedRow(a, { party_size: 4 }));
    await asSql(sql)`insert into lobby_stores (org_id, store_id, enabled, paused, birthday_enabled, claims_enabled) values (${a.orgId}, ${a.storeId}, true, false, true, true) on conflict do nothing`;
    const lineId = await ins(sql, 'lobby_entry_lines', lineRow(a, entryId));
    const rOpt = await newOption(a);
    await ins(sql, 'lobby_entry_line_options', { org_id: a.orgId, line_id: lineId, option_value_id: rOpt.valueId });
    const bdId = await ins(sql, 'lobby_birthday_requests', birthdayRow(a, entryId));
    const clId = await ins(sql, 'lobby_discount_claims', claimRow(a, entryId));
    const count = async (tx: Tx, t: string, orgCol = 'org_id') => (await asSql(tx)`select count(*)::int n from ${asSql(tx)(t)} where org_id = ${a.orgId}`)[0]!.n as number;

    const asB = await asApp(b.orgId, async (tx) => {
      const seen: Record<string, number> = {};
      for (const t of LOBBY) seen[t] = await count(tx, t);
      const upd = await tx`update lobby_entries set note = 'hacked' where id = ${entryId} returning id`;
      const updClaim = await tx`update lobby_discount_claims set kind = 'pwd' where id = ${clId} returning id`;
      const insA = await probe(tx, (sp) => insEntry(sp, a));
      const insOptA = await probe(tx, (sp) => ins(sp, 'lobby_entry_line_options', { org_id: a.orgId, line_id: lineId, option_value_id: rOpt.valueId }));
      const insLineA = await probe(tx, (sp) => ins(sp, 'lobby_entry_lines', lineRow(a, entryId)));
      const insClaimA = await probe(tx, (sp) => ins(sp, 'lobby_discount_claims', claimRow(a, entryId)));
      return { seen, updated: upd.length + updClaim.length, insOptA, insA, insLineA, insClaimA };
    });
    expect(asB.err?.message, 'RED today: no table').toBeUndefined();
    for (const t of LOBBY) expect(asB.value!.seen[t], `${t}: org B saw org A rows (mutant: no RLS)`).toBe(0);
    expect(asB.value!.updated, 'org B updated org A rows').toBe(0);
    expectRefused(asB.value!.insA, 'R3 B inserts an org-A entry (mutant: policy USING-only)', '42501');
    expectRefused(asB.value!.insOptA, 'R3 B inserts an org-A option row', '42501');
    expectRefused(asB.value!.insLineA, 'R3 B inserts an org-A line', '42501');
    expectRefused(asB.value!.insClaimA, 'R3 B inserts an org-A claim', '42501');

    const asA = await asApp(a.orgId, async (tx) => {
      const seen: Record<string, number> = {};
      for (const t of LOBBY) seen[t] = await count(tx, t);
      return seen;
    });
    expect(asA.value, 'control: org A sees its own (mutant: policy denies everyone)').toMatchObject({
      lobby_stores: 1, lobby_entries: expect.any(Number), lobby_entry_lines: 1, lobby_entry_line_options: 1, lobby_birthday_requests: 1, lobby_discount_claims: 1,
    });
    expect(lineId && bdId).toBeTruthy();
  });
});

// ================================================================================================ registries

describe('G -- cutover classification and RLS registry have an entry for every new table', () => {
  it.each(LOBBY)('G1 %s is in RLS_REGISTRY with scope org_column and a reason', (t) => {
    const e = RLS_REGISTRY[t];
    expect(e, `${t}: RED today, no RLS registry entry (the build would refuse the table)`).toBeDefined();
    expect(e!.scope, 'every lobby table has its own org_id (spec 2.2 heading)').toBe('org_column');
    expect(e!.reason.length).toBeGreaterThan(20);
  });

  it.each(LOBBY)('G2 %s is classified in CUTOVER_CLASSIFICATION (keep or purge, with a reason)', (t) => {
    const e = CUTOVER_CLASSIFICATION[t];
    expect(e, `${t}: RED today, no cutover classification`).toBeDefined();
    expect(['keep', 'purge', 'keep_shell', 'date_scoped']).toContain(e!.class);
    expect(e!.reason.length).toBeGreaterThan(20);
  });
});

// ================================================================================================ L1: the migration's own text

describe('L1 -- the 0215 migration text (ADR-012 s5)', () => {
  const journal = () => (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] }).entries;
  const text = (): string => {
    const e = journal().find((x) => x.tag.startsWith('0215_'));
    expect(e, 'no journal entry numbered 0215: the S1 migration does not exist yet').toBeDefined();
    const f = join(MIGRATIONS_FOLDER, `${e!.tag}.sql`);
    expect(existsSync(f)).toBe(true);
    return readFileSync(f, 'utf8');
  };
  const statements = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim() !== '');

  it('exactly one 0215 entry (tag names t455), LF-only, no BOM, no 0x08 byte', () => {
    expect(journal().filter((e) => e.tag.startsWith('0215_')).length, 'RED today: no 0215 entry').toBe(1);
    const t = text();
    expect(journal().find((e) => e.tag.startsWith('0215_'))!.tag).toMatch(/t455/);
    expect(t.includes('\r'), 'CRLF').toBe(false);
    expect(t.charCodeAt(0), 'BOM').not.toBe(0xfeff);
    expect(t.includes(String.fromCharCode(8)), 'a backspace byte (a broken \\b or \\s regex)').toBe(false);
  });

  it("the first statement is SET LOCAL lock_timeout = '5s'; the header names T-455", () => {
    const t = text();
    expect(t).toMatch(/T-455/);
    expect(statements(t)[0] ?? '', 'mutant: lock_timeout missing or not first').toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'/i);
  });

  it('the header states the budget: a measured time and the lock the composite FKs take on stores / persons / menu_item_variants (SHARE ROW EXCLUSIVE)', () => {
    const header = text().split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(header, 'mutant: no budget').toMatch(/budget/i);
    expect(header).toMatch(/\d+(\.\d+)?\s*(s|ms|sec|seconds)\b/i);
    expect(header, 'adding an FK locks the referenced table SHARE ROW EXCLUSIVE').toMatch(/SHARE ROW EXCLUSIVE/i);
  });

  it('it touches only lobby_* tables: every CREATE TABLE / ALTER TABLE / CREATE INDEX / CREATE POLICY / GRANT / REVOKE names a lobby_ table (no edit of an existing table)', () => {
    const t = text();
    const stmts = t.split(/-->\s*statement-breakpoint/).map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
    const offenders = stmts.filter((s) => /^(CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE POLICY|GRANT|REVOKE|DROP)/i.test(s) && !/lobby_/.test(s));
    expect(offenders, 'a statement that does not name a lobby_ table').toEqual([]);
    for (const tbl of LOBBY) expect(t, `${tbl} not created`).toMatch(new RegExp(`CREATE TABLE "?${tbl}"?`, 'i'));
  });
});
