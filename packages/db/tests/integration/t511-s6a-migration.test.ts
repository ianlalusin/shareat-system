/**
 * T-511 S6a (TESTER, 7 Nov 2026) - migration 0242 `0242_t511_settlement_loan_legs`: several loan legs per channel settlement.
 * docs/tasks/511-settlement-upload-s6-spec.md "S6a" (migration bullet) and docs/designs/channel-settlement-upload.md Component H items 1-2.
 * Real Postgres via TEST_DATABASE_URL.
 *
 * RED TODAY, for one reason: migration 0242 does not exist, so the legs table, `difference_reason`, the deferred legs-add-up trigger and the registry
 * entries are all absent, and `channel_settlements` still carries `loan_id`, `loan_owner_store_id` and `channel_settlements_loan_shape_check`.
 *
 * PINNED BY THESE TESTS (the builder meets them or asks BOSS to change the tests):
 *  M1  file `0242_t511_settlement_loan_legs.sql`, journal idx 242, `when` 1806982307084 (0239's 1806723107084 + 3 x 86,400,000), breakpoints true.
 *      The spec calls the number provisional: if BOSS gives another, change the constants below, nothing else.
 *  M2  table `channel_settlement_loan_legs(id, org_id, settlement_id, loan_id, owner_store_id NOT NULL, amount numeric(14,2) NOT NULL > 0 and finite)`.
 *      `owner_store_id` is NEVER null: a same-store leg carries the paying store's own id (the backfill uses coalesce(loan_owner_store_id, store_id)).
 *  M3  unique (settlement_id, loan_id, owner_store_id); composite same-org FKs (org_id, x) for settlement, loan and owner store, all ON DELETE RESTRICT.
 *  M4  RLS ENABLE + FORCE, policy `channel_settlement_loan_legs_org_isolation` on app_current_org() in USING and WITH CHECK; the app role has SELECT and
 *      INSERT only (no UPDATE, no DELETE, no TRUNCATE; no column-level UPDATE either): legs are history.
 *  M5  `channel_settlements`: `loan_id`, `loan_owner_store_id`, `channel_settlements_loan_shape_check` and the two same-org twins
 *      (`channel_settlements_loan_id_same_org_fk`, `channel_settlements_loan_owner_store_id_same_org_fk`) are gone; `difference_reason` text, NULL allowed,
 *      a CHECK refuses an empty or whitespace-only value.
 *  M6  a DEFERRED constraint trigger pair (header side and legs side): at commit, sum(legs.amount) = channel_settlements.loan_deduction, and a non-zero
 *      deduction has at least one leg while a zero deduction has none. SQLSTATE 23514, constraint name matches /loan_legs/ and /(sum|total)/. A header written
 *      BEFORE its legs in one transaction is fine. It must work for the app role under RLS at commit, and re-check when only the header's loan_deduction moves.
 *      It is a plain (origin) trigger: not ENABLE ALWAYS.
 *  M7  registries: RLS_REGISTRY, CUTOVER_CLASSIFICATION (purge) and TRIGGER_REGISTRY (origin / validator) carry the new table and every deferred
 *      constraint trigger on the two tables.
 *  M8  backfill: one leg per existing settlement that had a loan (any status), none for a settlement without one, amount = loan_deduction, owner =
 *      coalesce(loan_owner_store_id, store_id). Proved on a throwaway database migrated to everything BEFORE 0242 (house technique of t346-migrations.test.ts).
 *
 * Deferred triggers do not fire in a transaction that is rolled back, so the leg-sum tests either `set constraints all immediate` or really commit.
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, describe, expect, it } from 'vitest';

import { CUTOVER_CLASSIFICATION, PURGE_ORDER_HINT } from '../../src/cutover/classification';
import { APP_ROLE, RLS_REGISTRY } from '../../src/rls/registry';
import { TRIGGER_REGISTRY } from '../../src/triggers/registry';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const LEGS = 'channel_settlement_loan_legs';
const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_IDX = 242;
const TARGET_TAG = '0242_t511_settlement_loan_legs';
const TARGET_WHEN = 1806982307084;

type PgErr = Error & { code?: string; constraint_name?: string };
type Tx = postgres.TransactionSql;
type Row = Record<string, string | number | boolean | null>;
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

const CHECK = '23514';
const UNIQUE = '23505';
const FK = '23503';
const NOPRIV = '42501';

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
const asApp = async (tx: Tx, orgId: string): Promise<void> => {
  await tx.unsafe(`set local role ${APP_ROLE}`);
  await tx`select set_config('app.principal_kind', 'staff', true)`;
  await tx`select set_config('app.org_id', ${orgId}, true)`;
};
async function runAsApp<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<Outcome<T>> {
  return run(async (tx) => {
    await asApp(tx, orgId);
    return fn(tx);
  });
}
/** A transaction that REALLY commits (so the deferred trigger runs at commit); resolves with the error the commit raised, if any. */
async function commit(fn: (tx: Tx) => Promise<void>, orgId?: string): Promise<Outcome<void>> {
  try {
    await sql.begin(async (tx) => {
      if (orgId) await asApp(tx, orgId);
      await fn(tx);
    });
    return { ok: true, value: undefined };
  } catch (e) {
    return { ok: false, err: e as PgErr };
  }
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
// fixtures: two orgs, each with two stores, two loans, a channel, a bank account and a sales day (committed)
// ---------------------------------------------------------------------------------------------------------------------

interface Side {
  orgId: string;
  s1: string;
  s2: string;
  person: string;
  loan1: string;
  loan2: string;
  channel: string;
  bank: string;
  day: string;
  /** a committed settlement with NO loan (loan_deduction 0) and no legs */
  plain: string;
}
let baseP: Promise<{ A: Side; B: Side }> | null = null;
const base = () => (baseP ??= (async () => ({ A: await side('A'), B: await side('B') }))());

async function side(tag: string): Promise<Side> {
  const code = uid(`t511s6a-${tag}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [s1] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S1')}, 'Lipa') returning id`;
  const [s2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S2')}, 'Malvar') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('Admin')}) returning id`;
  const loan = async (store: string, n: string) => {
    const [l] = await sql<{ id: string }[]>`
      insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
      values (${orgId}, ${store}, 'Grab', ${uid(n)}, 5000, 0, 'month', 'straight', 'monthly', 6, '2026-01-01', ${p!.id}) returning id`;
    return l!.id;
  };
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${orgId}, ${s1!.id}, ${uid('Grab')}, false, '1220') returning id`;
  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active) values (${orgId}, ${s1!.id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${s1!.id}, '2026-01-10', '0', '0', '0', ${p!.id}) returning id`;
  const o: Omit<Side, 'plain'> = { orgId, s1: s1!.id, s2: s2!.id, person: p!.id, loan1: await loan(s1!.id, 'L1'), loan2: await loan(s2!.id, 'L2'), channel: ch!.id, bank: bank!.id, day: day!.id };
  const [plain] = await sql<{ id: string }[]>`
    insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, settled_on, created_by)
    values (${orgId}, ${o.s1}, ${o.channel}, ${o.day}, '2026-01-10', '0', '0', '0', ${o.bank}, '2026-01-10', ${o.person}) returning id`;
  return { ...o, plain: plain!.id };
}

/** A draft settlement header that satisfies the row identity: cleared = loan + net. Defaults: a 2,000.00 loan deduction. */
const header = (o: Side, over: Row = {}): Row => ({
  org_id: o.orgId, store_id: o.s1, channel_id: o.channel, sales_day_id: o.day, business_date: '2026-01-10',
  gross_amount: '10000.00', outstanding_cleared: '10000.00', loan_deduction: '2000.00', net_deposited: '8000.00',
  destination_money_account_id: o.bank, settled_on: '2026-01-15', created_by: o.person, ...over,
});
const legRow = (o: Side, settlement: string, over: Row = {}): Row => ({
  org_id: o.orgId, settlement_id: settlement, loan_id: o.loan1, owner_store_id: o.s1, amount: '2000.00', ...over,
});

// ---------------------------------------------------------------------------------------------------------------------
// M1. the file and the journal
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6a / 0242 - the migration file and its journal entry', () => {
  it('0242_t511_settlement_loan_legs.sql exists and is journalled as idx 242, when 1806982307084, breakpoints true, after every earlier entry [kills: wrong number / tag / when; a when that sorts before an applied migration]', () => {
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
// M2-M4. the table: shape, FKs, RLS, grants
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6a / 0242 - the legs table: shape', () => {
  it('has id, org_id, settlement_id, loan_id, owner_store_id (all uuid, NOT NULL) and amount numeric(14,2) NOT NULL [kills: nullable owner store (breaks the unique); amount of the wrong precision]', async () => {
    const cols = await sql<{ attname: string; typ: string; notnull: boolean }[]>`
      select a.attname, format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as notnull
        from pg_attribute a where a.attrelid = ${`public.${LEGS}`}::regclass and a.attnum > 0 and not a.attisdropped`;
    const by = new Map(cols.map((c) => [c.attname, c]));
    for (const name of ['id', 'org_id', 'settlement_id', 'loan_id', 'owner_store_id']) {
      expect(by.get(name), `column ${name}`).toMatchObject({ typ: 'uuid', notnull: true });
    }
    expect(by.get('amount')).toMatchObject({ typ: 'numeric(14,2)', notnull: true });
  });

  it('amount must be > 0: zero and negative are refused (23514) [kills: no CHECK; >= 0]', async () => {
    const { A } = await base();
    for (const amount of ['0.00', '-1.00']) {
      const o = await run((tx) => insert(tx, LEGS, legRow(A, A.plain, { amount })));
      expectCode(o, CHECK, `amount ${amount}`);
    }
  });

  it('amount NaN is refused (23514): NaN sorts above every number, so > 0 alone lets it through [kills: no finite check]', async () => {
    const { A } = await base();
    const o = await run(async (tx) => tx`insert into ${tx(LEGS)} (org_id, settlement_id, loan_id, owner_store_id, amount) values (${A.orgId}, ${A.plain}, ${A.loan1}, ${A.s1}, 'NaN'::numeric)`);
    expectCode(o, CHECK, 'NaN amount');
  });

  it('(settlement_id, loan_id, owner_store_id) is unique (23505); the same loan under another owner store, or another loan, is a different leg [kills: no unique; unique on settlement + loan only; unique on the settlement alone (one leg per settlement)]', async () => {
    const { A } = await base();
    expectCode(
      await run(async (tx) => {
        await insert(tx, LEGS, legRow(A, A.plain));
        await insert(tx, LEGS, legRow(A, A.plain));
      }),
      UNIQUE,
      'the same leg twice',
    );
    expectOk(
      await run(async (tx) => {
        await insert(tx, LEGS, legRow(A, A.plain));
        await insert(tx, LEGS, legRow(A, A.plain, { loan_id: A.loan2, owner_store_id: A.s2 }));
        await insert(tx, LEGS, legRow(A, A.plain, { owner_store_id: A.s2 }));
      }),
      'three distinct legs on one settlement',
    );
  });

  it('every foreign key is a composite that starts with org_id (never a bare single-column FK), covering settlement, loan and owner store, ON DELETE RESTRICT [kills: a bare FK; a missing twin; CASCADE]', async () => {
    const rows = await sql<{ con: string; cols: string[]; ref: string; del: string }[]>`
      select con.conname as con,
             (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
             con.confrelid::regclass::text as ref, con.confdeltype as del
        from pg_constraint con where con.conrelid = ${`public.${LEGS}`}::regclass and con.contype = 'f'`;
    const bad = rows.filter((r) => !(r.cols[0] === 'org_id' && (r.cols.length === 2 || (r.cols.length === 1 && /organizations$/.test(r.ref))))).map((r) => r.con);
    expect(bad, 'FKs that are neither org -> organizations nor composite (org_id, col)').toEqual([]);
    const composite = new Map(rows.filter((r) => r.cols.length === 2).map((r) => [r.cols[1]!, r]));
    expect(composite.get('settlement_id')?.ref, 'settlement twin').toMatch(/channel_settlements$/);
    expect(composite.get('loan_id')?.ref, 'loan twin').toMatch(/loans$/);
    expect(composite.get('owner_store_id')?.ref, 'owner store twin').toMatch(/stores$/);
    for (const r of rows) expect(r.del, `${r.con} ON DELETE`).toBe('r');
  });

  it('a leg of org A pointing at a settlement, loan or owner store of org B is refused (23503); a loan that still has a leg cannot be deleted (23001 restrict_violation) [kills: a missing twin FK; CASCADE]', async () => {
    const { A, B } = await base();
    expectCode(await run((tx) => insert(tx, LEGS, legRow(A, B.plain))), FK, 'settlement of another org');
    expectCode(await run((tx) => insert(tx, LEGS, legRow(A, A.plain, { loan_id: B.loan1 }))), FK, 'loan of another org');
    expectCode(await run((tx) => insert(tx, LEGS, legRow(A, A.plain, { owner_store_id: B.s1 }))), FK, 'owner store of another org');
    expectCode(
      await run(async (tx) => {
        await insert(tx, LEGS, legRow(A, A.plain));
        await tx`delete from loans where id = ${A.loan1}`;
      }),
      '23001', // ON DELETE restrict (not NO ACTION) raises restrict_violation, not 23503
      'deleting a loan that has a leg',
    );
  });
});

describe('T-511 S6a / 0242 - the legs table: RLS and grants (legs are history)', () => {
  it('ENABLE and FORCE ROW LEVEL SECURITY, one policy <table>_org_isolation on app_current_org() in both USING and WITH CHECK [kills: RLS without FORCE; no WITH CHECK; raw current_setting; wrong name]', async () => {
    const [c] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`select relrowsecurity, relforcerowsecurity from pg_class where oid = ${`public.${LEGS}`}::regclass`;
    expect(c).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const p = await sql<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = ${LEGS}`;
    expect(p.map((x) => x.policyname)).toEqual([`${LEGS}_org_isolation`]);
    expect(p[0]!.cmd).toBe('ALL');
    expect(p[0]!.qual ?? '').toMatch(/app_current_org\(\)/);
    expect(p[0]!.qual ?? '').toMatch(/org_id/);
    expect(p[0]!.with_check ?? '').toMatch(/app_current_org\(\)/);
    expect(p[0]!.qual ?? '').not.toMatch(/current_setting/);
  });

  it('table privileges for the app role: SELECT and INSERT yes; UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER no, and no column is updatable [kills: GRANT ALL; a column-level UPDATE grant]', async () => {
    const t = `public.${LEGS}`;
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

  it('as the app role: UPDATE and DELETE of a leg are refused (42501), the committed leg is unchanged [kills: a grant on paper only; DELETE granted]', async () => {
    const { A } = await base();
    const legId = await sql.begin(async (tx) => {
      const h = await insert(tx, 'channel_settlements', header(A));
      return insert(tx, LEGS, legRow(A, h));
    });
    expectCode(await runAsApp(A.orgId, (tx) => tx`update ${tx(LEGS)} set amount = '1.00' where id = ${legId}`), NOPRIV, 'UPDATE as the app role');
    expectCode(await runAsApp(A.orgId, (tx) => tx`delete from ${tx(LEGS)} where id = ${legId}`), NOPRIV, 'DELETE as the app role');
    const [row] = await sql<{ amount: string }[]>`select amount::text from ${sql(LEGS)} where id = ${legId}`;
    expect(row!.amount).toBe('2000.00');
  });

  it('org isolation: org B sees none of org A legs; org B cannot INSERT a leg stamped org A (42501); control: org A can insert its own [kills: no policy; no WITH CHECK; policy on the wrong column]', async () => {
    const { A, B } = await base();
    await sql.begin(async (tx) => {
      const h = await insert(tx, 'channel_settlements', header(A));
      await insert(tx, LEGS, legRow(A, h));
    });
    const seen = await runAsApp(B.orgId, (tx) => tx<{ n: string }[]>`select count(*)::text as n from ${tx(LEGS)} where org_id = ${A.orgId}`);
    expectOk(seen, 'org B select');
    if (seen.ok) expect(seen.value[0]!.n).toBe('0');
    expectCode(await runAsApp(B.orgId, (tx) => insert(tx, LEGS, legRow(A, A.plain))), NOPRIV, 'org B inserts a row stamped org A');
    expectOk(await runAsApp(A.orgId, (tx) => insert(tx, LEGS, legRow(A, A.plain))), 'org A inserts its own leg');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M5. channel_settlements: the old loan columns go, difference_reason arrives
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6a / 0242 - channel_settlements loses the single-loan columns and gains difference_reason', () => {
  it('loan_id and loan_owner_store_id are gone; so are channel_settlements_loan_shape_check and the two same-org twins [kills: a column left behind (two sources of truth); a dangling constraint]', async () => {
    const cols = await sql<{ attname: string }[]>`select attname from pg_attribute where attrelid = 'public.channel_settlements'::regclass and attnum > 0 and not attisdropped`;
    const names = cols.map((c) => c.attname);
    expect(names).not.toContain('loan_id');
    expect(names).not.toContain('loan_owner_store_id');
    expect(names).toContain('loan_deduction');
    const cons = await sql<{ conname: string }[]>`select conname from pg_constraint where conrelid = 'public.channel_settlements'::regclass`;
    const have = new Set(cons.map((c) => c.conname));
    for (const gone of ['channel_settlements_loan_shape_check', 'channel_settlements_loan_id_same_org_fk', 'channel_settlements_loan_owner_store_id_same_org_fk']) {
      expect(have.has(gone), gone).toBe(false);
    }
    // the identity and the rest stay
    expect(have.has('channel_settlements_identity_check')).toBe(true);
    expect(have.has('channel_settlements_loan_deduction_finite_check')).toBe(true);
  });

  it('difference_reason is text and nullable; NULL and a real sentence are accepted, empty and whitespace-only are refused (23514) [kills: NOT NULL; no non-blank CHECK; CHECK without trim]', async () => {
    const { A } = await base();
    const [col] = await sql<{ typ: string; notnull: boolean }[]>`
      select format_type(atttypid, atttypmod) as typ, attnotnull as notnull from pg_attribute where attrelid = 'public.channel_settlements'::regclass and attname = 'difference_reason' and not attisdropped`;
    expect(col, 'channel_settlements.difference_reason').toMatchObject({ typ: 'text', notnull: false });
    expectOk(await run((tx) => tx`update channel_settlements set difference_reason = null where id = ${A.plain}`), 'NULL');
    expectOk(await run((tx) => tx`update channel_settlements set difference_reason = 'Platform short-paid, statement attached' where id = ${A.plain}`), 'a sentence');
    for (const v of ['', '   ']) {
      expectCode(await run((tx) => tx`update channel_settlements set difference_reason = ${v} where id = ${A.plain}`), CHECK, `reason ${JSON.stringify(v)}`);
    }
  });

  it('a raw insert in the new shape (no loan columns) still works: the path t511-s2-migration.test.ts relies on [kills: a required new column without default]', async () => {
    const { A } = await base();
    expectOk(await run((tx) => insert(tx, 'channel_settlements', { ...header(A), loan_deduction: '0.00', net_deposited: '10000.00' })), 'zero-deduction header, no legs');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M6. the deferred "legs add up" trigger
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6a / 0242 - the deferred trigger: legs add up to loan_deduction at commit', () => {
  it('the deduction and its legs agree: header first, legs after, one transaction (the order the domain writes them) [kills: an immediate trigger that refuses a header before its legs]', async () => {
    const { A } = await base();
    expectOk(
      await run(async (tx) => {
        const h = await insert(tx, 'channel_settlements', header(A));
        // still deferred here: nothing has been checked yet
        await tx`select 1`;
        await insert(tx, LEGS, legRow(A, h, { amount: '1500.00' }));
        await insert(tx, LEGS, legRow(A, h, { loan_id: A.loan2, owner_store_id: A.s2, amount: '500.00' }));
        await tx`set constraints all immediate`;
      }),
      'header then two legs summing to the deduction',
    );
  });

  it('legs that do not add up are refused with 23514 naming the constraint, in both directions (short and over) [kills: no trigger; a trigger that checks >=; a trigger on the legs side only]', async () => {
    const { A } = await base();
    for (const amount of ['1999.99', '2000.01']) {
      const e = expectCode(
        await run(async (tx) => {
          const h = await insert(tx, 'channel_settlements', header(A));
          await insert(tx, LEGS, legRow(A, h, { amount }));
          await tx`set constraints all immediate`;
        }),
        CHECK,
        `one leg of ${amount} against a 2000.00 deduction`,
      );
      expect(e.constraint_name ?? '', 'constraint name').toMatch(/loan_legs/);
      expect(e.constraint_name ?? '', 'constraint name').toMatch(/sum|total/);
    }
  });

  it('a non-zero deduction with no leg at all is refused (23514) [kills: a trigger that skips settlements with no legs]', async () => {
    const { A } = await base();
    const e = expectCode(
      await run(async (tx) => {
        await insert(tx, 'channel_settlements', header(A));
        await tx`set constraints all immediate`;
      }),
      CHECK,
      'deduction 2000.00, no leg',
    );
    expect(e.constraint_name ?? '').toMatch(/loan_legs/);
  });

  it('a zero deduction with no leg is fine; a zero deduction WITH a leg is refused (23514) [kills: a trigger that refuses every header without legs; one that lets a leg hang on a zero deduction]', async () => {
    const { A } = await base();
    const zero = { loan_deduction: '0.00', net_deposited: '10000.00' };
    expectOk(
      await run(async (tx) => {
        await insert(tx, 'channel_settlements', header(A, zero));
        await tx`set constraints all immediate`;
      }),
      'zero deduction, no legs',
    );
    const e = expectCode(
      await run(async (tx) => {
        const h = await insert(tx, 'channel_settlements', header(A, zero));
        await insert(tx, LEGS, legRow(A, h, { amount: '10.00' }));
        await tx`set constraints all immediate`;
      }),
      CHECK,
      'zero deduction with a leg',
    );
    expect(e.constraint_name ?? '').toMatch(/loan_legs/);
  });

  it('moving only the header loan_deduction after its legs exist is caught too (identity kept by moving net with it) [kills: a trigger on the legs table only]', async () => {
    const { A } = await base();
    const e = expectCode(
      await run(async (tx) => {
        const h = await insert(tx, 'channel_settlements', header(A));
        await insert(tx, LEGS, legRow(A, h));
        await tx`set constraints all immediate`;
        await tx`update channel_settlements set loan_deduction = '1500.00', net_deposited = '8500.00' where id = ${h}`;
        await tx`set constraints all immediate`;
      }),
      CHECK,
      'header deduction moved away from its legs',
    );
    expect(e.constraint_name ?? '', 'refused by the legs-add-up check, not by some other CHECK').toMatch(/loan_legs/);
  });

  it('a leg added or removed later is caught: an extra leg breaks the sum (23514); the sum is judged per settlement, not over the table [kills: a global sum; a trigger that ignores INSERT on legs]', async () => {
    const { A } = await base();
    const e = expectCode(
      await run(async (tx) => {
        const h = await insert(tx, 'channel_settlements', header(A));
        await insert(tx, LEGS, legRow(A, h));
        await tx`set constraints all immediate`;
        await insert(tx, LEGS, legRow(A, h, { loan_id: A.loan2, owner_store_id: A.s2, amount: '1.00' }));
        await tx`set constraints all immediate`;
      }),
      CHECK,
      'a further leg after the check',
    );
    expect(e.constraint_name ?? '', 'refused by the legs-add-up check, not by some other CHECK').toMatch(/loan_legs/);
  });

  it('REALLY committed as the owner: matching legs commit, a mismatch fails AT COMMIT with 23514 and nothing is kept [kills: a trigger that only fires on SET CONSTRAINTS; a trigger that is not deferrable]', async () => {
    const { A } = await base();
    const before = await sql<{ n: string }[]>`select count(*)::text as n from channel_settlements where org_id = ${A.orgId}`;
    const good = await commit(async (tx) => {
      const h = await insert(tx, 'channel_settlements', header(A));
      await insert(tx, LEGS, legRow(A, h));
    });
    expectOk(good, 'commit with matching legs');
    const bad = await commit(async (tx) => {
      const h = await insert(tx, 'channel_settlements', header(A));
      await insert(tx, LEGS, legRow(A, h, { amount: '1999.00' }));
    });
    const e = expectCode(bad, CHECK, 'commit with a leg short by 1.00');
    expect(e.constraint_name ?? '').toMatch(/loan_legs/);
    const after = await sql<{ n: string }[]>`select count(*)::text as n from channel_settlements where org_id = ${A.orgId}`;
    expect(Number(after[0]!.n), 'only the good settlement was kept').toBe(Number(before[0]!.n) + 1);
  });

  it('under RLS at commit, as the app role: matching legs commit; a mismatch and a deduction with no leg both fail at commit with 23514 [kills: a check that cannot see the rows under RLS and so passes everything; a check that needs the caller to set app.org_id]', async () => {
    const { A } = await base();
    expectOk(
      await commit(async (tx) => {
        const h = await insert(tx, 'channel_settlements', header(A));
        await insert(tx, LEGS, legRow(A, h, { amount: '1200.00' }));
        await insert(tx, LEGS, legRow(A, h, { loan_id: A.loan2, owner_store_id: A.s2, amount: '800.00' }));
      }, A.orgId),
      'app role, matching legs',
    );
    for (const [what, fn] of [
      ['app role, legs short', async (tx: Tx) => void (await insert(tx, LEGS, legRow(A, await insert(tx, 'channel_settlements', header(A)), { amount: '1200.00' })))],
      ['app role, deduction without a leg', async (tx: Tx) => void (await insert(tx, 'channel_settlements', header(A)))],
    ] as const) {
      const e = expectCode(await commit(fn, A.orgId), CHECK, what);
      expect(e.constraint_name ?? '', `${what}: refused by the legs-add-up check at commit`).toMatch(/loan_legs/);
    }
    expectOk(
      await commit(async (tx) => {
        await insert(tx, 'channel_settlements', header(A, { loan_deduction: '0.00', net_deposited: '10000.00' }));
      }, A.orgId),
      'app role, zero deduction without a leg',
    );
  });

  it('a second org cannot attach legs to this org settlement, with or without its own context (FK 23503, then RLS 42501) [kills: a missing twin FK; a missing WITH CHECK]', async () => {
    const { A, B } = await base();
    expectCode(await commit(async (tx) => void (await insert(tx, LEGS, legRow(B, A.plain))), B.orgId), FK, 'org B leg on an org A settlement');
    expectCode(await commit(async (tx) => void (await insert(tx, LEGS, legRow(A, A.plain))), B.orgId), NOPRIV, 'org B stamping org A');
  });

  it('the trigger is a plain deferred constraint trigger, not ENABLE ALWAYS, on BOTH tables [kills: ALWAYS on a validator; only one side wired]', async () => {
    const rows = await sql<{ tbl: string; tgname: string; tgenabled: string; tgdeferrable: boolean; tginitdeferred: boolean }[]>`
      select c.relname as tbl, t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and t.tgconstraint <> 0 and c.relname = any(${['channel_settlements', LEGS]})`;
    for (const tbl of ['channel_settlements', LEGS]) {
      const mine = rows.filter((r) => r.tbl === tbl);
      expect(mine.length, `deferred constraint triggers on ${tbl}`).toBeGreaterThan(0);
      for (const r of mine) expect(r, `${r.tgname}: deferrable, initially deferred, enabled (origin)`).toMatchObject({ tgdeferrable: true, tginitdeferred: true, tgenabled: 'O' });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M7. the registries
// ---------------------------------------------------------------------------------------------------------------------

describe('T-511 S6a / 0242 - the registries know the new table and trigger', () => {
  it('RLS_REGISTRY carries the table with scope org_column [kills: a table the RLS guard does not know]', () => {
    expect(RLS_REGISTRY[LEGS], `RLS_REGISTRY.${LEGS}`).toBeDefined();
    expect(RLS_REGISTRY[LEGS]?.scope).toBe('org_column');
  });

  it('CUTOVER_CLASSIFICATION classifies it purge, and if the explicit purge hint lists it, it comes before its parent [kills: an unclassified table; a purge that deletes the parent first]', () => {
    expect(CUTOVER_CLASSIFICATION[LEGS], `CUTOVER_CLASSIFICATION.${LEGS}`).toBeDefined();
    expect(CUTOVER_CLASSIFICATION[LEGS]?.class).toBe('purge');
    const i = PURGE_ORDER_HINT.indexOf(LEGS);
    if (i >= 0) expect(i, 'legs before channel_settlements in PURGE_ORDER_HINT').toBeLessThan(PURGE_ORDER_HINT.indexOf('channel_settlements'));
  });

  it('every deferred constraint trigger on the two tables is in TRIGGER_REGISTRY as origin / validator, with its own table [kills: an unclassified trigger (the T-354 guard); a validator classed as a history guard]', async () => {
    const rows = await sql<{ tbl: string; tgname: string }[]>`
      select c.relname as tbl, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and t.tgconstraint <> 0 and c.relname = any(${['channel_settlements', LEGS]})`;
    expect(rows.length, 'deferred constraint triggers found').toBeGreaterThan(0);
    for (const r of rows) {
      const e = TRIGGER_REGISTRY[r.tgname];
      expect(e, `TRIGGER_REGISTRY.${r.tgname}`).toBeDefined();
      expect(e).toMatchObject({ table: r.tbl, mode: 'origin', kind: 'validator' });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M8. the backfill, on a throwaway database migrated to everything before 0242
// ---------------------------------------------------------------------------------------------------------------------

function adminUrl(): string {
  const u = new URL(url!);
  u.pathname = '/postgres';
  return u.toString();
}
function urlOf(name: string): string {
  const u = new URL(url!);
  u.pathname = `/${name}`;
  return u.toString();
}
const PRE_DB = `shareat_t511s6a_${Date.now().toString(36)}_test`;

/** A temp copy of `migrations/` with every entry from idx 242 on removed: `migrate()` against it stops just before this slice. */
function folderBefore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-0242-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
  const kept = journal.entries.filter((e) => e.idx < TARGET_IDX);
  const tags = new Set(kept.map((e) => e.tag));
  for (const f of readdirSync(MIGRATIONS)) if (f.endsWith('.sql') && tags.has(f.slice(0, -4))) writeFileSync(join(dir, f), readFileSync(join(MIGRATIONS, f)));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return dir;
}

describe('T-511 S6a / 0242 - the backfill moves every existing single loan into one leg', () => {
  it('on a database at the state just before 0242, then migrated: a leg per settlement with a loan (same-store owner = the paying store, cross-store owner kept, voided included), none for a settlement without one [kills: no backfill; backfill from the wrong column; a NULL owner for a same-store loan; a plain settlement given a phantom leg; a deduction/leg mismatch the deferred trigger would reject]', async () => {
    const admin = postgres(adminUrl(), { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${PRE_DB}"`);
    await admin.unsafe(`CREATE DATABASE "${PRE_DB}"`);
    const pre = postgres(urlOf(PRE_DB), { max: 2 });
    try {
      const dir = folderBefore();
      try {
        await migrate(drizzle(pre), { migrationsFolder: dir });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      // the pre-state really is the old shape (so this test cannot pass vacuously)
      const oldCols = await pre<{ attname: string }[]>`select attname from pg_attribute where attrelid = 'public.channel_settlements'::regclass and attname in ('loan_id', 'loan_owner_store_id') and not attisdropped`;
      expect(oldCols.map((c) => c.attname).sort(), 'pre-state still has the single-loan columns').toEqual(['loan_id', 'loan_owner_store_id']);

      const code = uid('bf');
      const [org] = await pre<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
      const orgId = org!.id;
      const [s1] = await pre<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S1')}, 'Lipa') returning id`;
      const [s2] = await pre<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S2')}, 'Malvar') returning id`;
      const [p] = await pre<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
      const loan = async (store: string) => {
        const [l] = await pre<{ id: string }[]>`
          insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
          values (${orgId}, ${store}, 'Grab', ${uid('L')}, 5000, 0, 'month', 'straight', 'monthly', 6, '2026-01-01', ${p!.id}) returning id`;
        return l!.id;
      };
      const l1 = await loan(s1!.id);
      const l2 = await loan(s2!.id);
      const [ch] = await pre<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${orgId}, ${s1!.id}, ${uid('Grab')}, false, '1220') returning id`;
      const [bank] = await pre<{ id: string }[]>`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active) values (${orgId}, ${s1!.id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
      const [day] = await pre<{ id: string }[]>`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${s1!.id}, '2026-01-10', '0', '0', '0', ${p!.id}) returning id`;
      // old shape rows. identity: outstanding_cleared = loan_deduction + net_deposited (no fees, no variance)
      const old = async (loanDeduction: string, net: string, loanId: string | null, owner: string | null, extra: Record<string, unknown> = {}): Promise<string> => {
        const [r] = await pre<{ id: string }[]>`
          insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, loan_deduction, loan_id, loan_owner_store_id, net_deposited, destination_money_account_id, settled_on, created_by, status, voided_by, voided_at, void_reason)
          values (${orgId}, ${s1!.id}, ${ch!.id}, ${day!.id}, '2026-01-10', ${String(Number(loanDeduction) + Number(net))}, ${String(Number(loanDeduction) + Number(net))}, ${loanDeduction}, ${loanId}, ${owner}, ${net}, ${bank!.id}, '2026-01-15', ${p!.id},
                  ${(extra.status as string) ?? 'draft'}, ${(extra.voidedBy as string) ?? null}, ${extra.voidedBy ? pre`now()` : null}, ${(extra.voidReason as string) ?? null}) returning id`;
        return r!.id;
      };
      const same = await old('590.00', '410.00', l1, null);
      const cross = await old('1770.00', '230.00', l2, s2!.id);
      const sameExplicit = await old('300.00', '700.00', l1, s1!.id);
      const voided = await old('250.00', '750.00', l1, null, { status: 'voided', voidedBy: p!.id, voidReason: 'wrong file' });
      const plain = await old('0.00', '1000.00', null, null);

      // now 0242 (and anything after it)
      await migrate(drizzle(pre), { migrationsFolder: MIGRATIONS });

      const legs = await pre<{ settlement_id: string; org_id: string; loan_id: string; owner_store_id: string; amount: string }[]>`
        select settlement_id::text, org_id::text, loan_id::text, owner_store_id::text, amount::text from channel_settlement_loan_legs where org_id = ${orgId}`;
      const of = (s: string) => legs.filter((l) => l.settlement_id === s);
      expect(of(same)).toEqual([{ settlement_id: same, org_id: orgId, loan_id: l1, owner_store_id: s1!.id, amount: '590.00' }]);
      expect(of(cross)).toEqual([{ settlement_id: cross, org_id: orgId, loan_id: l2, owner_store_id: s2!.id, amount: '1770.00' }]);
      expect(of(sameExplicit)).toEqual([{ settlement_id: sameExplicit, org_id: orgId, loan_id: l1, owner_store_id: s1!.id, amount: '300.00' }]);
      expect(of(voided), 'a voided settlement keeps its history').toEqual([{ settlement_id: voided, org_id: orgId, loan_id: l1, owner_store_id: s1!.id, amount: '250.00' }]);
      expect(of(plain), 'a settlement without a loan gets no leg').toEqual([]);
      expect(legs.length).toBe(4);

      // old columns are gone from the migrated data too, and the deductions are untouched
      const cols = await pre<{ attname: string }[]>`select attname from pg_attribute where attrelid = 'public.channel_settlements'::regclass and attname in ('loan_id', 'loan_owner_store_id') and not attisdropped`;
      expect(cols).toEqual([]);
      const ded = await pre<{ id: string; loan_deduction: string; reason: string | null }[]>`select id::text, loan_deduction::text, difference_reason as reason from channel_settlements where org_id = ${orgId} order by channel_settlements.loan_deduction`;
      expect(ded.map((d) => d.loan_deduction)).toEqual(['0.00', '250.00', '300.00', '590.00', '1770.00']);
      expect(ded.every((d) => d.reason === null)).toBe(true);
    } finally {
      await pre.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${PRE_DB}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  }, 600_000);
});
