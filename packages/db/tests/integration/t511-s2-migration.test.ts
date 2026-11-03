/**
 * T-511 S2a (TESTER, 2026-11-03) - migration 0228 `0228_t511_settlement_intake`: the four settlement staging tables, the platform store code on
 * sales_channels, the expected repayment amount on loans, the widened stored_files purpose, and the re-created log_break_glass_approval.
 * docs/tasks/511-settlement-upload-s2-spec.md "Migration 0228" + BOSS rulings of 3 Nov (column-level UPDATE grants; `order_value` holds NET;
 * the break-glass function carries the three new capability names; number 0228, journal when 1805772707084). Real Postgres via TEST_DATABASE_URL.
 *
 * RED TODAY, for one reason: migration 0228 does not exist, so the four tables, the two sales_channels columns, loans.repayment_amount, the
 * widened purpose CHECK and the function's three names are all absent (relation / column "does not exist", or a CHECK that still rejects the value).
 * Fixtures are LAZY and split in two (`base()` needs only tables that exist today; `intake()` needs the new ones) so each test fails for its own reason.
 *
 * Every refusal runs in a transaction that is ALWAYS rolled back, so the shared test database never keeps a probe row. Fixture rows (two orgs) are committed.
 *
 * MUTANTS (each test title ends with `[kills: ...]`): table-wide UPDATE granted; DELETE / TRUNCATE granted; a money column left updatable; RLS without FORCE
 * or without WITH CHECK; policy on the wrong function; a CHECK missing or on the wrong set (platform, code pair, blank code, repayment <= 0, review shape,
 * paid_state, file_kind, booked_as, pandago, kind, amount > 0); unique code case- or space-sensitive, or only over ACTIVE channels, or global instead of per
 * (org, platform); two current lines per channel-day; a bare single-column FK; a missing finite check or a wrong body; a purpose CHECK not widened or widened
 * to anything; the function still listing 120 capabilities; no column comment on order_value; wrong journal number / when.
 */
import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { CAPABILITIES } from '../../../auth/src/capabilities';
import { APP_ROLE } from '../../src/rls/registry';

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

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------

type PgErr = Error & { code?: string; constraint_name?: string };
type Tx = postgres.TransactionSql;
type Row = Record<string, string | number | boolean | Date | null>;
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

const CHECK = '23514';
const UNIQUE = '23505';
const FK = '23503';
const NOPRIV = '42501';

class Rollback extends Error {}
type Outcome<T> = { ok: true; value: T } | { ok: false; err: PgErr };
/** Runs `fn` in a transaction that is ALWAYS rolled back; resolves with its value, or with the Postgres error it raised. */
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
/** Same, as the application role with `orgId` as the principal (RLS and column grants apply). */
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

const TABLES = ['settlement_uploads', 'settlement_day_lines', 'settlement_loan_lines', 'settlement_other_lines'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// lazy fixtures: two orgs
// ---------------------------------------------------------------------------------------------------------------------

interface Side {
  orgId: string;
  s1: string;
  s2: string;
  person: string;
  channel1: string;
  channel2: string;
  loan: string;
  file: string;
  pdf: string;
  settlement: string;
}
let baseP: Promise<{ A: Side; B: Side }> | null = null;
const base = () => (baseP ??= buildBase());

async function side(tag: string): Promise<Side> {
  const code = uid(`t511-${tag}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [s1] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S1')}, 'Lipa') returning id`;
  const [s2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S2')}, 'Malvar') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('Admin')}) returning id`;
  const [c1] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${orgId}, ${s1!.id}, ${uid('Grab')}, false, '1220') returning id`;
  const [c2] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${orgId}, ${s2!.id}, ${uid('Foodpanda')}, false, '1220') returning id`;
  const [loan] = await sql<{ id: string }[]>`
    insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
    values (${orgId}, ${s1!.id}, 'Grab', ${uid('Grab advance')}, 5000, 0, 'month', 'straight', 'monthly', 6, '2026-01-01', ${p!.id}) returning id`;
  const file = async (n: string) => {
    const [f] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${orgId}, ${s1!.id}, 'memo_document', ${`orgs/${orgId}/stores/${s1!.id}/memo_document/${uid(n)}.pdf`}, 'application/pdf', 10, 'abc', ${p!.id}) returning id`;
    return f!.id;
  };
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active) values (${orgId}, ${s1!.id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${s1!.id}, '2026-01-10', '0', '0', '0', ${p!.id}) returning id`;
  const [set] = await sql<{ id: string }[]>`
    insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, settled_on, created_by)
    values (${orgId}, ${s1!.id}, ${c1!.id}, ${day!.id}, '2026-01-10', '0', '0', '0', ${acct!.id}, '2026-01-10', ${p!.id}) returning id`;
  return { orgId, s1: s1!.id, s2: s2!.id, person: p!.id, channel1: c1!.id, channel2: c2!.id, loan: loan!.id, file: await file('f'), pdf: await file('p'), settlement: set!.id };
}
async function buildBase() {
  return { A: await side('A'), B: await side('B') };
}

const uploadRow = (o: Side, over: Row = {}): Row => ({
  org_id: o.orgId, channel_id: o.channel1, store_id: o.s1, platform: 'grab', file_kind: 'grab_transactions', file_id: o.file, pdf_file_id: null,
  fingerprint: uid('fp'), reader_version: '1', matched_code: null, period_from: '2026-10-01', period_to: '2026-10-07',
  invoice_number: null, orders_read: 0, loan_rows_read: 0, other_rows_read: 0, superseded_by: null, uploaded_by: o.person, ...over,
});
const dayRow = (o: Side, uploadId: string, over: Row = {}): Row => ({
  org_id: o.orgId, channel_id: o.channel1, store_id: o.s1, platform: 'grab', sales_date: '2026-10-01', version: 1, is_current: true,
  source_upload_id: uploadId, payout_upload_id: null,
  order_value: '100.00', gross_info: '110.00', commission: '20.00', marketing: '0.00', platform_fee: '0.00', vendor_discount: '10.00',
  loan_deduction: '0.00', loan_disbursal: '0.00', net_payout: '80.00', unexplained: '0.00',
  payout_reference: null, payout_date: null, payment_arrival_date: null, paid_state: 'not_paid', review_state: 'pending', ...over,
});
const loanLineRow = (o: Side, dayLineId: string, over: Row = {}): Row => ({
  org_id: o.orgId, day_line_id: dayLineId, kind: 'deduction', amount: '50.00', row_ordinal: 1, loan_id: null, ...over,
});
const otherLineRow = (o: Side, uploadId: string, dayLineId: string | null, over: Row = {}): Row => ({
  org_id: o.orgId, upload_id: uploadId, day_line_id: dayLineId, kind: 'adjustment', booked_as: 'platformFee', amount: '5.00', line_date: '2026-10-02', description: 'Adjustment', ...over,
});

interface Intake {
  upA: string;
  upA2: string;
  upB: string;
  dlA: string;
  dlB: string;
  llA: string;
  olA: string;
}
let intakeP: Promise<Intake> | null = null;
const intake = () => (intakeP ??= buildIntake());
async function buildIntake(): Promise<Intake> {
  const { A, B } = await base();
  const upA = await insert(sql as never, 'settlement_uploads', uploadRow(A));
  const upA2 = await insert(sql as never, 'settlement_uploads', uploadRow(A));
  const upB = await insert(sql as never, 'settlement_uploads', uploadRow(B));
  const dlA = await insert(sql as never, 'settlement_day_lines', dayRow(A, upA));
  const dlB = await insert(sql as never, 'settlement_day_lines', dayRow(B, upB));
  const llA = await insert(sql as never, 'settlement_loan_lines', loanLineRow(A, dlA));
  const olA = await insert(sql as never, 'settlement_other_lines', otherLineRow(A, upA, dlA));
  return { upA, upA2, upB, dlA, dlB, llA, olA };
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. the migration artifacts
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - the migration file and its journal entry (BOSS ruling 5)', () => {
  const dir = join(__dirname, '..', '..', 'migrations');
  it('0228_t511_settlement_intake.sql exists and is journalled as idx 228, when 1805772707084, breakpoints true [kills: wrong number / tag / when]', () => {
    expect(existsSync(join(dir, '0228_t511_settlement_intake.sql')), 'packages/db/migrations/0228_t511_settlement_intake.sql').toBe(true);
    const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
    const e = journal.entries.find((x) => x.idx === 228);
    expect(e, 'no journal entry with idx 228').toBeDefined();
    expect(e).toEqual({ idx: 228, version: '7', when: 1805772707084, tag: '0228_t511_settlement_intake', breakpoints: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. catalog: tables, RLS, grants, comments, FK shape
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - the four tables exist with FORCE RLS and the org isolation policy', () => {
  it('all four tables exist in public [kills: a table missing]', async () => {
    const rows = await sql<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname = any(${TABLES as unknown as string[]})`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
  });

  it('each has ENABLE and FORCE ROW LEVEL SECURITY [kills: RLS without FORCE (the table owner bypasses it)]', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any(${TABLES as unknown as string[]}) order by 1`;
    expect(rows.length, 'tables found').toBe(4);
    for (const r of rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('each has policy <table>_org_isolation FOR ALL using app_current_org() in both USING and WITH CHECK [kills: no WITH CHECK; raw current_setting; wrong name]', async () => {
    const rows = await sql<{ tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
      select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = any(${TABLES as unknown as string[]})`;
    for (const t of TABLES) {
      const p = rows.filter((r) => r.tablename === t);
      expect(p.map((x) => x.policyname), `${t} policies`).toEqual([`${t}_org_isolation`]);
      expect(p[0]!.cmd).toBe('ALL');
      expect(p[0]!.qual ?? '', `${t} USING`).toMatch(/app_current_org\(\)/);
      expect(p[0]!.qual ?? '', `${t} USING`).toMatch(/org_id/);
      expect(p[0]!.with_check ?? '', `${t} WITH CHECK`).toMatch(/app_current_org\(\)/);
      expect(p[0]!.qual ?? '').not.toMatch(/current_setting/);
    }
  });

  it('every foreign key on the four tables is org_id -> organizations or a COMPOSITE that starts with org_id: never a bare single-column FK (t398 C1) [kills: bare FK]', async () => {
    const rows = await sql<{ rel: string; con: string; n: number; first: string; ref: string }[]>`
      select cl.relname as rel, con.conname as con, cardinality(con.conkey) as n,
             (select a.attname from pg_attribute a where a.attrelid = con.conrelid and a.attnum = con.conkey[1]) as first,
             con.confrelid::regclass::text as ref
        from pg_constraint con join pg_class cl on cl.oid = con.conrelid join pg_namespace ns on ns.oid = cl.relnamespace
       where ns.nspname = 'public' and con.contype = 'f' and cl.relname = any(${TABLES as unknown as string[]})`;
    expect(rows.length, 'foreign keys found on the four tables').toBeGreaterThan(8);
    // 3 columns is allowed ONLY for the channel+store FK (org_id, channel_id, store_id) -> sales_channels (T-511 S2a delta, BOSS 3 Nov): it still starts with org_id, so it still pins the org.
    const bad = rows.filter((r) => !(r.n === 2 && r.first === 'org_id') && !(r.n === 3 && r.first === 'org_id' && /sales_channels$/.test(r.ref) && /_channel_store_same_org_fk$/.test(r.con)) && !(r.n === 1 && r.first === 'org_id' && /organizations$/.test(r.ref))).map((r) => `${r.rel}.${r.con}`);
    expect(bad, 'FKs that are neither org->organizations nor composite (org_id, col)').toEqual([]);
  });

  // T-511 S2b nit (3 Nov): the relaxed shape above only checks "3 columns, starts with org_id, targets sales_channels, name ends _channel_store_same_org_fk";
  // a 3-column FK on any OTHER columns (say (org_id, file_id, store_id)) carrying that name would pass it. Pin the columns exactly.
  it('every 3-column FK is EXACTLY (org_id, channel_id, store_id) -> sales_channels (org_id, id, store_id), in that order, and there is at least one [kills: a 3-column FK on other columns; a reordered key; a key into another parent]', async () => {
    const rows = await sql<{ rel: string; con: string; cols: string[]; ref: string; refcols: string[] }[]>`
      select cl.relname as rel, con.conname as con,
             (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
             con.confrelid::regclass::text as ref,
             (select array_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as refcols
        from pg_constraint con join pg_class cl on cl.oid = con.conrelid join pg_namespace ns on ns.oid = cl.relnamespace
       where ns.nspname = 'public' and con.contype = 'f' and cl.relname = any(${TABLES as unknown as string[]}) and cardinality(con.conkey) = 3`;
    expect(rows.length, '3-column FKs found (the channel+store twin, on the tables that carry both)').toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.cols, `${r.rel}.${r.con}: referencing columns`).toEqual(['org_id', 'channel_id', 'store_id']);
      expect(r.ref, `${r.rel}.${r.con}: parent`).toMatch(/(^|\.)sales_channels$/);
      expect(r.refcols, `${r.rel}.${r.con}: referenced columns`).toEqual(['org_id', 'id', 'store_id']);
      expect(r.con, `${r.rel}.${r.con}: name`).toMatch(/_channel_store_same_org_fk$/);
    }
  });

  it('uploads and day lines (the parents of other new tables) each carry exactly one UNIQUE (org_id, id) (t398 K2) [kills: none, or a duplicate index beside the constraint]', async () => {
    for (const t of ['settlement_uploads', 'settlement_day_lines']) {
      const rows = await sql<{ cols: string }[]>`
        select (select string_agg(a.attname, ',' order by k.ord) from unnest(i.indkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as cols
          from pg_index i where i.indrelid = ${`public.${t}`}::regclass and i.indisunique and i.indnatts = 2 and i.indpred is null`;
      expect(rows.filter((r) => r.cols === 'org_id,id').length, `${t}: unique (org_id, id) count`).toBe(1);
    }
  });
});

/** The ONLY columns the app role may UPDATE (BOSS ruling 1: column-level grants; amounts are never updatable in place). */
const UPDATABLE: Record<(typeof TABLES)[number], string[]> = {
  settlement_uploads: ['superseded_by'],
  settlement_day_lines: ['review_state', 'decision_reason', 'decided_by', 'decided_at', 'settlement_id', 'is_current', 'changed_since_booked', 'recorded_figure', 'difference'],
  settlement_loan_lines: ['is_active'],
  settlement_other_lines: ['is_current'],
};
const MONEY: Record<(typeof TABLES)[number], string[]> = {
  settlement_uploads: [],
  settlement_day_lines: ['order_value', 'gross_info', 'commission', 'marketing', 'platform_fee', 'vendor_discount', 'loan_deduction', 'loan_disbursal', 'net_payout', 'unexplained'],
  settlement_loan_lines: ['amount'],
  settlement_other_lines: ['amount'],
};

describe('T-511 S2a / 0228 - grants for the app role are column-level (BOSS ruling 1)', () => {
  it('table privileges: SELECT and INSERT yes; UPDATE (table-wide), DELETE, TRUNCATE, REFERENCES, TRIGGER no [kills: GRANT UPDATE ON table; DELETE granted; TRUNCATE granted]', async () => {
    for (const t of TABLES) {
      const [r] = await sql<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean; ref: boolean; trig: boolean }[]>`
        select has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'SELECT') as sel, has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'INSERT') as ins,
               has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'UPDATE') as upd, has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'DELETE') as del,
               has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'TRUNCATE') as trunc, has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'REFERENCES') as ref,
               has_table_privilege(${APP_ROLE}, ${`public.${t}`}, 'TRIGGER') as trig`;
      expect(r, t).toEqual({ sel: true, ins: true, upd: false, del: false, trunc: false, ref: false, trig: false });
    }
  });

  it('the set of columns the app role may UPDATE is EXACTLY the ruled list per table (read from the catalog with has_column_privilege) [kills: an extra column granted; a listed column missing]', async () => {
    for (const t of TABLES) {
      const cols = await sql<{ attname: string; ok: boolean }[]>`
        select a.attname, has_column_privilege(${APP_ROLE}, a.attrelid, a.attnum, 'UPDATE') as ok
          from pg_attribute a where a.attrelid = ${`public.${t}`}::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`;
      expect(cols.length, `${t} columns`).toBeGreaterThan(3);
      expect(cols.filter((c) => c.ok).map((c) => c.attname).sort(), `${t}: updatable columns`).toEqual([...UPDATABLE[t]].sort());
    }
  });

  it('no numeric (money) column outside the ruled list is updatable, and every named money column is not (catalog cross-check) [kills: GRANT UPDATE on all columns]', async () => {
    for (const t of TABLES) {
      const numeric = await sql<{ attname: string; ok: boolean }[]>`
        select a.attname, has_column_privilege(${APP_ROLE}, a.attrelid, a.attnum, 'UPDATE') as ok
          from pg_attribute a where a.attrelid = ${`public.${t}`}::regclass and a.attnum > 0 and not a.attisdropped and a.atttypid = 'numeric'::regtype`;
      for (const c of numeric.filter((x) => !UPDATABLE[t].includes(x.attname))) expect(c.ok, `${t}.${c.attname} must not be updatable`).toBe(false);
      for (const m of MONEY[t]) expect(numeric.map((x) => x.attname), `${t}.${m} is a numeric column`).toContain(m);
    }
  });

  it('as the app role, UPDATE of each money column is refused with 42501 and the row is unchanged [kills: amounts editable in place]', async () => {
    const { A } = await base();
    const fx = await intake();
    const ids: Record<(typeof TABLES)[number], string> = { settlement_uploads: fx.upA, settlement_day_lines: fx.dlA, settlement_loan_lines: fx.llA, settlement_other_lines: fx.olA };
    for (const t of TABLES) {
      for (const col of MONEY[t]) {
        const o = await runAsApp(A.orgId, (tx) => tx.unsafe(`update ${t} set ${col} = 0 where id = '${ids[t]}'`));
        expectCode(o, NOPRIV, `UPDATE ${t}.${col}`);
      }
    }
    const [r] = await sql<{ order_value: string }[]>`select order_value from settlement_day_lines where id = ${fx.dlA}`;
    expect(r!.order_value).toBe('100.00');
  });

  it('control: as the app role under the right org, each ALLOWED column updates one row [kills: a grant that exists on paper only; RLS blocking the happy path]', async () => {
    const { A } = await base();
    const fx = await intake();
    const probes: [string, string][] = [
      [`update settlement_uploads set superseded_by = '${fx.upA2}' where id = '${fx.upA}'`, 'settlement_uploads.superseded_by'],
      [`update settlement_day_lines set changed_since_booked = true where id = '${fx.dlA}'`, 'settlement_day_lines.changed_since_booked'],
      [`update settlement_loan_lines set is_active = false where id = '${fx.llA}'`, 'settlement_loan_lines.is_active'],
      [`update settlement_other_lines set is_current = false where id = '${fx.olA}'`, 'settlement_other_lines.is_current'],
    ];
    for (const [q, what] of probes) {
      const o = await runAsApp(A.orgId, (tx) => tx.unsafe(q));
      expectOk(o, what);
      if (o.ok) expect(o.value.count, `${what}: rows updated`).toBe(1);
    }
  });

  it('as the app role, DELETE and TRUNCATE are refused with 42501 on all four tables [kills: DELETE / TRUNCATE granted]', async () => {
    const { A } = await base();
    const fx = await intake();
    const ids: Record<(typeof TABLES)[number], string> = { settlement_uploads: fx.upA, settlement_day_lines: fx.dlA, settlement_loan_lines: fx.llA, settlement_other_lines: fx.olA };
    for (const t of TABLES) {
      expectCode(await runAsApp(A.orgId, (tx) => tx.unsafe(`delete from ${t} where id = '${ids[t]}'`)), NOPRIV, `DELETE ${t}`);
      expectCode(await runAsApp(A.orgId, (tx) => tx.unsafe(`truncate ${t}`)), NOPRIV, `TRUNCATE ${t}`);
    }
  });
});

describe('T-511 S2a / 0228 - org isolation holds for the app role (RLS)', () => {
  it('as org B, rows of org A are invisible on all four tables [kills: policy missing; policy on the wrong column]', async () => {
    const { A, B } = await base();
    await intake();
    for (const t of TABLES) {
      const o = await runAsApp(B.orgId, (tx) => tx.unsafe(`select count(*)::int as n from ${t} where org_id = '${A.orgId}'`));
      expectOk(o, `select ${t}`);
      if (o.ok) expect(o.value[0]!.n, `${t}: org A rows visible to org B`).toBe(0);
      const own = await runAsApp(A.orgId, (tx) => tx.unsafe(`select count(*)::int as n from ${t} where org_id = '${A.orgId}'`));
      if (own.ok) expect(own.value[0]!.n, `${t}: org A rows visible to org A`).toBeGreaterThan(0);
    }
  });

  it('as org B, INSERT of a row stamped org A is refused by WITH CHECK (42501) on all four tables [kills: no WITH CHECK]', async () => {
    const { A, B } = await base();
    const fx = await intake();
    const rows: [string, Row][] = [
      ['settlement_uploads', uploadRow(A)],
      ['settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-09' })],
      ['settlement_loan_lines', loanLineRow(A, fx.dlA)],
      ['settlement_other_lines', otherLineRow(A, fx.upA, fx.dlA)],
    ];
    for (const [t, row] of rows) expectCode(await runAsApp(B.orgId, (tx) => insert(tx, t, row)), NOPRIV, `insert ${t} as org B stamped org A`);
  });

  it('control: as org A, the app role can INSERT a row of each table [kills: grants or policy blocking the happy path]', async () => {
    const { A } = await base();
    const fx = await intake();
    const rows: [string, Row][] = [
      ['settlement_uploads', uploadRow(A)],
      ['settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-09' })],
      ['settlement_loan_lines', loanLineRow(A, fx.dlA, { row_ordinal: 9 })],
      ['settlement_other_lines', otherLineRow(A, fx.upA, fx.dlA)],
    ];
    for (const [t, row] of rows) expectOk(await runAsApp(A.orgId, (tx) => insert(tx, t, row)), `insert ${t} as org A`);
  });
});

describe('T-511 S2a / 0228 - column comment: order_value holds NET (BOSS ruling 2)', () => {
  it("col_description of settlement_day_lines.order_value mentions 'net' (case-insensitive) [kills: no comment; a comment that does not say what the figure is]", async () => {
    const [r] = await sql<{ d: string | null }[]>`
      select col_description(${'public.settlement_day_lines'}::regclass, a.attnum) as d
        from pg_attribute a where a.attrelid = 'public.settlement_day_lines'::regclass and a.attname = 'order_value' and not a.attisdropped`;
    expect(r?.d, 'column comment on settlement_day_lines.order_value').toBeTruthy();
    expect(r!.d!).toMatch(/net/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. sales_channels: platform + store code
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - sales_channels.platform and platform_store_code', () => {
  const channel = (o: Side, store: string, over: Row = {}): Row => ({ org_id: o.orgId, store_id: store, name: uid('Ch'), is_remitted_daily: false, receivable_account_code: '1220', ...over });

  it('a valid (platform, code) pair and a (NULL, NULL) pair both insert [control]', async () => {
    const { A } = await base();
    expectOk(await run((tx) => insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'grab', platform_store_code: 'ABC-1' }))), 'grab + code');
    expectOk(await run((tx) => insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'foodpanda', platform_store_code: 'a1b2' }))), 'foodpanda + code');
    expectOk(await run((tx) => insert(tx, 'sales_channels', channel(A, A.s1))), 'no platform, no code');
  });

  it('a platform outside (grab, foodpanda) is refused (23514) [kills: no platform CHECK; wrong set]', async () => {
    const { A } = await base();
    expectCode(await run((tx) => insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'uber', platform_store_code: 'ABC' }))), CHECK, 'platform uber');
  });

  it('platform and code must be set together: either one alone is refused (23514) [kills: no pair CHECK]', async () => {
    const { A } = await base();
    expectCode(await run((tx) => insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'grab', platform_store_code: null }))), CHECK, 'platform without code');
    expectCode(await run((tx) => insert(tx, 'sales_channels', channel(A, A.s1, { platform: null, platform_store_code: 'ABC' }))), CHECK, 'code without platform');
  });

  it('a code that is blank after trim is refused (23514), empty and spaces alike [kills: no blank CHECK; CHECK without trim]', async () => {
    const { A } = await base();
    expectCode(await run((tx) => insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'grab', platform_store_code: '' }))), CHECK, 'empty code');
    expectCode(await run((tx) => insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'grab', platform_store_code: '   ' }))), CHECK, 'spaces-only code');
  });

  it('the unique index sales_channels_org_platform_code_key exists and is unique [kills: wrong name; non-unique]', async () => {
    const [r] = await sql<{ indisunique: boolean; def: string }[]>`
      select i.indisunique, pg_get_indexdef(i.indexrelid) as def from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'sales_channels_org_platform_code_key'`;
    expect(r, 'index sales_channels_org_platform_code_key').toBeDefined();
    expect(r!.indisunique).toBe(true);
  });

  it('the same code is refused when it differs only by case or surrounding spaces, even at another store of the org (23505, named index) [kills: case-sensitive; trim missing; per-store instead of per-org]', async () => {
    const { A } = await base();
    const o = await run(async (tx) => {
      await insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'grab', platform_store_code: 'Abc-1' }));
      return insert(tx, 'sales_channels', channel(A, A.s2, { platform: 'grab', platform_store_code: '  aBC-1  ' }));
    });
    const err = expectCode(o, UNIQUE, 'duplicate code, different case and spaces');
    expect(err.constraint_name).toBe('sales_channels_org_platform_code_key');
  });

  it('the unique index spans INACTIVE channels: a retired channel still holds its code (23505) [kills: partial index on is_active]', async () => {
    const { A } = await base();
    const o = await run(async (tx) => {
      await insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'foodpanda', platform_store_code: 'zz9', is_active: false }));
      return insert(tx, 'sales_channels', channel(A, A.s2, { platform: 'foodpanda', platform_store_code: 'ZZ9' }));
    });
    expectCode(o, UNIQUE, 'code of an inactive channel reused');
  });

  it('the same code is allowed on the other platform, and in another org [kills: unique on the code alone; unique across orgs]', async () => {
    const { A, B } = await base();
    const o = await run(async (tx) => {
      await insert(tx, 'sales_channels', channel(A, A.s1, { platform: 'grab', platform_store_code: 'SAME1' }));
      await insert(tx, 'sales_channels', channel(A, A.s2, { platform: 'foodpanda', platform_store_code: 'SAME1' }));
      await insert(tx, 'sales_channels', channel(B, B.s1, { platform: 'grab', platform_store_code: 'SAME1' }));
      return 'ok';
    });
    expectOk(o, 'same code on the other platform and in another org');
  });

  it('many channels may have no code at all (NULL codes never collide) [kills: unique over NULLs / coalesce]', async () => {
    const { A } = await base();
    const o = await run(async (tx) => {
      for (let i = 0; i < 3; i++) await insert(tx, 'sales_channels', channel(A, A.s1));
      return 'ok';
    });
    expectOk(o, 'three channels without a code');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. loans.repayment_amount
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - loans.repayment_amount', () => {
  const loan = (o: Side, over: Row = {}): Row => ({
    org_id: o.orgId, store_id: o.s1, lender_name: 'Grab', name: uid('Loan'), principal_amount: '5000', interest_rate: '0', rate_period: 'month', interest_method: 'straight',
    payment_frequency: 'monthly', term_periods: 6, start_date: '2026-01-01', created_by: o.person, ...over,
  });

  it('the column is numeric(14,2) and nullable [kills: wrong type; NOT NULL (every existing loan has none)]', async () => {
    const [c] = await sql<{ data_type: string; numeric_precision: number; numeric_scale: number; is_nullable: string }[]>`
      select data_type, numeric_precision, numeric_scale, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'loans' and column_name = 'repayment_amount'`;
    expect(c, 'loans.repayment_amount').toBeDefined();
    expect(c).toMatchObject({ data_type: 'numeric', numeric_precision: 14, numeric_scale: 2, is_nullable: 'YES' });
  });

  it('NULL and 0.01 are accepted [control]', async () => {
    const { A } = await base();
    expectOk(await run((tx) => insert(tx, 'loans', loan(A))), 'no repayment amount');
    expectOk(await run((tx) => insert(tx, 'loans', loan(A, { repayment_amount: '0.01' }))), '0.01');
  });

  it('zero and negative are refused (23514) [kills: no > 0 CHECK; >= 0]', async () => {
    const { A } = await base();
    expectCode(await run((tx) => insert(tx, 'loans', loan(A, { repayment_amount: '0' }))), CHECK, 'zero');
    expectCode(await run((tx) => insert(tx, 'loans', loan(A, { repayment_amount: '-5.00' }))), CHECK, 'negative');
  });

  it('NaN is refused by loans_repayment_amount_finite_check (NaN sorts above every number, so > 0 alone lets it through) [kills: no finite check]', async () => {
    const { A } = await base();
    const err = expectCode(await run((tx) => insert(tx, 'loans', loan(A, { repayment_amount: 'NaN' }))), CHECK, 'repayment_amount NaN');
    expect(err.constraint_name, 'NaN: constraint').toBe('loans_repayment_amount_finite_check');
    // Infinity never reaches the CHECK: numeric(14,2) refuses it first (22003, numeric field overflow), which is also a refusal.
    const inf = await run((tx) => insert(tx, 'loans', loan(A, { repayment_amount: 'Infinity' })));
    expect(inf.ok, 'repayment_amount Infinity must be refused').toBe(false);
  });

  it("loans_repayment_amount_finite_check has the exact normalised body the t327 census compares [kills: a different predicate]", async () => {
    const [r] = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.loans'::regclass and conname = 'loans_repayment_amount_finite_check'`;
    expect(r, 'constraint loans_repayment_amount_finite_check').toBeDefined();
    expect(r!.def.replace(/\s+/g, ' ').trim()).toBe(`CHECK (((repayment_amount > '-Infinity'::numeric) AND (repayment_amount < 'Infinity'::numeric)))`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. settlement_uploads
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - settlement_uploads', () => {
  it('all three file kinds and both platforms insert [control]', async () => {
    const { A } = await base();
    const o = await run(async (tx) => {
      await insert(tx, 'settlement_uploads', uploadRow(A, { platform: 'grab', file_kind: 'grab_transactions' }));
      await insert(tx, 'settlement_uploads', uploadRow(A, { platform: 'grab', file_kind: 'grab_transfers' }));
      await insert(tx, 'settlement_uploads', uploadRow(A, { platform: 'foodpanda', file_kind: 'foodpanda_invoice', pdf_file_id: A.pdf, invoice_number: 'INV-1' }));
      return 'ok';
    });
    expectOk(o, 'three kinds');
  });

  it('an unknown file_kind or platform is refused (23514) [kills: no CHECK; wrong set]', async () => {
    const { A } = await base();
    expectCode(await run((tx) => insert(tx, 'settlement_uploads', uploadRow(A, { file_kind: 'grab_invoice' }))), CHECK, 'file_kind');
    expectCode(await run((tx) => insert(tx, 'settlement_uploads', uploadRow(A, { platform: 'uber' }))), CHECK, 'platform');
  });

  it('a negative count is refused (23514) on orders_read, loan_rows_read and other_rows_read [kills: no >= 0 CHECK]', async () => {
    const { A } = await base();
    for (const col of ['orders_read', 'loan_rows_read', 'other_rows_read']) {
      expectCode(await run((tx) => insert(tx, 'settlement_uploads', uploadRow(A, { [col]: -1 }))), CHECK, col);
    }
  });

  it('(org_id, fingerprint) is unique: the same file twice in one org is refused (23505), the same fingerprint in another org is fine [kills: no unique; unique on fingerprint alone]', async () => {
    const { A, B } = await base();
    const dup = await run(async (tx) => {
      await insert(tx, 'settlement_uploads', uploadRow(A, { fingerprint: 'fp-same' }));
      return insert(tx, 'settlement_uploads', uploadRow(A, { fingerprint: 'fp-same', channel_id: A.channel2, store_id: A.s2 }));
    });
    expectCode(dup, UNIQUE, 'same fingerprint, same org');
    const other = await run(async (tx) => {
      await insert(tx, 'settlement_uploads', uploadRow(A, { fingerprint: 'fp-same' }));
      return insert(tx, 'settlement_uploads', uploadRow(B, { fingerprint: 'fp-same' }));
    });
    expectOk(other, 'same fingerprint in another org');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. settlement_day_lines
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - settlement_day_lines: one current line per channel-day, versions, review state shape', () => {
  const NOW = new Date('2026-11-03T08:00:00Z');

  it('a second is_current line for the same (org, channel, sales_date) is refused (23505); a retired one beside it is fine [kills: no partial unique; unique over all versions]', async () => {
    const { A } = await base();
    const fx = await intake();
    const dup = await run(async (tx) => {
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-20', version: 1 }));
      return insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-20', version: 2 }));
    });
    expectCode(dup, UNIQUE, 'two current lines');
    const ok = await run(async (tx) => {
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-20', version: 1, is_current: false }));
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-20', version: 2, is_current: true }));
      return 'ok';
    });
    expectOk(ok, 'retired v1 beside current v2');
  });

  it('(org, channel, sales_date, version) is unique even when both rows are retired (23505) [kills: no version unique]', async () => {
    const { A } = await base();
    const fx = await intake();
    const o = await run(async (tx) => {
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-21', version: 1, is_current: false }));
      return insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-21', version: 1, is_current: false }));
    });
    expectCode(o, UNIQUE, 'same version twice');
  });

  it('version must be >= 1 (23514) [kills: no version CHECK]', async () => {
    const { A } = await base();
    const fx = await intake();
    expectCode(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-22', version: 0 }))), CHECK, 'version 0');
  });

  it('review_state outside (pending, booked, rejected), paid_state outside (paid, not_paid), and a bad platform are refused (23514) [kills: missing CHECKs]', async () => {
    const { A } = await base();
    const fx = await intake();
    expectCode(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-23', review_state: 'approved' }))), CHECK, 'review_state approved');
    expectCode(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-23', paid_state: 'maybe' }))), CHECK, 'paid_state maybe');
    expectCode(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-23', platform: 'uber' }))), CHECK, 'platform uber');
    for (const paid of ['paid', 'not_paid']) {
      expectOk(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-23', paid_state: paid }))), `paid_state ${paid}`);
    }
  });

  it('review_state shape: pending needs reason, decided_by, decided_at and settlement_id all NULL [kills: shape CHECK missing for pending]', async () => {
    const { A } = await base();
    const fx = await intake();
    const mk = (over: Row) => run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-24', review_state: 'pending', ...over })));
    expectOk(await mk({}), 'pending, all NULL');
    expectCode(await mk({ decision_reason: 'why' }), CHECK, 'pending with a reason');
    expectCode(await mk({ decided_by: A.person }), CHECK, 'pending with decided_by');
    expectCode(await mk({ decided_at: NOW }), CHECK, 'pending with decided_at');
    expectCode(await mk({ settlement_id: A.settlement }), CHECK, 'pending with settlement_id');
  });

  it('review_state shape: rejected needs a non-blank reason, decided_by and decided_at, and NO settlement_id [kills: blank reason accepted; a rejected day linked to a settlement]', async () => {
    const { A } = await base();
    const fx = await intake();
    const good: Row = { review_state: 'rejected', decision_reason: 'Figures do not match the till', decided_by: A.person, decided_at: NOW, settlement_id: null };
    const mk = (over: Row) => run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-25', ...good, ...over })));
    expectOk(await mk({}), 'rejected, complete');
    expectCode(await mk({ decision_reason: null }), CHECK, 'rejected without reason');
    expectCode(await mk({ decision_reason: '' }), CHECK, 'rejected with an empty reason');
    expectCode(await mk({ decision_reason: '   ' }), CHECK, 'rejected with a blank reason');
    expectCode(await mk({ decided_by: null }), CHECK, 'rejected without decided_by');
    expectCode(await mk({ decided_at: null }), CHECK, 'rejected without decided_at');
    expectCode(await mk({ settlement_id: A.settlement }), CHECK, 'rejected with a settlement');
  });

  it('review_state shape: booked needs decided_by, decided_at and settlement_id [kills: a booked day with no settlement behind it]', async () => {
    const { A } = await base();
    const fx = await intake();
    const good: Row = { review_state: 'booked', decided_by: A.person, decided_at: NOW, settlement_id: A.settlement };
    const mk = (over: Row) => run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-26', ...good, ...over })));
    expectOk(await mk({}), 'booked, complete');
    expectCode(await mk({ decided_by: null }), CHECK, 'booked without decided_by');
    expectCode(await mk({ decided_at: null }), CHECK, 'booked without decided_at');
    expectCode(await mk({ settlement_id: null }), CHECK, 'booked without settlement_id');
  });
});

describe('T-511 S2a / 0228 delta (BOSS 3 Nov) - one settlement per day line, and store consistency enforced in the database', () => {
  const NOW = new Date('2026-11-03T08:00:00Z');
  const booked = (o: Side, over: Row = {}): Row => ({ review_state: 'booked', decided_by: o.person, decided_at: NOW, settlement_id: o.settlement, ...over });

  it('two day lines may not point at the same channel_settlements row: 23505 on settlement_day_lines_settlement_id_key (retired lines included) [kills: no partial unique on (org_id, settlement_id)]', async () => {
    const { A } = await base();
    const fx = await intake();
    const dup = await run(async (tx) => {
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-01', ...booked(A) }));
      return insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-02', ...booked(A) }));
    });
    expect(expectCode(dup, UNIQUE, 'second day line on the same settlement').constraint_name).toBe('settlement_day_lines_settlement_id_key');
    const retired = await run(async (tx) => {
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-03', is_current: false, ...booked(A) }));
      return insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-04', ...booked(A) }));
    });
    expectCode(retired, UNIQUE, 'a retired line still holds its settlement');
  });

  it('the settlement_id unique is PARTIAL: many day lines with settlement_id NULL are fine, and two different settlements are fine [kills: a plain unique that treats NULL as a value; a unique over the wrong columns]', async () => {
    const { A } = await base();
    const fx = await intake();
    const nulls = await run(async (tx) => {
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-05' }));
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-06' }));
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-07', review_state: 'rejected', decision_reason: 'no', decided_by: A.person, decided_at: NOW }));
      return 'ok';
    });
    expectOk(nulls, 'three day lines with settlement_id NULL');
    const two = await run(async (tx) => {
      const [s2] = await tx<{ id: string }[]>`
        insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, settled_on, created_by)
        select org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, '2026-01-11', created_by
          from channel_settlements where id = ${A.settlement} returning id`;
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-08', ...booked(A) }));
      await insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-09', ...booked(A, { settlement_id: s2!.id }) }));
      return 'ok';
    });
    expectOk(two, 'two day lines on two different settlements');
  });

  it('the index is named settlement_day_lines_settlement_id_key, is unique and partial on (org_id, settlement_id) WHERE settlement_id IS NOT NULL [kills: wrong name; non-partial; wrong columns]', async () => {
    const [r] = await sql<{ cols: string; pred: string | null; uniq: boolean }[]>`
      select i.indisunique as uniq, pg_get_expr(i.indpred, i.indrelid) as pred,
             (select string_agg(a.attname, ',' order by k.ord) from unnest(i.indkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) as cols
        from pg_index i join pg_class c on c.oid = i.indexrelid
       where c.relname = 'settlement_day_lines_settlement_id_key' and i.indrelid = 'public.settlement_day_lines'::regclass`;
    expect(r, 'index settlement_day_lines_settlement_id_key').toBeDefined();
    expect(r!.uniq).toBe(true);
    expect(r!.cols).toBe('org_id,settlement_id');
    expect(r!.pred ?? '').toMatch(/settlement_id IS NOT NULL/);
  });

  it('a day line whose store_id differs from its channel store is refused (23503); the matching store is accepted [kills: no store-consistency guard on settlement_day_lines]', async () => {
    const { A } = await base();
    const fx = await intake();
    // channel1 belongs to store s1; channel2 belongs to store s2 (two stores of ONE org, so the plain (org_id, store_id) twin FK is satisfied).
    expectOk(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-10', channel_id: A.channel1, store_id: A.s1 }))), 'channel of store A, store A');
    expectOk(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-10', channel_id: A.channel2, store_id: A.s2 }))), 'channel of store B, store B');
    expectCode(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-10', channel_id: A.channel1, store_id: A.s2 }))), FK, 'day line: channel of store A, store B');
    expectCode(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-10', channel_id: A.channel2, store_id: A.s1 }))), FK, 'day line: channel of store B, store A');
  });

  it('an upload whose store_id differs from its channel store is refused (23503); the matching store is accepted [kills: no store-consistency guard on settlement_uploads]', async () => {
    const { A } = await base();
    expectOk(await run((tx) => insert(tx, 'settlement_uploads', uploadRow(A, { channel_id: A.channel1, store_id: A.s1 }))), 'channel of store A, store A');
    expectOk(await run((tx) => insert(tx, 'settlement_uploads', uploadRow(A, { channel_id: A.channel2, store_id: A.s2 }))), 'channel of store B, store B');
    expectCode(await run((tx) => insert(tx, 'settlement_uploads', uploadRow(A, { channel_id: A.channel1, store_id: A.s2 }))), FK, 'upload: channel of store A, store B');
    expectCode(await run((tx) => insert(tx, 'settlement_uploads', uploadRow(A, { channel_id: A.channel2, store_id: A.s1 }))), FK, 'upload: channel of store B, store A');
  });

  it('as the app role the same mismatch is refused too (RLS does not hide it) [kills: a guard that only the table owner meets]', async () => {
    const { A } = await base();
    const fx = await intake();
    expectCode(await runAsApp(A.orgId, (tx) => insert(tx, 'settlement_uploads', uploadRow(A, { channel_id: A.channel1, store_id: A.s2 }))), FK, 'app role: upload store mismatch');
    expectCode(await runAsApp(A.orgId, (tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-11-11', channel_id: A.channel1, store_id: A.s2 }))), FK, 'app role: day line store mismatch');
  });

  it('moving a channel to another store is refused (23503, ON UPDATE NO ACTION) while an upload or a day line still references it; with nothing referencing it the move is fine [kills: a guard that lets lines go stale when their channel moves]', async () => {
    const { A } = await base();
    const mk = async (tx: Tx, name: string) => {
      const [c] = await tx<{ id: string }[]>`
        insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${A.orgId}, ${A.s1}, ${uid(name)}, false, '1220') returning id`;
      return c!.id;
    };
    expectOk(await run(async (tx) => {
      const c = await mk(tx, 'Free');
      await tx`update sales_channels set store_id = ${A.s2} where id = ${c}`;
      return 'moved';
    }), 'move a channel nothing references');
    expectCode(await run(async (tx) => {
      const c = await mk(tx, 'WithUpload');
      await insert(tx, 'settlement_uploads', uploadRow(A, { channel_id: c, store_id: A.s1 }));
      await tx`update sales_channels set store_id = ${A.s2} where id = ${c}`;
    }), FK, 'move a channel that an upload references');
    expectCode(await run(async (tx) => {
      const c = await mk(tx, 'WithDay');
      const up = await insert(tx, 'settlement_uploads', uploadRow(A, { channel_id: c, store_id: A.s1 }));
      await insert(tx, 'settlement_day_lines', dayRow(A, up, { channel_id: c, store_id: A.s1, sales_date: '2026-11-12' }));
      await tx`update sales_channels set store_id = ${A.s2} where id = ${c}`;
    }), FK, 'move a channel that a day line references');
  });

  it('the hand-added unique sales_channels_org_id_id_store_id_unique (org_id, id, store_id) exists, and sales_channels keeps exactly one UNIQUE (org_id, id) (t398 K2) [kills: the unique missing; a second (org_id, id) unique]', async () => {
    const rows = await sql<{ name: string; cols: string }[]>`
      select c.conname as name, (select string_agg(a.attname, ',' order by k.ord) from unnest(c.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
        from pg_constraint c where c.conrelid = 'public.sales_channels'::regclass and c.contype = 'u'`;
    expect(rows.find((r) => r.name === 'sales_channels_org_id_id_store_id_unique')?.cols).toBe('org_id,id,store_id');
    expect(rows.filter((r) => r.cols === 'org_id,id').length, 'UNIQUE (org_id, id) count on sales_channels').toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. settlement_loan_lines and settlement_other_lines
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - settlement_loan_lines', () => {
  it('kind must be deduction or disbursal, amount must be > 0, allocation_source auto or admin (23514) [kills: missing CHECKs; amount >= 0]', async () => {
    const { A } = await base();
    const fx = await intake();
    const mk = (over: Row) => run((tx) => insert(tx, 'settlement_loan_lines', loanLineRow(A, fx.dlA, { row_ordinal: 7, ...over })));
    for (const kind of ['deduction', 'disbursal']) expectOk(await mk({ kind }), `kind ${kind}`);
    expectOk(await mk({ allocation_source: 'admin' }), 'allocation_source admin');
    expectCode(await mk({ kind: 'repayment' }), CHECK, 'kind repayment');
    expectCode(await mk({ amount: '0' }), CHECK, 'amount 0');
    expectCode(await mk({ amount: '-1.00' }), CHECK, 'amount negative');
    expectCode(await mk({ allocation_source: 'robot' }), CHECK, 'allocation_source robot');
  });

  it('defaults: a new line is auto-allocated and active, with no loan yet [kills: wrong defaults]', async () => {
    const { A } = await base();
    const fx = await intake();
    const o = await run(async (tx) => {
      const id = await insert(tx, 'settlement_loan_lines', loanLineRow(A, fx.dlA, { row_ordinal: 8 }));
      const [r] = await tx<{ allocation_source: string; is_active: boolean; loan_id: string | null }[]>`select allocation_source, is_active, loan_id from settlement_loan_lines where id = ${id}`;
      return r!;
    });
    expectOk(o, 'defaults');
    if (o.ok) expect(o.value).toEqual({ allocation_source: 'auto', is_active: true, loan_id: null });
  });
});

describe('T-511 S2a / 0228 - settlement_other_lines', () => {
  const KINDS = ['adjustment', 'compensation', 'chargeback', 'withholding_tax', 'advertisement', 'cancelled_order', 'period_charge', 'platform_fee_weekly', 'pandago'];

  it('every kind in the enumeration is accepted (a PandaGO row with booked_as none) and an unknown kind is refused (23514) [kills: a kind missing; no CHECK]', async () => {
    const { A } = await base();
    const fx = await intake();
    for (const kind of KINDS) {
      const o = await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upA, fx.dlA, { kind, booked_as: kind === 'pandago' ? 'none' : 'platformFee' })));
      expectOk(o, `kind ${kind}`);
    }
    expectCode(await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upA, fx.dlA, { kind: 'refund' }))), CHECK, 'kind refund');
  });

  it('booked_as must be platformFee, marketing or none (23514); marketing is accepted for an advertisement [kills: no CHECK; marketing missing]', async () => {
    const { A } = await base();
    const fx = await intake();
    for (const booked_as of ['platformFee', 'marketing', 'none']) {
      expectOk(await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upA, fx.dlA, { kind: 'advertisement', booked_as }))), `booked_as ${booked_as}`);
    }
    expectCode(await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upA, fx.dlA, { booked_as: 'commission' }))), CHECK, 'booked_as commission');
  });

  it('a PandaGO row with booked_as other than none is refused (23514): PandaGO is never booked here [kills: no pandago CHECK]', async () => {
    const { A } = await base();
    const fx = await intake();
    for (const booked_as of ['platformFee', 'marketing']) {
      expectCode(await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upA, fx.dlA, { kind: 'pandago', booked_as }))), CHECK, `pandago booked as ${booked_as}`);
    }
  });

  it('amount is signed (a negative amount inserts) and a period-level line may have no day line [control]', async () => {
    const { A } = await base();
    const fx = await intake();
    expectOk(await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upA, null, { kind: 'period_charge', amount: '-12.50' }))), 'negative amount, no day line');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. finite checks and money scale on the new numeric columns
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - every numeric column on the new tables is numeric(14,2) with a *_finite_check of the exact body (t327 style)', () => {
  it('every numeric column of the four tables and loans.repayment_amount is covered by a check named *_finite_check with the normalised body [kills: a money column without a finite check; a copy-pasted wrong body]', async () => {
    const cols = await sql<{ t: string; c: string; ft: string }[]>`
      select cl.relname as t, a.attname as c, format_type(a.atttypid, a.atttypmod) as ft
        from pg_attribute a join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'public' and cl.relkind = 'r' and a.atttypid = 'numeric'::regtype and a.attnum > 0 and not a.attisdropped
         and (cl.relname = any(${TABLES as unknown as string[]}) or (cl.relname = 'loans' and a.attname = 'repayment_amount'))`;
    const perTable = (t: string) => cols.filter((x) => x.t === t).length;
    expect(perTable('settlement_day_lines'), 'settlement_day_lines numeric columns').toBeGreaterThanOrEqual(10);
    expect(perTable('settlement_loan_lines'), 'settlement_loan_lines numeric columns').toBe(1);
    expect(perTable('settlement_other_lines'), 'settlement_other_lines numeric columns').toBe(1);
    expect(perTable('loans'), 'loans.repayment_amount').toBe(1);
    for (const c of cols) expect(c.ft, `${c.t}.${c.c} type`).toBe('numeric(14,2)');

    const checks = await sql<{ t: string; name: string; c: string; def: string }[]>`
      select cls.relname as t, con.conname as name, att.attname as c, pg_get_constraintdef(con.oid) as def
        from pg_constraint con join pg_class cls on cls.oid = con.conrelid join pg_namespace ns on ns.oid = cls.relnamespace
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
       where ns.nspname = 'public' and con.contype = 'c' and right(con.conname, 13) = '_finite_check'`;
    const guarded = new Map(checks.map((c) => [`${c.t}.${c.c}`, c]));
    const missing = cols.map((c) => `${c.t}.${c.c}`).filter((k) => !guarded.has(k));
    expect(missing, 'numeric columns with no *_finite_check').toEqual([]);
    const wrong = cols
      .map((c) => guarded.get(`${c.t}.${c.c}`)!)
      .filter((g) => g.def.replace(/\s+/g, ' ').trim() !== `CHECK (((${g.c} > '-Infinity'::numeric) AND (${g.c} < 'Infinity'::numeric)))`)
      .map((g) => `${g.t}.${g.name}: ${g.def}`);
    expect(wrong, 'finite checks with the wrong body').toEqual([]);
  });

  it('a NaN in a money column is refused (23514) [kills: > 0 / signed-only checks that NaN passes]', async () => {
    const { A } = await base();
    const fx = await intake();
    const err = expectCode(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-27', order_value: 'NaN' }))), CHECK, 'order_value NaN');
    expect(err.constraint_name ?? '').toMatch(/finite_check$/);
    const other = expectCode(await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upA, fx.dlA, { amount: 'NaN' }))), CHECK, 'other_lines.amount NaN');
    expect(other.constraint_name ?? '').toMatch(/finite_check$/);
    const loanLine = expectCode(await run((tx) => insert(tx, 'settlement_loan_lines', loanLineRow(A, fx.dlA, { amount: 'NaN', row_ordinal: 11 }))), CHECK, 'loan_lines.amount NaN (passes > 0)');
    expect(loanLine.constraint_name ?? '').toMatch(/finite_check$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. composite same-org twin foreign keys: a reference into another org is refused
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - composite same-org FKs: a row of org A pointing at a row of org B is refused (23503)', () => {
  it('settlement_uploads: channel_id, store_id, file_id, pdf_file_id, uploaded_by and superseded_by each refuse an org B target [kills: a missing twin FK on any one column]', async () => {
    const { A, B } = await base();
    const fx = await intake();
    const cases: [string, Row][] = [
      ['channel_id', { channel_id: B.channel1 }],
      ['store_id', { store_id: B.s1 }],
      ['file_id', { file_id: B.file }],
      ['pdf_file_id', { pdf_file_id: B.pdf }],
      ['uploaded_by', { uploaded_by: B.person }],
      ['superseded_by', { superseded_by: fx.upB }],
    ];
    for (const [col, over] of cases) expectCode(await run((tx) => insert(tx, 'settlement_uploads', uploadRow(A, over))), FK, `settlement_uploads.${col} -> org B`);
  });

  it('settlement_day_lines: channel_id, store_id, source_upload_id, payout_upload_id, decided_by and settlement_id each refuse an org B target [kills: a missing twin FK on any one column]', async () => {
    const { A, B } = await base();
    const fx = await intake();
    const NOW = new Date('2026-11-03T08:00:00Z');
    const cases: [string, Row][] = [
      ['channel_id', { channel_id: B.channel1 }],
      ['store_id', { store_id: B.s1 }],
      ['source_upload_id', { source_upload_id: fx.upB }],
      ['payout_upload_id', { payout_upload_id: fx.upB }],
      ['decided_by', { review_state: 'rejected', decision_reason: 'no', decided_by: B.person, decided_at: NOW }],
      ['settlement_id', { review_state: 'booked', decided_by: A.person, decided_at: NOW, settlement_id: B.settlement }],
    ];
    for (const [col, over] of cases) {
      expectCode(await run((tx) => insert(tx, 'settlement_day_lines', dayRow(A, fx.upA, { sales_date: '2026-10-28', ...over }))), FK, `settlement_day_lines.${col} -> org B`);
    }
  });

  it('settlement_loan_lines: day_line_id and loan_id refuse an org B target [kills: a missing twin FK]', async () => {
    const { A, B } = await base();
    const fx = await intake();
    expectCode(await run((tx) => insert(tx, 'settlement_loan_lines', loanLineRow(A, fx.dlB))), FK, 'settlement_loan_lines.day_line_id -> org B');
    expectCode(await run((tx) => insert(tx, 'settlement_loan_lines', loanLineRow(A, fx.dlA, { loan_id: B.loan }))), FK, 'settlement_loan_lines.loan_id -> org B');
    expectOk(await run((tx) => insert(tx, 'settlement_loan_lines', loanLineRow(A, fx.dlA, { loan_id: A.loan, row_ordinal: 5 }))), 'control: loan_id of the same org');
  });

  it('settlement_other_lines: upload_id and day_line_id refuse an org B target [kills: a missing twin FK]', async () => {
    const { A } = await base();
    const fx = await intake();
    expectCode(await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upB, fx.dlA))), FK, 'settlement_other_lines.upload_id -> org B');
    expectCode(await run((tx) => insert(tx, 'settlement_other_lines', otherLineRow(A, fx.upA, fx.dlB))), FK, 'settlement_other_lines.day_line_id -> org B');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 10. stored_files purpose widened
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - stored_files_purpose_check accepts channel_settlement_file and nothing else new', () => {
  const OLD = ['receipt_photo', 'ar_collection_proof', 'memo_document', 'wastage_dispute', 'onboarding_document', 'staff_photo', 'staff_signature', 'leave_document'];
  const fileRow = (o: Side, purpose: string): Row => ({
    org_id: o.orgId, store_id: o.s1, purpose, storage_path: `orgs/${o.orgId}/stores/${o.s1}/${purpose}/${uid('f')}.csv`, content_type: 'text/csv', byte_size: 10, checksum: 'abc', uploaded_by: o.person,
  });

  it('the 8 old purposes and channel_settlement_file all insert [kills: purpose not added; an old purpose dropped]', async () => {
    const { A } = await base();
    for (const p of [...OLD, 'channel_settlement_file']) expectOk(await run((tx) => insert(tx, 'stored_files', fileRow(A, p))), `purpose ${p}`);
  });

  it("'ninth_purpose' (and any other string) is still rejected by stored_files_purpose_check (23514) [kills: the CHECK dropped or widened to anything]", async () => {
    const { A } = await base();
    for (const p of ['ninth_purpose', 'channel_settlement', 'settlement_file']) {
      const err = expectCode(await run((tx) => insert(tx, 'stored_files', fileRow(A, p))), CHECK, `purpose ${p}`);
      expect(err.constraint_name).toBe('stored_files_purpose_check');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 11. log_break_glass_approval carries the three new capability names (BOSS ruling 3)
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S2a / 0228 - log_break_glass_approval is re-created with the new capabilities', () => {
  it('the function body lists upload_settlement_files, edit_platform_store_code and edit_loan_repayment_amount, and its array equals CAPABILITIES exactly [kills: function not re-created; one name missing]', async () => {
    const rows = await sql<{ src: string }[]>`select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'log_break_glass_approval'`;
    expect(rows.length, 'function log_break_glass_approval').toBe(1);
    const src = rows[0]!.src;
    for (const name of ['upload_settlement_files', 'edit_platform_store_code', 'edit_loan_repayment_amount']) expect(src, name).toContain(`'${name}'`);
    const arr = /ARRAY\[([^\]]*)\]/s.exec(src);
    expect(arr, 'an ARRAY[...] capability list in the function body').not.toBeNull();
    const inDb = [...arr![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(inDb).toEqual([...CAPABILITIES].sort());
  });
});
