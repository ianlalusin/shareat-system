/**
 * T-511 S6c (TESTER, 7 Nov 2026) - migration 0244: a platform charge with no sales day is booked once and netted from the payout that settles it.
 * docs/tasks/511-settlement-upload-s6c-spec.md Design A and C. Real Postgres via TEST_DATABASE_URL.
 *
 * RED TODAY, for one reason: migration 0244 does not exist, so `settlement_other_lines.vat_amount`, the two tables, their guards, policies and registry
 * entries are all absent (the fixtures below write `vat_amount`, so every leg that needs a row fails on "column vat_amount does not exist").
 *
 * PINNED BY THESE TESTS (the builder meets them or asks BOSS to change the tests; the spec leaves each open):
 *  M1  a file `0244_*.sql` whose stem is the journal tag of idx 244, `when` 1807155107084 (0243's 1807068707084 + 86,400,000), breakpoints true. The spec names no file
 *      name, so the stem is only required to start `0244_` and to name t511. Provisional number: BOSS renumbers at rebase (change the two constants, nothing else).
 *  M2  `settlement_other_lines.vat_amount numeric(14,2)`, NULL allowed, no default, finite only (spec ruling 3: a credit note has a negative VAT).
 *  M3  `channel_period_charges(id, org_id, store_id, channel_id, other_line_id, upload_id, charge_date, net_amount, vat_amount, total_amount, entry_date,
 *      journal_entry_id, description, posted_by, posted_at)`: every column NOT NULL except `description`; the amounts numeric(14,2); the dates `date`.
 *      Unique (org_id, other_line_id) and (org_id, journal_entry_id); total_amount <> 0; total_amount = net_amount + vat_amount (both 23514).
 *      Composite same-org FKs starting with org_id: channel AND store in ONE constraint onto sales_channels (the store is the channel's store), upload, other line,
 *      journal entry, poster; all ON DELETE RESTRICT.
 *  M4  `channel_settlement_charge_links(org_id, settlement_id, charge_id)`, primary key exactly those three in that order; composite same-org FKs for the settlement and
 *      the charge, ON DELETE RESTRICT. NO unique on the charge alone: a charge freed by a void is netted again by another settlement.
 *  M5  both tables: RLS ENABLE + FORCE, policy `<table>_org_isolation` (app_current_org(), USING and WITH CHECK), the app role SELECT and INSERT only, no column UPDATE.
 *  M6  both tables: `<table>_append_only` BEFORE UPDATE OR DELETE refuse trigger, ENABLE ALWAYS, 23001 for the owner and under session_replication_role = replica.
 *  M7  registries: RLS_REGISTRY (org_column), CUTOVER_CLASSIFICATION (purge) with PURGE_ORDER_HINT order (link before the charge and the settlement; charge before the
 *      other line, upload, channel and journal entry), TRIGGER_REGISTRY (always / history_guard).
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { seedChartOfAccounts } from '../../seed/chart-of-accounts';
import { CUTOVER_CLASSIFICATION, PURGE_ORDER_HINT } from '../../src/cutover/classification';
import { APP_ROLE, RLS_REGISTRY } from '../../src/rls/registry';
import { TRIGGER_REGISTRY } from '../../src/triggers/registry';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const CHARGES = 'channel_period_charges';
const LINKS = 'channel_settlement_charge_links';
const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_IDX = 244;
const TARGET_WHEN = 1807155107084;

type PgErr = Error & { code?: string; constraint_name?: string };
type Tx = postgres.TransactionSql;
type Row = Record<string, string | number | boolean | null>;
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const CHECK = '23514';
const UNIQUE = '23505';
const FK = '23503';
const NOPRIV = '42501';
const RESTRICT = '23001';

class Rollback extends Error {}
type Outcome<T> = { ok: true; value: T } | { ok: false; err: PgErr };
async function run<T>(fn: (tx: Tx) => Promise<T>): Promise<Outcome<T>> {
  let value: T | undefined;
  try {
    await sql.begin(async (tx) => {
      value = await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    if (e instanceof Rollback) return { ok: true, value: value as T };
    return { ok: false, err: e as PgErr };
  }
  return { ok: true, value: value as T };
}
async function runAsApp<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<Outcome<T>> {
  return run(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.principal_kind', 'staff', true)`;
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  });
}
function expectCode(o: Outcome<unknown>, code: string, what: string): PgErr {
  if (o.ok) throw new Error(`${what}: expected SQLSTATE ${code} but the statement succeeded`);
  expect(o.err.code, `${what}: expected ${code}, got ${o.err.code} (${o.err.message})`).toBe(code);
  return o.err;
}
function expectOk(o: Outcome<unknown>, what: string): void {
  if (!o.ok) throw new Error(`${what}: expected success but got ${o.err.code}: ${o.err.message}`);
}
const insert = async (tx: Tx, table: string, row: Row): Promise<string> => {
  const [r] = await tx<{ id: string }[]>`insert into ${tx(table)} ${tx(row as never)} returning id`;
  return r!.id;
};

// ---------------------------------------------------------------------------------------------------------------------
// fixtures: two orgs, each with two stores, a person, a Foodpanda channel of store 1, an upload, a bank account and a settlement factory (all committed)
// ---------------------------------------------------------------------------------------------------------------------

interface Side {
  orgId: string; s1: string; s2: string; person: string; channel: string; upload: string; bank: string; day: string;
  /** a fresh staged period charge (kind period_charge, VAT 12.00 on 100.00) on the side's upload */
  otherLine: (over?: Row) => Promise<string>;
  /** a fresh draft journal entry */
  newEntry: () => Promise<string>;
  /** a fresh draft channel settlement of the side's channel */
  settlement: () => Promise<string>;
  /** a fresh well-formed charge row (new other line, new entry) */
  chargeRow: (over?: Row) => Promise<Row>;
  /** a fresh committed charge row */
  committedCharge: () => Promise<string>;
}
let baseP: Promise<{ A: Side; B: Side }> | null = null;
const base = () => (baseP ??= (async () => ({ A: await side('A'), B: await side('B') }))());

async function side(tag: string): Promise<Side> {
  const code = uid(`t511s6c-${tag}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [s1] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S1')}, 'Lipa') returning id`;
  const [s2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S2')}, 'Malvar') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('Admin')}) returning id`;
  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active) values (${orgId}, ${s1!.id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code, destination_money_account_id)
    values (${orgId}, ${s1!.id}, ${uid('Foodpanda')}, false, '1220', 'foodpanda', ${uid('FP')}, ${bank!.id}) returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${s1!.id}, '2026-10-12', '0', '0', '0', ${p!.id}) returning id`;
  const [period] = await sql<{ id: string }[]>`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-10-01', '2026-10-31', 'open') returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${s1!.id}, 'memo_document', ${`orgs/${orgId}/stores/${s1!.id}/memo_document/${uid('f')}.pdf`}, 'application/pdf', 10, 'abc', ${p!.id}) returning id`;
  const [up] = await sql<{ id: string }[]>`
    insert into settlement_uploads (org_id, channel_id, store_id, platform, file_kind, file_id, fingerprint, reader_version, uploaded_by)
    values (${orgId}, ${ch!.id}, ${s1!.id}, 'foodpanda', 'foodpanda_invoice', ${file!.id}, ${uid('fp')}, '1', ${p!.id}) returning id`;
  const newEntry = (): Promise<string> =>
    sql.begin(async (t) => {
      const [e] = await t<{ id: string }[]>`
        insert into journal_entries (org_id, period_id, entry_date, source_type, source_id, idempotency_key, memo, status)
        values (${orgId}, ${period!.id}, '2026-10-12', 'channel_charge', ${uid('src')}, ${uid('idem')}, 'charge probe', 'draft') returning id`;
      const acct = async (c: string) => (await t<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${c}`)[0]!.id;
      await t`insert into journal_lines (entry_id, account_id, line_no, debit, credit) values (${e!.id}, ${await acct('6400')}, 1, 1, 0)`;
      await t`insert into journal_lines (entry_id, account_id, line_no, debit, credit, party_type, party_id) values (${e!.id}, ${await acct('1220')}, 2, 0, 1, 'channel', ${ch!.id})`;
      return e!.id;
    });
  const otherLine = async (over: Row = {}): Promise<string> =>
    insert(sql as unknown as Tx, 'settlement_other_lines', {
      org_id: orgId, upload_id: up!.id, kind: 'period_charge', booked_as: 'none', amount: '100.00', line_date: '2026-10-12', description: 'Platform Fee', vat_amount: '12.00', ...over,
    });
  const settlement = async (): Promise<string> =>
    (await sql<{ id: string }[]>`
      insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, settled_on, created_by)
      values (${orgId}, ${s1!.id}, ${ch!.id}, ${day!.id}, '2026-10-12', '0', '0', '0', ${bank!.id}, '2026-10-12', ${p!.id}) returning id`)[0]!.id;
  const chargeRow = async (over: Row = {}): Promise<Row> => ({
    org_id: orgId, store_id: s1!.id, channel_id: ch!.id, other_line_id: await otherLine(), upload_id: up!.id, charge_date: '2026-10-12', net_amount: '100.00', vat_amount: '12.00',
    total_amount: '112.00', entry_date: '2026-10-12', journal_entry_id: await newEntry(), description: 'Platform Fee', posted_by: p!.id, ...over,
  });
  const committedCharge = async (): Promise<string> => sql.begin(async (tx) => insert(tx, CHARGES, await chargeRow()));
  return { orgId, s1: s1!.id, s2: s2!.id, person: p!.id, channel: ch!.id, upload: up!.id, bank: bank!.id, day: day!.id, otherLine, newEntry, settlement, chargeRow, committedCharge };
}

// ---------------------------------------------------------------------------------------------------------------------
// M1. the file and the journal
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6c / 0244 - the migration file and its journal entry', () => {
  it('a 0244_*.sql file exists naming t511 and is journalled as idx 244, when 1807155107084, breakpoints true, after every earlier entry [kills: wrong number / when; a when that sorts before an applied migration; a file the journal does not name]', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^0244_.*\.sql$/.test(f));
    expect(files, 'exactly one packages/db/migrations/0244_*.sql').toHaveLength(1);
    const tag = files[0]!.replace(/\.sql$/, '');
    expect(tag).toMatch(/t511/);
    expect(existsSync(join(MIGRATIONS, `${tag}.sql`))).toBe(true);
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
    const e = journal.entries.find((x) => x.idx === TARGET_IDX);
    expect(e, `no journal entry with idx ${TARGET_IDX}`).toBeDefined();
    expect(e).toEqual({ idx: TARGET_IDX, version: '7', when: TARGET_WHEN, tag, breakpoints: true });
    const earlier = journal.entries.filter((x) => x.idx < TARGET_IDX);
    expect(Math.max(...earlier.map((x) => x.when)), 'the new when is the latest so far').toBeLessThan(TARGET_WHEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M2. settlement_other_lines.vat_amount
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6c / 0244 - settlement_other_lines.vat_amount (Design A)', () => {
  it('the column is numeric(14,2), NULL allowed, no default: a line staged before S6c keeps NULL (refused for booking, never read as zero) [kills: NOT NULL (the old rows break the migration); a default 0 (an old line would book with no VAT)]', async () => {
    const [c] = await sql<{ typ: string; notnull: boolean; hasdef: boolean }[]>`
      select format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as notnull, a.atthasdef as hasdef
        from pg_attribute a where a.attrelid = 'public.settlement_other_lines'::regclass and a.attname = 'vat_amount' and not a.attisdropped`;
    expect(c, 'settlement_other_lines.vat_amount exists').toBeDefined();
    expect(c).toEqual({ typ: 'numeric(14,2)', notnull: false, hasdef: false });
  });

  it('control: a period line with VAT 12.00, with VAT 0.00 and with no VAT at all is accepted [kills: a CHECK that refuses NULL or zero]', async () => {
    const { A } = await base();
    expectOk(await run(async (tx) => { await insert(tx, 'settlement_other_lines', { org_id: A.orgId, upload_id: A.upload, kind: 'period_charge', booked_as: 'none', amount: '100.00', vat_amount: '12.00' }); }), 'VAT 12.00');
    expectOk(await run(async (tx) => { await insert(tx, 'settlement_other_lines', { org_id: A.orgId, upload_id: A.upload, kind: 'period_charge', booked_as: 'none', amount: '100.00', vat_amount: '0.00' }); }), 'VAT 0.00');
    expectOk(await run(async (tx) => { await insert(tx, 'settlement_other_lines', { org_id: A.orgId, upload_id: A.upload, kind: 'period_charge', booked_as: 'none', amount: '100.00' }); }), 'no VAT column');
  });

  it('the VAT must be finite: NaN is refused (23514) [kills: no finite check (NaN sorts above every number); house rule for a money column]', async () => {
    const { A } = await base();
    const o = await run((tx) => tx`
      insert into settlement_other_lines (org_id, upload_id, kind, booked_as, amount, vat_amount) values (${A.orgId}, ${A.upload}, 'period_charge', 'none', '100.00', 'NaN'::numeric)`);
    expectCode(o, CHECK, 'vat_amount NaN');
  });

  it('a platform credit note has a NEGATIVE net and a negative VAT: -12.00 is accepted (spec ruling 3: the CHECK is finite only, not >= 0) [kills: a >= 0 check that refuses the staged VAT of a credit note]', async () => {
    const { A } = await base();
    expectOk(await run(async (tx) => { await insert(tx, 'settlement_other_lines', { org_id: A.orgId, upload_id: A.upload, kind: 'period_charge', booked_as: 'none', amount: '-100.00', vat_amount: '-12.00' }); }), 'vat_amount -12.00');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M3. channel_period_charges: shape, constraints, FKs
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6c / 0244 - channel_period_charges: shape and constraints', () => {
  it('has the pinned columns; every one NOT NULL except description; the three amounts numeric(14,2); both dates date; posted_at timestamptz with a default [kills: nullable ids; a float amount; text dates]', async () => {
    const cols = await sql<{ attname: string; typ: string; notnull: boolean; hasdef: boolean }[]>`
      select a.attname, format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as notnull, a.atthasdef as hasdef
        from pg_attribute a where a.attrelid = ${`public.${CHARGES}`}::regclass and a.attnum > 0 and not a.attisdropped`;
    const by = new Map(cols.map((c) => [c.attname, c]));
    expect([...by.keys()].sort()).toEqual(
      ['channel_id', 'charge_date', 'description', 'entry_date', 'id', 'journal_entry_id', 'net_amount', 'org_id', 'other_line_id', 'posted_at', 'posted_by', 'store_id', 'total_amount', 'upload_id', 'vat_amount'],
    );
    for (const n of ['id', 'org_id', 'store_id', 'channel_id', 'other_line_id', 'upload_id', 'journal_entry_id', 'posted_by']) expect(by.get(n), n).toMatchObject({ typ: 'uuid', notnull: true });
    for (const n of ['net_amount', 'vat_amount', 'total_amount']) expect(by.get(n), n).toMatchObject({ typ: 'numeric(14,2)', notnull: true });
    for (const n of ['charge_date', 'entry_date']) expect(by.get(n), n).toMatchObject({ typ: 'date', notnull: true });
    expect(by.get('description')).toMatchObject({ typ: 'text', notnull: false });
    expect(by.get('posted_at')).toMatchObject({ typ: 'timestamp with time zone', notnull: true, hasdef: true });
  });

  it('a well-formed row is accepted (control for every refusal below)', async () => {
    const { A } = await base();
    expectOk(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow())), 'a well-formed charge');
  });

  it('a negative (credit note) charge is accepted: net -100.00 + VAT -12.00 = total -112.00 [kills: a total_amount > 0 check; the platform credit note the spec allows]', async () => {
    const { A } = await base();
    expectOk(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ net_amount: '-100.00', vat_amount: '-12.00', total_amount: '-112.00' }))), 'a credit-note charge row');
  });

  it('(org_id, other_line_id) is unique: one posting per staged line (23505); another line is fine [kills: no unique (the double booking of one charge)]', async () => {
    const { A } = await base();
    const ol = await A.otherLine();
    expectCode(
      await run(async (tx) => {
        await insert(tx, CHARGES, await A.chargeRow({ other_line_id: ol }));
        await insert(tx, CHARGES, await A.chargeRow({ other_line_id: ol }));
      }),
      UNIQUE,
      'the same other line twice',
    );
    expectOk(await run(async (tx) => { await insert(tx, CHARGES, await A.chargeRow()); await insert(tx, CHARGES, await A.chargeRow()); }), 'two different lines');
  });

  it('(org_id, journal_entry_id) is unique: one entry backs one charge (23505) [kills: two charges claiming one entry]', async () => {
    const { A } = await base();
    const e = await A.newEntry();
    expectCode(
      await run(async (tx) => {
        await insert(tx, CHARGES, await A.chargeRow({ journal_entry_id: e }));
        await insert(tx, CHARGES, await A.chargeRow({ journal_entry_id: e }));
      }),
      UNIQUE,
      'one entry, two charges',
    );
  });

  it('total_amount must not be zero (23514) [kills: a charge that books nothing]', async () => {
    const { A } = await base();
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ net_amount: '0.00', vat_amount: '0.00', total_amount: '0.00' }))), CHECK, 'total 0.00');
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ net_amount: '100.00', vat_amount: '-100.00', total_amount: '0.00' }))), CHECK, 'total 0.00 from 100 - 100');
  });

  it('total_amount must equal net_amount + vat_amount to the centavo (23514), either way off [kills: no identity check; a tolerance; a total that drifts from its parts]', async () => {
    const { A } = await base();
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ total_amount: '113.00' }))), CHECK, 'total 113.00 for 100 + 12');
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ total_amount: '111.99' }))), CHECK, 'total 111.99 for 100 + 12');
    expectOk(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ net_amount: '0.07', vat_amount: '0.01', total_amount: '0.08' }))), 'cents: 0.07 + 0.01 = 0.08');
  });

  it('HOUSE RULE (not in the spec text): the amounts are finite: all three NaN (NaN = NaN + NaN holds in Postgres, so only a finite check refuses it) is refused (23514) [kills: no finite check; ADR-012 s5 / t327]', async () => {
    const { A } = await base();
    const r = await A.chargeRow();
    const o = await run((tx) => tx`
      insert into channel_period_charges (org_id, store_id, channel_id, other_line_id, upload_id, charge_date, net_amount, vat_amount, total_amount, entry_date, journal_entry_id, posted_by)
      values (${A.orgId}, ${A.s1}, ${A.channel}, ${r.other_line_id as string}, ${A.upload}, '2026-10-12', 'NaN'::numeric, 'NaN'::numeric, 'NaN'::numeric, '2026-10-12', ${r.journal_entry_id as string}, ${A.person})`);
    expectCode(o, CHECK, 'NaN amounts');
  });

  it('every foreign key is a composite starting with org_id (never a bare FK); channel AND store are ONE constraint onto sales_channels; upload, other line, journal entry and poster each have their own, ON DELETE RESTRICT [kills: a bare FK; a store FK that lets a charge name another store than its channel; CASCADE]', async () => {
    const rows = await sql<{ con: string; cols: string[]; ref: string; del: string }[]>`
      select con.conname as con,
             (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
             con.confrelid::regclass::text as ref, con.confdeltype as del
        from pg_constraint con where con.conrelid = ${`public.${CHARGES}`}::regclass and con.contype = 'f'`;
    const bad = rows.filter((r) => !(r.cols[0] === 'org_id' && (r.cols.length >= 2 || /organizations$/.test(r.ref)))).map((r) => r.con);
    expect(bad, 'FKs that are neither org -> organizations nor composite starting with org_id').toEqual([]);
    const composite = rows.filter((r) => r.cols.length >= 2);
    const channel = composite.find((x) => /sales_channels$/.test(x.ref));
    expect(channel, 'a composite FK onto sales_channels').toBeDefined();
    expect(channel!.cols, 'the channel FK covers the store too').toEqual(expect.arrayContaining(['org_id', 'channel_id', 'store_id']));
    const wanted: [string, RegExp][] = [['upload_id', /settlement_uploads$/], ['other_line_id', /settlement_other_lines$/], ['journal_entry_id', /journal_entries$/], ['posted_by', /persons$/]];
    for (const [col, ref] of wanted) {
      const r = composite.find((x) => x.cols.includes(col) && ref.test(x.ref));
      expect(r, `a composite same-org FK covering ${col} onto ${ref}`).toBeDefined();
    }
    for (const r of rows) expect(r.del, `${r.con} ON DELETE`).toBe('r');
  });

  it('a charge of org A naming an other line, upload, channel, entry or person of org B is refused (23503); so is a store that is not the channel\'s store [kills: a missing twin FK; a store free of its channel]', async () => {
    const { A, B } = await base();
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ other_line_id: await B.otherLine() }))), FK, 'other line of another org');
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ upload_id: B.upload }))), FK, 'upload of another org');
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ channel_id: B.channel }))), FK, 'channel of another org');
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ journal_entry_id: await B.newEntry() }))), FK, 'entry of another org');
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ posted_by: B.person }))), FK, 'person of another org');
    expectCode(await run(async (tx) => insert(tx, CHARGES, await A.chargeRow({ store_id: A.s2 }))), FK, 'a store that is not the channel\'s own');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M4. channel_settlement_charge_links
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6c / 0244 - channel_settlement_charge_links: which charges a payout netted', () => {
  const linkRow = (o: Side, settlementId: string, chargeId: string, over: Row = {}): Row => ({ org_id: o.orgId, settlement_id: settlementId, charge_id: chargeId, ...over });

  it('has org_id, settlement_id and charge_id, and its primary key is exactly (org_id, settlement_id, charge_id) [kills: a surrogate-only key that allows the same charge twice on one settlement]', async () => {
    const cols = await sql<{ attname: string; typ: string; notnull: boolean }[]>`
      select a.attname, format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as notnull
        from pg_attribute a where a.attrelid = ${`public.${LINKS}`}::regclass and a.attnum > 0 and not a.attisdropped`;
    const by = new Map(cols.map((c) => [c.attname, c]));
    for (const n of ['org_id', 'settlement_id', 'charge_id']) expect(by.get(n), n).toMatchObject({ typ: 'uuid', notnull: true });
    const [pk] = await sql<{ cols: string[] }[]>`
      select (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols
        from pg_constraint con where con.conrelid = ${`public.${LINKS}`}::regclass and con.contype = 'p'`;
    expect(pk?.cols).toEqual(['org_id', 'settlement_id', 'charge_id']);
  });

  it('a well-formed link is accepted; the same (settlement, charge) twice is refused (23505) [kills: no primary key]', async () => {
    const { A } = await base();
    const s = await A.settlement();
    const c = await A.committedCharge();
    expectOk(await run(async (tx) => { await tx`insert into ${tx(LINKS)} ${tx(linkRow(A, s, c) as never)}`; }), 'a link');
    expectCode(await run(async (tx) => { await tx`insert into ${tx(LINKS)} ${tx(linkRow(A, s, c) as never)}`; await tx`insert into ${tx(LINKS)} ${tx(linkRow(A, s, c) as never)}`; }), UNIQUE, 'the same link twice');
  });

  it('one charge may be linked to two settlements (a void frees it: the first link stays as history) [kills: a unique on the charge alone, which would make a voided settlement keep the charge forever]', async () => {
    const { A } = await base();
    const c = await A.committedCharge();
    const s1 = await A.settlement();
    const s2 = await A.settlement();
    expectOk(
      await run(async (tx) => {
        await tx`insert into ${tx(LINKS)} ${tx(linkRow(A, s1, c) as never)}`;
        await tx`insert into ${tx(LINKS)} ${tx(linkRow(A, s2, c) as never)}`;
      }),
      'one charge, two settlements',
    );
  });

  it('every foreign key is composite starting with org_id and ON DELETE RESTRICT: the settlement and the charge each have one [kills: a bare FK; a missing twin; CASCADE]', async () => {
    const rows = await sql<{ con: string; cols: string[]; ref: string; del: string }[]>`
      select con.conname as con,
             (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
             con.confrelid::regclass::text as ref, con.confdeltype as del
        from pg_constraint con where con.conrelid = ${`public.${LINKS}`}::regclass and con.contype = 'f'`;
    const bad = rows.filter((r) => !(r.cols[0] === 'org_id' && (r.cols.length >= 2 || /organizations$/.test(r.ref)))).map((r) => r.con);
    expect(bad).toEqual([]);
    const composite = rows.filter((r) => r.cols.length >= 2);
    for (const [col, ref] of [['settlement_id', /channel_settlements$/], ['charge_id', /channel_period_charges$/]] as [string, RegExp][]) {
      expect(composite.find((x) => x.cols.includes(col) && ref.test(x.ref)), `a composite same-org FK covering ${col} onto ${ref}`).toBeDefined();
    }
    for (const r of rows) expect(r.del, `${r.con} ON DELETE`).toBe('r');
  });

  it('a link of org A naming a settlement or a charge of org B is refused (23503) [kills: a missing twin FK]', async () => {
    const { A, B } = await base();
    expectCode(await run(async (tx) => { await tx`insert into ${tx(LINKS)} ${tx(linkRow(A, await B.settlement(), await A.committedCharge()) as never)}`; }), FK, 'settlement of another org');
    expectCode(await run(async (tx) => { await tx`insert into ${tx(LINKS)} ${tx(linkRow(A, await A.settlement(), await B.committedCharge()) as never)}`; }), FK, 'charge of another org');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M5. RLS and grants, both tables
// ---------------------------------------------------------------------------------------------------------------------

describe.each([CHARGES, LINKS])('T-511 S6c / 0244 - RLS and grants of %s (history)', (TABLE) => {
  it('ENABLE and FORCE ROW LEVEL SECURITY, one policy <table>_org_isolation on app_current_org() in both USING and WITH CHECK [kills: RLS without FORCE; no WITH CHECK; raw current_setting; wrong name]', async () => {
    const [c] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`select relrowsecurity, relforcerowsecurity from pg_class where oid = ${`public.${TABLE}`}::regclass`;
    expect(c).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await sql<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = ${TABLE}`;
    expect(p.map((x) => x.policyname)).toEqual([`${TABLE}_org_isolation`]);
    expect(p[0]!.cmd).toBe('ALL');
    expect(p[0]!.qual ?? '').toMatch(/app_current_org\(\)/);
    expect(p[0]!.qual ?? '').toMatch(/org_id/);
    expect(p[0]!.with_check ?? '').toMatch(/app_current_org\(\)/);
    expect(p[0]!.qual ?? '').not.toMatch(/current_setting/);
  });

  it('table privileges for the app role: SELECT and INSERT yes; UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER no, and no column is updatable [kills: GRANT ALL; a column-level UPDATE grant]', async () => {
    const t = `public.${TABLE}`;
    const [r] = await sql<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean; ref: boolean; trig: boolean }[]>`
      select has_table_privilege(${APP_ROLE}, ${t}, 'SELECT') as sel, has_table_privilege(${APP_ROLE}, ${t}, 'INSERT') as ins,
             has_table_privilege(${APP_ROLE}, ${t}, 'UPDATE') as upd, has_table_privilege(${APP_ROLE}, ${t}, 'DELETE') as del,
             has_table_privilege(${APP_ROLE}, ${t}, 'TRUNCATE') as trunc, has_table_privilege(${APP_ROLE}, ${t}, 'REFERENCES') as ref,
             has_table_privilege(${APP_ROLE}, ${t}, 'TRIGGER') as trig`;
    expect(r).toEqual({ sel: true, ins: true, upd: false, del: false, trunc: false, ref: false, trig: false });
    const cols = await sql<{ attname: string }[]>`select attname from pg_attribute where attrelid = ${t}::regclass and attnum > 0 and not attisdropped`;
    for (const c of cols) {
      const [u] = await sql<{ ok: boolean }[]>`select has_column_privilege(${APP_ROLE}, ${t}, ${c.attname}, 'UPDATE') as ok`;
      expect(u!.ok, `UPDATE on ${c.attname}`).toBe(false);
    }
  });
});

describe('T-511 S6c / 0244 - org isolation under the app role', () => {
  it('charges: org B sees none of org A rows and cannot INSERT one stamped org A (42501); control: org A inserts its own [kills: no policy; no WITH CHECK; policy on the wrong column]', async () => {
    const { A, B } = await base();
    await A.committedCharge();
    const seen = await runAsApp(B.orgId, (tx) => tx<{ n: string }[]>`select count(*)::text as n from ${tx(CHARGES)} where org_id = ${A.orgId}`);
    expectOk(seen, 'org B select');
    if (seen.ok) expect(seen.value[0]!.n).toBe('0');
    expectCode(await runAsApp(B.orgId, async (tx) => insert(tx, CHARGES, await A.chargeRow())), NOPRIV, 'org B inserts a row stamped org A');
    expectOk(await runAsApp(A.orgId, async (tx) => insert(tx, CHARGES, await A.chargeRow())), 'org A inserts its own charge');
  });

  it('links: org B sees none of org A rows and cannot INSERT one stamped org A (42501); control: org A inserts its own [kills: no policy; no WITH CHECK]', async () => {
    const { A, B } = await base();
    const s = await A.settlement();
    const c = await A.committedCharge();
    await sql`insert into ${sql(LINKS)} (org_id, settlement_id, charge_id) values (${A.orgId}, ${s}, ${c})`;
    const seen = await runAsApp(B.orgId, (tx) => tx<{ n: string }[]>`select count(*)::text as n from ${tx(LINKS)} where org_id = ${A.orgId}`);
    expectOk(seen, 'org B select');
    if (seen.ok) expect(seen.value[0]!.n).toBe('0');
    expectCode(await runAsApp(B.orgId, async (tx) => { await tx`insert into ${tx(LINKS)} (org_id, settlement_id, charge_id) values (${A.orgId}, ${await A.settlement()}, ${await A.committedCharge()})`; }), NOPRIV, 'org B inserts a link stamped org A');
    expectOk(await runAsApp(A.orgId, async (tx) => { await tx`insert into ${tx(LINKS)} (org_id, settlement_id, charge_id) values (${A.orgId}, ${await A.settlement()}, ${await A.committedCharge()})`; }), 'org A inserts its own link');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M6. append-only, both tables
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6c / 0244 - a charge and a link are never changed or removed', () => {
  async function committedCharge() {
    const { A } = await base();
    const id = await A.committedCharge();
    return { A, id };
  }
  async function committedLink() {
    const { A } = await base();
    const s = await A.settlement();
    const c = await A.committedCharge();
    await sql`insert into ${sql(LINKS)} (org_id, settlement_id, charge_id) values (${A.orgId}, ${s}, ${c})`;
    return { A, s, c };
  }

  it('charges: the owner cannot UPDATE or DELETE a row: the trigger refuses with 23001 and the row is unchanged [kills: no guard; a guard on DELETE only]', async () => {
    const { id } = await committedCharge();
    expectCode(await run((tx) => tx`update ${tx(CHARGES)} set description = 'edited' where id = ${id}`), RESTRICT, 'UPDATE as the owner');
    expectCode(await run((tx) => tx`delete from ${tx(CHARGES)} where id = ${id}`), RESTRICT, 'DELETE as the owner');
    const [row] = await sql<{ description: string }[]>`select description from ${sql(CHARGES)} where id = ${id}`;
    expect(row!.description).toBe('Platform Fee');
  });

  it('charges: session_replication_role = replica does not switch it off: the trigger is ENABLE ALWAYS (tgenabled A) [kills: an origin trigger a bulk load could bypass]', async () => {
    const { id } = await committedCharge();
    for (const stmt of ['update', 'delete'] as const) {
      const o = await run(async (tx) => {
        await tx.unsafe('set local session_replication_role = replica');
        if (stmt === 'update') await tx`update ${tx(CHARGES)} set net_amount = '1.00' where id = ${id}`;
        else await tx`delete from ${tx(CHARGES)} where id = ${id}`;
      });
      expectCode(o, RESTRICT, `${stmt} under replica`);
    }
    const [t] = await sql<{ tgenabled: string }[]>`select tgenabled from pg_trigger where tgrelid = ${`public.${CHARGES}`}::regclass and tgname = ${`${CHARGES}_append_only`}`;
    expect(t?.tgenabled).toBe('A');
  });

  it('charges: the app role has no UPDATE or DELETE privilege at all (42501): the trigger is the second wall [kills: UPDATE granted back]', async () => {
    const { A, id } = await committedCharge();
    expectCode(await runAsApp(A.orgId, (tx) => tx`update ${tx(CHARGES)} set description = 'edited' where id = ${id}`), NOPRIV, 'UPDATE as the app role');
    expectCode(await runAsApp(A.orgId, (tx) => tx`delete from ${tx(CHARGES)} where id = ${id}`), NOPRIV, 'DELETE as the app role');
  });

  it('links: the owner cannot UPDATE or DELETE a row (23001), also under replica; the trigger is ENABLE ALWAYS [kills: no guard; an origin trigger a bulk load could bypass]', async () => {
    const { A, s, c } = await committedLink();
    expectCode(await run((tx) => tx`delete from ${tx(LINKS)} where org_id = ${A.orgId} and settlement_id = ${s} and charge_id = ${c}`), RESTRICT, 'DELETE as the owner');
    expectCode(await run(async (tx) => { await tx`update ${tx(LINKS)} set charge_id = ${await A.committedCharge()} where org_id = ${A.orgId} and settlement_id = ${s} and charge_id = ${c}`; }), RESTRICT, 'UPDATE as the owner');
    expectCode(
      await run(async (tx) => {
        await tx.unsafe('set local session_replication_role = replica');
        await tx`delete from ${tx(LINKS)} where org_id = ${A.orgId} and settlement_id = ${s} and charge_id = ${c}`;
      }),
      RESTRICT,
      'DELETE under replica',
    );
    const [t] = await sql<{ tgenabled: string }[]>`select tgenabled from pg_trigger where tgrelid = ${`public.${LINKS}`}::regclass and tgname = ${`${LINKS}_append_only`}`;
    expect(t?.tgenabled).toBe('A');
  });

  it('links: the app role has no UPDATE or DELETE privilege at all (42501) [kills: UPDATE granted back]', async () => {
    const { A, s, c } = await committedLink();
    expectCode(await runAsApp(A.orgId, (tx) => tx`delete from ${tx(LINKS)} where org_id = ${A.orgId} and settlement_id = ${s} and charge_id = ${c}`), NOPRIV, 'DELETE as the app role');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M7. registries
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6c / 0244 - the registries know the new tables and guards', () => {
  it('RLS_REGISTRY carries both tables with scope org_column [kills: a table the RLS guard does not know]', () => {
    for (const t of [CHARGES, LINKS]) {
      expect(RLS_REGISTRY[t], `RLS_REGISTRY.${t}`).toBeDefined();
      expect(RLS_REGISTRY[t]?.scope).toBe('org_column');
    }
  });

  it('CUTOVER_CLASSIFICATION classes both purge, and the purge hint lists each before every table it cites [kills: an unclassified table; a purge that deletes a parent first]', () => {
    for (const t of [CHARGES, LINKS]) {
      expect(CUTOVER_CLASSIFICATION[t], `CUTOVER_CLASSIFICATION.${t}`).toBeDefined();
      expect(CUTOVER_CLASSIFICATION[t]?.class).toBe('purge');
      expect(PURGE_ORDER_HINT.indexOf(t), `${t} must be listed in PURGE_ORDER_HINT`).toBeGreaterThanOrEqual(0);
    }
    const at = (t: string) => PURGE_ORDER_HINT.indexOf(t);
    for (const parent of ['settlement_other_lines', 'settlement_uploads', 'sales_channels', 'journal_entries', 'persons', 'stores']) {
      if (at(parent) >= 0) expect(at(CHARGES), `${CHARGES} before ${parent}`).toBeLessThan(at(parent));
    }
    for (const parent of [CHARGES, 'channel_settlements']) expect(at(LINKS), `${LINKS} before ${parent}`).toBeLessThan(at(parent));
  });

  it('both append-only guards are in TRIGGER_REGISTRY as always / history_guard on their own table [kills: an unclassified trigger (the T-354 guard); a guard classed as a validator]', () => {
    expect(TRIGGER_REGISTRY[`${CHARGES}_append_only`]).toMatchObject({ table: CHARGES, mode: 'always', kind: 'history_guard' });
    expect(TRIGGER_REGISTRY[`${LINKS}_append_only`]).toMatchObject({ table: LINKS, mode: 'always', kind: 'history_guard' });
  });
});
