/**
 * T-511 S6b (TESTER, 7 Nov 2026) - migration 0243 `0243_t511_platform_sales_corrections`: the append-only record of a platform sales correction, and the dual-run
 * class `PLATFORM_FILE_CORRECTION`. docs/tasks/511-settlement-upload-s6-spec.md "S6b" (migration bullet). Real Postgres via TEST_DATABASE_URL.
 *
 * RED TODAY, for one reason: migration 0243 does not exist, so the table, its guard, its policies, its registry entries and the widened class check are all absent.
 *
 * PINNED BY THESE TESTS (the builder meets them or asks BOSS to change the tests):
 *  M1  file `0243_t511_platform_sales_corrections.sql`, journal idx 243, `when` 1807068707084 (0242's 1806982307084 + 86,400,000), breakpoints true. The spec calls
 *      the number provisional: if BOSS gives another, change the constants below, nothing else.
 *  M2  table `sales_day_platform_corrections(id, org_id, store_id, sales_day_id, channel_id, day_line_id, from_amount numeric(14,2), to_amount numeric(14,2),
 *      entry_date date, journal_entry_id, reason text, posted_by, posted_at timestamptz)`, every one NOT NULL. `from_amount` is the figure the books held (staff +
 *      earlier corrections), `to_amount` the file figure. (The spec says "from/to figures"; these names are the tester's.)
 *  M3  unique (org_id, day_line_id); `reason` non-blank (23514); both amounts finite (23514, house rule for a money column).
 *  M4  composite same-org FKs (org_id, x) for store, sales day, channel, staged day line, journal entry and poster, all ON DELETE RESTRICT.
 *  M5  RLS ENABLE + FORCE, policy `sales_day_platform_corrections_org_isolation` on app_current_org() in USING and WITH CHECK; the app role has SELECT and INSERT only.
 *  M6  `sales_day_platform_corrections_append_only`: BEFORE UPDATE OR DELETE refuse trigger, ENABLE ALWAYS (history_guard in the registry): the owner is refused
 *      with 23001, also under session_replication_role = replica.
 *  M7  registries: RLS_REGISTRY (org_column), CUTOVER_CLASSIFICATION (purge, listed before the tables it cites), TRIGGER_REGISTRY (always / history_guard).
 *  M8  `dual_run_lines_class_check` holds exactly the 23 old codes plus `PLATFORM_FILE_CORRECTION`.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
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
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const TABLE = 'sales_day_platform_corrections';
const TRIGGER = 'sales_day_platform_corrections_append_only';
const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_IDX = 243;
const TARGET_TAG = '0243_t511_platform_sales_corrections';
const TARGET_WHEN = 1807068707084;
const NEW_CLASS = 'PLATFORM_FILE_CORRECTION';
const OLD_CLASSES = [
  'TIES', 'INVENTORY_BASIS', 'PAYROLL_ON_V1', 'NOT_IN_DUAL_RUN_SCOPE', 'V2_ONLY_EVENT', 'V1_CASH_RESIDUAL', 'AP_AT_INVOICE',
  'SUPPLIER_ADVANCE_1240', 'V2_CORRECTION_DATED_LATER', 'CHANNEL_AR_FLOW', 'PENDING_V2', 'PENDING_V1', 'DATE_SHIFT',
  'NOT_DOUBLE_ENTERED', 'KEYING_DIFFERENCE', 'MISCLASSIFIED', 'UNMAPPED_KEY', 'V1_DEFECT', 'V2_DEFECT', 'UNEXPLAINED',
  'V1_REMITTED_FIELD_ZERO', 'V1_UNKNOWN_EXPENSE_GROUP', 'V1_EXPENSE_ENTRY_GROUP_CONFLICT',
];

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
// fixtures: two orgs, each with a store, a person, a channel, a verified-looking sales day, a staged day line and a journal entry (all committed)
// ---------------------------------------------------------------------------------------------------------------------

interface Side {
  orgId: string; s1: string; s2: string; person: string; channel: string; day: string; entry: string;
  /** a second sales day of the same store (another date), to hold a correction of the same line */
  day2: string;
  /** a fresh staged day line for each correction (the unique is per line); it also makes the line's own journal entry (the unique is per entry) */
  line: () => Promise<string>;
  /** a fresh draft journal entry */
  newEntry: () => Promise<string>;
  /** the entry made for a line by `line()` */
  entryOf: Map<string, string>;
}
let baseP: Promise<{ A: Side; B: Side }> | null = null;
const base = () => (baseP ??= (async () => ({ A: await side('A'), B: await side('B') }))());

async function side(tag: string): Promise<Side> {
  const code = uid(`t511s6b-${tag}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [s1] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S1')}, 'Lipa') returning id`;
  const [s2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S2')}, 'Malvar') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('Admin')}) returning id`;
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code)
    values (${orgId}, ${s1!.id}, ${uid('Foodpanda')}, false, '1220', 'foodpanda', ${uid('FP')}) returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${s1!.id}, '2026-10-12', '0', '0', '0', ${p!.id}) returning id`;
  const [day2] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${s1!.id}, '2026-10-13', '0', '0', '0', ${p!.id}) returning id`;
  const [period] = await sql<{ id: string }[]>`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-10-01', '2026-10-31', 'open') returning id`;
  const newEntry = (): Promise<string> =>
    sql.begin(async (t) => {
      const [e] = await t<{ id: string }[]>`
        insert into journal_entries (org_id, period_id, entry_date, source_type, source_id, idempotency_key, memo, status)
        values (${orgId}, ${period!.id}, '2026-10-12', 'sale', ${uid('src')}, ${uid('idem')}, 'correction probe', 'draft') returning id`;
      const acct = async (c: string) => (await t<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${c}`)[0]!.id;
      await t`insert into journal_lines (entry_id, account_id, line_no, debit, credit) values (${e!.id}, ${await acct('6400')}, 1, 1, 0), (${e!.id}, ${await acct('4150')}, 2, 0, 1)`;
      return e!.id;
    });
  const entry = await newEntry();
  const entryOf = new Map<string, string>();
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${s1!.id}, 'memo_document', ${`orgs/${orgId}/stores/${s1!.id}/memo_document/${uid('f')}.pdf`}, 'application/pdf', 10, 'abc', ${p!.id}) returning id`;
  const [up] = await sql<{ id: string }[]>`
    insert into settlement_uploads (org_id, channel_id, store_id, platform, file_kind, file_id, fingerprint, reader_version, uploaded_by)
    values (${orgId}, ${ch!.id}, ${s1!.id}, 'foodpanda', 'foodpanda_invoice', ${file!.id}, ${uid('fp')}, '1', ${p!.id}) returning id`;
  let version = 0;
  const line = async (): Promise<string> => {
    version += 1;
    const [l] = await sql<{ id: string }[]>`
      insert into settlement_day_lines (org_id, channel_id, store_id, platform, sales_date, version, is_current, source_upload_id, order_value, gross_info, commission, marketing, platform_fee,
                                        vendor_discount, loan_deduction, loan_disbursal, net_payout, unexplained, paid_state)
      values (${orgId}, ${ch!.id}, ${s1!.id}, 'foodpanda', '2026-10-12', ${version}, ${version === 1}, ${up!.id}, '10000.00', '10000.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '10000.00', '0.00', 'paid') returning id`;
    entryOf.set(l!.id, await newEntry());
    return l!.id;
  };
  return { orgId, s1: s1!.id, s2: s2!.id, person: p!.id, channel: ch!.id, day: day!.id, day2: day2!.id, entry, line, newEntry, entryOf };
}

const corrRow = (o: Side, lineId: string, over: Row = {}): Row => ({
  org_id: o.orgId, store_id: o.s1, sales_day_id: o.day, channel_id: o.channel, day_line_id: lineId, from_amount: '11000.00', to_amount: '10000.00',
  entry_date: '2026-10-12', journal_entry_id: o.entryOf.get(lineId) ?? o.entry, reason: 'File is the truth', posted_by: o.person, ...over,
});

// ---------------------------------------------------------------------------------------------------------------------
// M1. the file and the journal
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6b / 0243 - the migration file and its journal entry', () => {
  it('0243_t511_platform_sales_corrections.sql exists and is journalled as idx 243, when 1807068707084, breakpoints true, after every earlier entry [kills: wrong number / tag / when; a when that sorts before an applied migration]', () => {
    expect(existsSync(join(MIGRATIONS, `${TARGET_TAG}.sql`)), `packages/db/migrations/${TARGET_TAG}.sql`).toBe(true);
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
    const e = journal.entries.find((x) => x.idx === TARGET_IDX);
    expect(e, `no journal entry with idx ${TARGET_IDX}`).toBeDefined();
    expect(e).toEqual({ idx: TARGET_IDX, version: '7', when: TARGET_WHEN, tag: TARGET_TAG, breakpoints: true });
    const earlier = journal.entries.filter((x) => x.idx < TARGET_IDX);
    expect(Math.max(...earlier.map((x) => x.when)), 'the new when is the latest so far').toBeLessThan(TARGET_WHEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M2-M4. shape, constraints, FKs
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6b / 0243 - the table: shape and constraints', () => {
  it('has the pinned columns, every one NOT NULL, the two amounts numeric(14,2), entry_date a date, posted_at timestamptz with a default [kills: nullable ids; a float amount; text dates]', async () => {
    const cols = await sql<{ attname: string; typ: string; notnull: boolean; hasdef: boolean }[]>`
      select a.attname, format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as notnull, a.atthasdef as hasdef
        from pg_attribute a where a.attrelid = ${`public.${TABLE}`}::regclass and a.attnum > 0 and not a.attisdropped`;
    const by = new Map(cols.map((c) => [c.attname, c]));
    expect([...by.keys()].sort()).toEqual(
      ['channel_id', 'day_line_id', 'entry_date', 'from_amount', 'id', 'journal_entry_id', 'org_id', 'posted_at', 'posted_by', 'reason', 'sales_day_id', 'store_id', 'to_amount'],
    );
    for (const n of ['id', 'org_id', 'store_id', 'sales_day_id', 'channel_id', 'day_line_id', 'journal_entry_id', 'posted_by']) expect(by.get(n), n).toMatchObject({ typ: 'uuid', notnull: true });
    for (const n of ['from_amount', 'to_amount']) expect(by.get(n), n).toMatchObject({ typ: 'numeric(14,2)', notnull: true });
    expect(by.get('entry_date')).toMatchObject({ typ: 'date', notnull: true });
    expect(by.get('reason')).toMatchObject({ typ: 'text', notnull: true });
    expect(by.get('posted_at')).toMatchObject({ typ: 'timestamp with time zone', notnull: true, hasdef: true });
  });

  it('a well-formed row is accepted (control for every refusal below)', async () => {
    const { A } = await base();
    expectOk(await run(async (tx) => insert(tx, TABLE, corrRow(A, await A.line()))), 'a well-formed correction');
  });

  it('(org_id, sales_day_id, day_line_id) is unique: a second correction for the same staged line on the same day is refused (23505); another line is fine; the same line on ANOTHER sales day is fine (a voided day re-entered) [kills: no unique; unique on the sales day alone (one correction per day); unique on the line alone (a re-entered day can never be corrected again)]', async () => {
    const { A } = await base();
    const l1 = await A.line();
    const l2 = await A.line();
    expectCode(
      await run(async (tx) => {
        await insert(tx, TABLE, corrRow(A, l1));
        await insert(tx, TABLE, corrRow(A, l1, { journal_entry_id: await A.newEntry() }));
      }),
      UNIQUE,
      'the same line twice',
    );
    expectOk(
      await run(async (tx) => {
        await insert(tx, TABLE, corrRow(A, l1));
        await insert(tx, TABLE, corrRow(A, l2, { from_amount: '10000.00', to_amount: '10500.00' }));
      }),
      'two lines of one sales day',
    );
    expectOk(
      await run(async (tx) => {
        await insert(tx, TABLE, corrRow(A, l1));
        await insert(tx, TABLE, corrRow(A, l1, { sales_day_id: A.day2, journal_entry_id: await A.newEntry() }));
      }),
      'the same line on another sales day',
    );
  });

  it('(org_id, journal_entry_id) is unique: one entry backs one correction (23505) [kills: two corrections claiming one entry]', async () => {
    const { A } = await base();
    const l1 = await A.line();
    const l2 = await A.line();
    expectCode(
      await run(async (tx) => {
        await insert(tx, TABLE, corrRow(A, l1));
        await insert(tx, TABLE, corrRow(A, l2, { journal_entry_id: A.entryOf.get(l1)! }));
      }),
      UNIQUE,
      'one entry, two corrections',
    );
  });

  it('from_amount and to_amount must differ: a correction that moves nothing is refused (23514) [kills: a no-op row]', async () => {
    const { A } = await base();
    expectCode(await run(async (tx) => insert(tx, TABLE, corrRow(A, await A.line(), { from_amount: '10000.00', to_amount: '10000.00' }))), CHECK, 'from = to');
  });

  it('reason must not be blank: empty and whitespace-only are refused (23514) [kills: no CHECK; a CHECK without trim]', async () => {
    const { A } = await base();
    for (const reason of ['', '   ']) expectCode(await run(async (tx) => insert(tx, TABLE, corrRow(A, await A.line(), { reason }))), CHECK, `reason ${JSON.stringify(reason)}`);
  });

  it('both amounts must be finite: NaN is refused (23514) on from_amount and on to_amount [kills: no finite check (NaN sorts above every number)]', async () => {
    const { A } = await base();
    for (const col of ['from_amount', 'to_amount']) {
      const o = await run(async (tx) => {
        const l = await A.line();
        if (col === 'from_amount') {
          return tx`insert into sales_day_platform_corrections (org_id, store_id, sales_day_id, channel_id, day_line_id, from_amount, to_amount, entry_date, journal_entry_id, reason, posted_by)
                    values (${A.orgId}, ${A.s1}, ${A.day}, ${A.channel}, ${l}, 'NaN'::numeric, '10000.00', '2026-10-12', ${A.entry}, 'x', ${A.person})`;
        }
        return tx`insert into sales_day_platform_corrections (org_id, store_id, sales_day_id, channel_id, day_line_id, from_amount, to_amount, entry_date, journal_entry_id, reason, posted_by)
                  values (${A.orgId}, ${A.s1}, ${A.day}, ${A.channel}, ${l}, '11000.00', 'NaN'::numeric, '2026-10-12', ${A.entry}, 'x', ${A.person})`;
      });
      expectCode(o, CHECK, `${col} NaN`);
    }
  });

  it('every foreign key is a composite starting with org_id (never a bare FK), covering store, sales day, channel, day line, journal entry and poster, ON DELETE RESTRICT [kills: a bare FK; a missing twin; CASCADE]', async () => {
    const rows = await sql<{ con: string; cols: string[]; ref: string; del: string }[]>`
      select con.conname as con,
             (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
             con.confrelid::regclass::text as ref, con.confdeltype as del
        from pg_constraint con where con.conrelid = ${`public.${TABLE}`}::regclass and con.contype = 'f'`;
    const bad = rows.filter((r) => !(r.cols[0] === 'org_id' && (r.cols.length >= 2 || /organizations$/.test(r.ref)))).map((r) => r.con);
    expect(bad, 'FKs that are neither org -> organizations nor composite starting with org_id').toEqual([]);
    const composite = rows.filter((r) => r.cols.length >= 2);
    const wanted: [string, RegExp][] = [
      ['store_id', /stores$/], ['sales_day_id', /sales_days$/], ['channel_id', /sales_channels$/], ['day_line_id', /settlement_day_lines$/], ['journal_entry_id', /journal_entries$/], ['posted_by', /persons$/],
    ];
    for (const [col, ref] of wanted) {
      const r = composite.find((x) => x.cols.includes(col) && ref.test(x.ref));
      expect(r, `a composite same-org FK covering ${col} onto ${ref}`).toBeDefined();
    }
    for (const r of rows) expect(r.del, `${r.con} ON DELETE`).toBe('r');
  });

  it('a correction of org A pointing at a day line, sales day, channel, entry or person of org B is refused (23503) [kills: a missing twin FK]', async () => {
    const { A, B } = await base();
    expectCode(await run(async (tx) => insert(tx, TABLE, corrRow(A, await B.line()))), FK, 'day line of another org');
    expectCode(await run(async (tx) => insert(tx, TABLE, corrRow(A, await A.line(), { sales_day_id: B.day }))), FK, 'sales day of another org');
    expectCode(await run(async (tx) => insert(tx, TABLE, corrRow(A, await A.line(), { channel_id: B.channel }))), FK, 'channel of another org');
    expectCode(await run(async (tx) => insert(tx, TABLE, corrRow(A, await A.line(), { journal_entry_id: B.entry }))), FK, 'entry of another org');
    expectCode(await run(async (tx) => insert(tx, TABLE, corrRow(A, await A.line(), { posted_by: B.person }))), FK, 'person of another org');
    expectCode(await run(async (tx) => insert(tx, TABLE, corrRow(A, await A.line(), { store_id: B.s1 }))), FK, 'store of another org');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M5. RLS and grants
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6b / 0243 - RLS and grants (corrections are history)', () => {
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

  it('org isolation: org B sees none of org A corrections and cannot INSERT one stamped org A (42501); control: org A inserts its own [kills: no policy; no WITH CHECK; policy on the wrong column]', async () => {
    const { A, B } = await base();
    await sql.begin(async (tx) => {
      await insert(tx, TABLE, corrRow(A, await A.line()));
    });
    const seen = await runAsApp(B.orgId, (tx) => tx<{ n: string }[]>`select count(*)::text as n from ${tx(TABLE)} where org_id = ${A.orgId}`);
    expectOk(seen, 'org B select');
    if (seen.ok) expect(seen.value[0]!.n).toBe('0');
    expectCode(await runAsApp(B.orgId, async (tx) => insert(tx, TABLE, corrRow(A, await A.line()))), NOPRIV, 'org B inserts a row stamped org A');
    expectOk(await runAsApp(A.orgId, async (tx) => insert(tx, TABLE, corrRow(A, await A.line()))), 'org A inserts its own correction');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M6. append-only
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6b / 0243 - a correction is never changed or removed', () => {
  async function committed() {
    const { A } = await base();
    const l = await A.line();
    const id = await sql.begin(async (tx) => insert(tx, TABLE, corrRow(A, l)));
    return { A, id };
  }

  it('the owner (and a superuser) cannot UPDATE or DELETE a row: the trigger refuses with 23001 and the row is unchanged [kills: no guard; a guard on DELETE only]', async () => {
    const { id } = await committed();
    expectCode(await run((tx) => tx`update ${tx(TABLE)} set reason = 'edited' where id = ${id}`), RESTRICT, 'UPDATE as the owner');
    expectCode(await run((tx) => tx`delete from ${tx(TABLE)} where id = ${id}`), RESTRICT, 'DELETE as the owner');
    const [row] = await sql<{ reason: string }[]>`select reason from ${sql(TABLE)} where id = ${id}`;
    expect(row!.reason).toBe('File is the truth');
  });

  it('session_replication_role = replica does not switch it off: the trigger is ENABLE ALWAYS (tgenabled A) [kills: an origin trigger a bulk load could bypass]', async () => {
    const { id } = await committed();
    for (const stmt of ['update', 'delete'] as const) {
      const o = await run(async (tx) => {
        await tx.unsafe('set local session_replication_role = replica');
        if (stmt === 'update') await tx`update ${tx(TABLE)} set to_amount = '1.00' where id = ${id}`;
        else await tx`delete from ${tx(TABLE)} where id = ${id}`;
      });
      expectCode(o, RESTRICT, `${stmt} under replica`);
    }
    const [t] = await sql<{ tgenabled: string }[]>`select tgenabled from pg_trigger where tgrelid = ${`public.${TABLE}`}::regclass and tgname = ${TRIGGER}`;
    expect(t?.tgenabled).toBe('A');
  });

  it('the app role has no UPDATE or DELETE privilege at all (42501): the trigger is the second wall [kills: UPDATE granted back to the app role]', async () => {
    const { A, id } = await committed();
    expectCode(await runAsApp(A.orgId, (tx) => tx`update ${tx(TABLE)} set reason = 'edited' where id = ${id}`), NOPRIV, 'UPDATE as the app role');
    expectCode(await runAsApp(A.orgId, (tx) => tx`delete from ${tx(TABLE)} where id = ${id}`), NOPRIV, 'DELETE as the app role');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M7. registries
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6b / 0243 - the registries know the new table and guard', () => {
  it('RLS_REGISTRY carries the table with scope org_column [kills: a table the RLS guard does not know]', () => {
    expect(RLS_REGISTRY[TABLE], `RLS_REGISTRY.${TABLE}`).toBeDefined();
    expect(RLS_REGISTRY[TABLE]?.scope).toBe('org_column');
  });

  it('CUTOVER_CLASSIFICATION classifies it purge, and the purge hint lists it before every table it cites [kills: an unclassified table; a purge that deletes a parent first]', () => {
    expect(CUTOVER_CLASSIFICATION[TABLE], `CUTOVER_CLASSIFICATION.${TABLE}`).toBeDefined();
    expect(CUTOVER_CLASSIFICATION[TABLE]?.class).toBe('purge');
    const i = PURGE_ORDER_HINT.indexOf(TABLE);
    expect(i, `${TABLE} must be listed in PURGE_ORDER_HINT (like sales_day_pos_corrections)`).toBeGreaterThanOrEqual(0);
    for (const parent of ['sales_days', 'settlement_day_lines', 'sales_channels', 'journal_entries']) {
      const p = PURGE_ORDER_HINT.indexOf(parent);
      if (p >= 0) expect(i, `${TABLE} before ${parent}`).toBeLessThan(p);
    }
  });

  it('the append-only guard is in TRIGGER_REGISTRY as always / history_guard on its own table, and the live trigger is registered [kills: an unclassified trigger (the T-354 guard); a guard classed as a validator]', () => {
    expect(TRIGGER_REGISTRY[TRIGGER]).toMatchObject({ table: TABLE, mode: 'always', kind: 'history_guard' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M8. the dual-run class check is widened by exactly one code
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6b / 0243 - dual_run_lines_class_check gains PLATFORM_FILE_CORRECTION', () => {
  it('the live CHECK lists exactly the 23 old codes plus PLATFORM_FILE_CORRECTION, nothing else [kills: the new code missing (every report holding one fails to store); a code dropped by the hand-copy; a free-text class]', async () => {
    const [c] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.dual_run_lines'::regclass and conname = 'dual_run_lines_class_check'`;
    expect(c, 'dual_run_lines_class_check exists').toBeDefined();
    const codes = [...c!.def.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!).sort();
    expect(codes).toEqual([...OLD_CLASSES, NEW_CLASS].sort());
    expect(new Set(codes).size, 'no duplicates').toBe(codes.length);
  });
});
