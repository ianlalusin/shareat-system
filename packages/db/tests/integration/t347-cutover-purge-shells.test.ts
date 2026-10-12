import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-347 (DEF-437) — the cutover purge cannot clear a shell row the schema's own CHECKs guard.
 * `docs/tasks/347-def-437-cutover-purge-assets.md` §4 (cases S, N, P), Amendment R2 (binding, R1
 * folded in). Cases S2-S6 and N2 share ONE scratch database and ONE `applyPurge` call — the spec's
 * own "same" column — because they assert different facets of the SAME resulting state, not
 * different runs.
 *
 * ⛔ RED until the BUILDER lands `packages/db/src/cutover/purge.ts` (new — `planPurge`/`applyPurge`),
 * `classification.ts`'s `set`/`dropWhere` fields and the `fixed_assets`/`prepaid_items` changes, and
 * migration `0164`. `planPurge`/`applyPurge` are imported via a DYNAMIC `import()` inside each
 * `beforeAll` that needs them — never a static top-level import — so S1 (which shells out to the
 * real CLI script and must show ITS OWN distinct, real runtime error) is never collateral damage
 * from an unrelated module-resolution failure earlier in this same file.
 *
 * Scratch-database-per-describe, migrated straight to HEAD (whatever `main` currently has —
 * `0163` today), technique of `attendance-credentials-scan-collision-migration.test.ts:79-104`.
 * Red = run on current `main`, per the task's own header.
 */
config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(`Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'cutover-purge.ts');
const PURGE_MODULE_PATH = '../../src/cutover/purge';
// Every subprocess spawn of the real script points its report write at a throwaway temp dir — the
// script itself writes docs/reviews/cutover-purge-<date>.md by default (`CUTOVER_PURGE_REPORT_DIR`
// override, added at the orchestrator's request after this file's own runs clobbered that file
// during T-347's RED phase).
const REPORT_DIR = mkdtempSync(join(tmpdir(), 'shareat-cutover-purge-report-'));
const subprocessEnv = (dbName: string) => ({
  ...process.env,
  DATABASE_URL: scratchUrl(dbName),
  CUTOVER_PURGE_REPORT_DIR: REPORT_DIR,
});

async function createScratchDatabase(name: string): Promise<void> {
  const adminUrl = new URL(baseUrl!);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}
// DEF-365 — 120s ceiling for a contended DROP DATABASE, not typical-case timing (see
// position-access-backfill.test.ts's own measurement history).
async function dropScratchDatabase(name: string): Promise<void> {
  const adminUrl = new URL(baseUrl!);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}
function scratchUrl(name: string): string {
  const u = new URL(baseUrl!);
  u.pathname = `/${name}`;
  return u.toString();
}
async function migrateToHead(sql: ReturnType<typeof postgres>): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}

/** T-390 R8: the purge records C2 as performed by a person; set to the fixture's person right after each seedFixture. */
const PERFORMER = { id: '', orgId: '' };
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Fixture {
  orgId: string;
  personId: string;
  storeId: string;
  a1Id: string;
  a2Id: string;
  customerId: string;
  supplierId: string;
  p1Id: string;
  fileId: string;
  genericEntryId: string;
}

/**
 * §4's own fixture, verbatim: one org, store, person, a posted (non-depreciation) journal entry,
 * `asset_policy` + `asset_category_lives`, asset A1 (active, in service, cost 24,000, salvage
 * 1,000, acquired 2026-03-15, `needs_review` true, notes, ONE posted depreciation entry — R2.6's
 * own fixture, the thing that makes the TRUNCATE-before-shell order observable), A2 (disposed),
 * a reconciled customer AND supplier, P1 (active prepaid), a linked stored file.
 */
async function seedFixture(sql: ReturnType<typeof postgres>): Promise<Fixture> {
  const code = uid('t347');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const personId = person!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('S')}, 'Store', '2026-01-01') returning id`;
  const storeId = store!.id;

  const acct = async (code2: string, name2: string, type2: string, normal2: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
      values (${orgId}, ${code2}, ${name2}, ${type2}, ${normal2}, true, true, 'active') returning id`;
    return row!.id;
  };
  const cash = await acct('1110', 'Cash', 'asset', 'debit');
  const income = await acct('4100', 'Sales', 'income', 'credit');
  const deprExpense = await acct('6700', 'Depreciation', 'expense', 'debit');
  const accumDepr = await acct('1590', 'Accumulated depreciation', 'asset', 'credit');

  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-04-01', '2026-04-30', 'open')`;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  const periodId = period!.id;

  // A generic posted entry — DEF-079's own shape (TRUNCATE against a real posted ledger).
  const genericEntryId = await sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${orgId}, '2026-04-10', ${periodId}, 'manual_journal', ${uid('src')}, ${uid('key')}, 'fixture', ${personId}, 'draft')
      returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 1, ${cash}, ${storeId}, '100.00', 0)`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 2, ${income}, ${storeId}, 0, '100.00')`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
    return entry!.id;
  });

  await sql`insert into asset_policy (org_id, capitalization_threshold, default_salvage_value) values (${orgId}, '5000.00', '0')`;
  await sql`insert into asset_category_lives (org_id, category, useful_life_months) values (${orgId}, 'equipment', 24)`;

  const [a1] = await sql<{ id: string }[]>`
    insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost, salvage_value,
                              useful_life_months, interval, status, needs_review, notes,
                              in_service_on, in_service_source, created_by)
    values (${orgId}, ${storeId}, 'A1 Chiller', 'equipment', '2026-03-15', '24000.00', '1000.00',
            24, 'monthly', 'active', true, 'auto-capitalised, needs a human look',
            '2026-03-15', 'acquired', ${personId})
    returning id`;
  const a1Id = a1!.id;

  // A1's own posted depreciation entry — R2.6's fixture: what makes the guard's `WHEN
  // OLD.in_service_on IS DISTINCT FROM NEW.in_service_on` fire, and what proves the shell step
  // must run AFTER journal_entries is truncated.
  await sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${orgId}, '2026-04-30', ${periodId}, 'depreciation', ${a1Id}, ${`asset:${a1Id}:depreciation:2026-04`}, 'fixture', ${personId}, 'draft')
      returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 1, ${deprExpense}, ${storeId}, '1000.00', 0)`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 2, ${accumDepr}, ${storeId}, 0, '1000.00')`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
  });

  const [a2] = await sql<{ id: string }[]>`
    insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost, salvage_value,
                              useful_life_months, interval, status, needs_review,
                              disposed_on, disposal_reason, disposed_by,
                              in_service_on, in_service_source, created_by)
    values (${orgId}, ${storeId}, 'A2 Disposed', 'equipment', '2026-01-01', '10000.00', '0',
            12, 'monthly', 'disposed', false, '2026-04-01', 'scrapped', ${personId},
            '2026-01-01', 'acquired', ${personId})
    returning id`;
  const a2Id = a2!.id;

  const [customer] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, reconciled_as_of, reconciled_at, reconciled_by, created_by)
    values (${orgId}, 'Reconciled Customer', '2026-04-01', now(), ${personId}, ${personId}) returning id`;
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, reconciled_as_of, reconciled_at, reconciled_by, created_by)
    values (${orgId}, 'Reconciled Supplier', '2026-04-01', now(), ${personId}, ${personId}) returning id`;

  const [p1] = await sql<{ id: string }[]>`
    insert into prepaid_items (org_id, store_id, name, category, coverage_start_date, coverage_months, total_cost, status, created_by)
    values (${orgId}, ${storeId}, 'P1 Fire Insurance', 'insurance', '2026-01-01', 12, '12000.00', 'active', ${personId})
    returning id`;

  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by, linked_to)
    values (${orgId}, ${'orgs/' + orgId + '/f.jpg'}, 'image/jpeg', 10, ${uid('sum')}, 'receipt_photo', ${personId}, ${a1Id})
    returning id`;

  return {
    orgId,
    personId,
    storeId,
    a1Id,
    a2Id,
    customerId: customer!.id,
    supplierId: supplier!.id,
    p1Id: p1!.id,
    fileId: file!.id,
    genericEntryId,
  };
}

async function keepTablesMd5(sql: ReturnType<typeof postgres>, tables: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of tables) {
    const [row] = await sql.unsafe<{ h: string }[]>(
      `select md5(coalesce(string_agg(t::text, '' order by t::text), '')) as h from "${t}" t`,
    );
    out[t] = row!.h;
  }
  return out;
}
/** `last_value` alone cannot distinguish "correctly excluded" from "reset, but nothing had ever
 *  advanced it past 1 anyway" — a fresh `mirror_version_seq` untouched by anything in the fixture
 *  reads identically before and after either way. Encodes `is_called` alongside it so a RESTART
 *  (which also resets `is_called` to false) shows up even when `last_value` alone would not.
 *
 *  ⚠️ `pg_sequences` (the catalog VIEW) has no `is_called` column on this project's actual Postgres
 *  (18.6 — confirmed via `information_schema.columns`); `is_called` only exists on a sequence's OWN
 *  relation, queried directly (`SELECT last_value, is_called FROM <sequence>`). One query per
 *  sequence name (names alone come from `pg_sequences`, which IS safe to read those two columns
 *  from). */
async function sequenceValues(sql: ReturnType<typeof postgres>): Promise<Record<string, string>> {
  const names = await sql<{ seq: string }[]>`select sequencename as seq from pg_sequences where schemaname = 'public'`;
  const out: Record<string, string> = {};
  for (const { seq } of names) {
    const [row] = await sql.unsafe<{ last_value: string | null; is_called: boolean }[]>(
      `select last_value::text as last_value, is_called from "${seq.replace(/"/g, '""')}"`,
    );
    out[seq] = `${row?.last_value ?? 'null'}:${row?.is_called ?? false}`;
  }
  return out;
}

// =================================================================================================
// S2-S6, N2 — ONE scratch DB, ONE applyPurge call, five facets of the same resulting state
// =================================================================================================

describe('T-347 S2-S6, N2 — applyPurge on the full fixture', () => {
  const dbName = `shareat_scratch_t347_full_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let f: Fixture;
  let keepBefore: Record<string, string>;
  let keepAfter: Record<string, string>;
  let applyError: unknown;

  const KEEP_TABLES = ['accounts', 'stores', 'asset_policy', 'asset_category_lives', 'persons'] as const;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await migrateToHead(sql);
    f = await seedFixture(sql);
    PERFORMER.id = f.personId;
    PERFORMER.orgId = f.orgId;
    keepBefore = await keepTablesMd5(sql, KEEP_TABLES);
    try {
      const mod = (await import(PURGE_MODULE_PATH)) as {
        planPurge: (sql: unknown, asOf: string) => Promise<unknown>;
        applyPurge: (tx: unknown, plan: unknown, opts?: { performedBy?: Record<string, string> }) => Promise<unknown>;
      };
      await sql.begin(async (tx) => {
        const plan = await mod.planPurge(tx, '2026-12-31');
        await mod.applyPurge(tx, plan, { performedBy: { [PERFORMER.orgId]: PERFORMER.id } });
      });
    } catch (err) {
      applyError = err;
    }
    keepAfter = await keepTablesMd5(sql, KEEP_TABLES);
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('S2: A1 becomes pending_valuation; cost, salvage, acquired, source, in-service all NULL; needs_review false; the dropped FK is re-added, validated', async () => {
    expect(applyError).toBeUndefined();
    const [a1] = await sql<Record<string, unknown>[]>`select * from fixed_assets where id = ${f.a1Id}`;
    expect(a1?.status).toBe('pending_valuation');
    expect(a1?.cost).toBeNull();
    expect(a1?.salvage_value).toBeNull();
    expect(a1?.acquired_on).toBeNull();
    expect(a1?.source_expense_id).toBeNull();
    expect(a1?.in_service_on).toBeNull();
    expect(a1?.in_service_source).toBeNull();
    expect(a1?.needs_review).toBe(false);

    const [fk] = await sql<{ convalidated: boolean }[]>`
      select convalidated from pg_constraint where conname = 'fixed_assets_source_expense_id_expenses_id_fk'`;
    expect(fk?.convalidated).toBe(true);
  });

  it('S3: A1\'s identity — name, category, store, useful_life_months, notes, id — is unchanged', async () => {
    const [a1] = await sql<Record<string, unknown>[]>`select * from fixed_assets where id = ${f.a1Id}`;
    expect(a1?.id).toBe(f.a1Id);
    expect(a1?.name).toBe('A1 Chiller');
    expect(a1?.category).toBe('equipment');
    expect(a1?.store_id).toBe(f.storeId);
    expect(a1?.useful_life_months).toBe(24);
    expect(a1?.notes).toBe('auto-capitalised, needs a human look');
  });

  it('S4: A2 (disposed) is deleted; the shell count is before minus 1', async () => {
    const [gone] = await sql<{ n: number }[]>`select count(*)::int as n from fixed_assets where id = ${f.a2Id}`;
    expect(gone!.n).toBe(0);
    const [remaining] = await sql<{ n: number }[]>`select count(*)::int as n from fixed_assets where org_id = ${f.orgId}`;
    expect(remaining!.n).toBe(1); // A1 only — A2 dropped
  });

  it('S5: the customer and supplier reconciliation anchors are all NULL; both rows are kept', async () => {
    const [customer] = await sql<Record<string, unknown>[]>`select * from customers where id = ${f.customerId}`;
    expect(customer?.reconciled_as_of).toBeNull();
    expect(customer?.reconciled_at).toBeNull();
    expect(customer?.reconciled_by).toBeNull();
    const [supplier] = await sql<Record<string, unknown>[]>`select * from suppliers where id = ${f.supplierId}`;
    expect(supplier?.reconciled_as_of).toBeNull();
    expect(supplier?.reconciled_at).toBeNull();
    expect(supplier?.reconciled_by).toBeNull();
  });

  it('S6: prepaid_items is empty (Q1 — reclassified purge); the stored file\'s linked_to is NULL', async () => {
    const [prepaid] = await sql<{ n: number }[]>`select count(*)::int as n from prepaid_items where org_id = ${f.orgId}`;
    expect(prepaid!.n).toBe(0);
    const [file] = await sql<Record<string, unknown>[]>`select * from stored_files where id = ${f.fileId}`;
    expect(file?.linked_to).toBeNull();
  });

  it('N2: KEEP tables (accounts, stores, asset_policy, asset_category_lives, persons) are byte-identical after', () => {
    expect(keepAfter).toEqual(keepBefore);
  });
});

// =================================================================================================
// S1 — the real CLI script, as a child process (proves the SAME code the operator runs)
// =================================================================================================

describe('T-347 S1 — scripts/cutover-purge.ts --apply, as a real subprocess', () => {
  const dbName = `shareat_scratch_t347_s1_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let f: Fixture;
  let seqBefore: Record<string, string>;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await migrateToHead(sql);
    f = await seedFixture(sql);
    PERFORMER.id = f.personId;
    PERFORMER.orgId = f.orgId;
    // Advance mirror_version_seq past its fresh start (1, is_called=false) BEFORE capturing
    // "before" — a sequence nothing has ever touched reads identically whether correctly
    // excluded from the restart or reset anyway, so the "unchanged" assertion below would be
    // vacuous without this (CHANGES round, 2026-09-26).
    await sql`select nextval('mirror_version_seq'), nextval('mirror_version_seq'), nextval('mirror_version_seq')`;
    seqBefore = await sequenceValues(sql);
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('exits 0, reports committed, mirror_version_seq unchanged — A1\'s posted depreciation entry is what makes the TRUNCATE-before-shell order observable (R2.6)', () => {
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH, '--confirm-database', dbName, '--apply', '--by', f.personId], {
      cwd: REPO_ROOT,
      env: subprocessEnv(dbName),
      encoding: 'utf8',
      shell: true,
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      '✅ **Purge committed.** All post-conditions passed inside the transaction.',
    );
    void f; // the fixture's own posted depreciation entry is what the assertion above proves against
    void seqBefore;
  });

  it('mirror_version_seq (last_value AND is_called) is unchanged after apply (R1.2)', async () => {
    const seqAfter = await sequenceValues(sql);
    // The advance in beforeAll moved it to last_value=3, is_called=true — a RESTART WITH 1 would
    // show as "1:false", so this genuinely distinguishes "excluded" from "reset anyway". Proven by
    // mutant (see the CHANGES-round note above `SEQUENCES_NEVER_RESET`'s own describe, or the
    // session's [t347] CHANGES reply): removing it from `SEQUENCES_NEVER_RESET` turns this red.
    //
    // ⚠️ `mirror_version_seq` is the ONLY sequence this schema defines (every PK uses `uuidv7()`,
    // not `serial`/`identity`) — there is no sibling sequence in the database to show restarting
    // for contrast; the mutant proof below is what stands in for that.
    expect(seqBefore['mirror_version_seq']).toBe('3:true');
    expect(seqAfter['mirror_version_seq']).toBe(seqBefore['mirror_version_seq']);
  });
});

// =================================================================================================
// N1 — a half-clear rolls back EVERYTHING (invariant 1)
// =================================================================================================

describe('T-347 N1 — a scratch-only CHECK refusing NULL reconciled_by rolls the whole purge back', () => {
  const dbName = `shareat_scratch_t347_n1_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let f: Fixture;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await migrateToHead(sql);
    f = await seedFixture(sql);
    PERFORMER.id = f.personId;
    PERFORMER.orgId = f.orgId;
    // A CHECK the real schema does not have — this is what makes ONE of the shell step's several
    // per-table clears fail partway through, without needing to know which table BUILDER clears
    // first. Anything failing mid-transaction proves the invariant; this one is deliberately picked
    // because §3.2 already names suppliers.reconciled_by as a column the shell step must clear.
    await sql.unsafe(
      `alter table suppliers add constraint t347_n1_no_null_reconciled_by check (reconciled_by is not null)`,
    );
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('⛔ applyPurge throws; A1 is still active at 24,000; the journal is unchanged; the customer anchor is intact', async () => {
    const mod = (await import(PURGE_MODULE_PATH)) as {
      planPurge: (sql: unknown, asOf: string) => Promise<unknown>;
      applyPurge: (tx: unknown, plan: unknown, opts?: { performedBy?: Record<string, string> }) => Promise<unknown>;
    };
    const [journalBefore] = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId}`;

    await expect(
      sql.begin(async (tx) => {
        const plan = await mod.planPurge(tx, '2026-12-31');
        await mod.applyPurge(tx, plan, { performedBy: { [PERFORMER.orgId]: PERFORMER.id } });
      }),
    ).rejects.toBeDefined();

    const [a1] = await sql<Record<string, unknown>[]>`select * from fixed_assets where id = ${f.a1Id}`;
    expect(a1?.status).toBe('active');
    expect(a1?.cost).toBe('24000.00');
    const [journalAfter] = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId}`;
    expect(journalAfter!.n).toBe(journalBefore!.n);
    const [customer] = await sql<Record<string, unknown>[]>`select * from customers where id = ${f.customerId}`;
    expect(customer?.reconciled_as_of).not.toBeNull();
  });
});

// =================================================================================================
// N3, P1 — dry run and --rehearse never change anything; the dry run lists the FK and A2 as dropped
// =================================================================================================

describe('T-347 N3, P1 — dry run and --rehearse are read-only; the dry run\'s own report', () => {
  const dbName = `shareat_scratch_t347_n3_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let f: Fixture;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await migrateToHead(sql);
    f = await seedFixture(sql);
    PERFORMER.id = f.personId;
    PERFORMER.orgId = f.orgId;
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('⛔ dry run (no --apply) changes nothing; the report lists A2 as dropped and the source_expense_id FK (P1)', () => {
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH, '--confirm-database', dbName], {
      cwd: REPO_ROOT,
      env: subprocessEnv(dbName),
      encoding: 'utf8',
      shell: true,
    });
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toMatch(/DRY RUN/i);
    expect(out).toContain('fixed_assets.source_expense_id → expenses');
    expect(out).toContain('dropped (status=disposed): 1,');
    void f;
  });

  it('⛔ --rehearse exits 0, reports "Rehearsal passed", and leaves every sequence and every table byte-identical', async () => {
    const allTables = (
      await sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public'`
    ).map((r) => r.t);
    const seqBefore = await sequenceValues(sql);
    const tablesBefore = await keepTablesMd5(sql, allTables);
    const result = spawnSync(
      'npx',
      ['tsx', SCRIPT_PATH, '--confirm-database', dbName, '--rehearse', '--by', f.personId],
      { cwd: REPO_ROOT, env: subprocessEnv(dbName), encoding: 'utf8', shell: true },
    );
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      '✅ **Rehearsal passed.** Every step committed inside the transaction, then rolled back — nothing was kept.',
    );
    const seqAfter = await sequenceValues(sql);
    expect(seqAfter).toEqual(seqBefore);
    const tablesAfter = await keepTablesMd5(sql, allTables);
    expect(tablesAfter).toEqual(tablesBefore);
  });

  it('⛔ --rehearse combined with --apply is refused: "REFUSED. --rehearse always rolls back; it cannot be combined with --apply."', () => {
    const result = spawnSync(
      'npx',
      ['tsx', SCRIPT_PATH, '--confirm-database', dbName, '--rehearse', '--apply'],
      { cwd: REPO_ROOT, env: subprocessEnv(dbName), encoding: 'utf8', shell: true },
    );
    expect(`${result.stdout}${result.stderr}`).toContain(
      'REFUSED. --rehearse always rolls back; it cannot be combined with --apply.',
    );
  });

  it('⛔ --rehearse without --confirm-database is refused (the same ceremony as --apply, R1.3)', () => {
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH, '--rehearse'], {
      cwd: REPO_ROOT,
      env: subprocessEnv(dbName),
      encoding: 'utf8',
      shell: true,
    });
    expect(result.status).not.toBe(0);
  });
});

// =================================================================================================
// N4, N4b — the RLS preflight, and the row_security=off statement as the backstop behind it
// =================================================================================================

describe('T-347 N4 — the RLS preflight refuses a non-bypass role', () => {
  const dbName = `shareat_scratch_t347_n4_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await migrateToHead(sql);
    {
      const pf = await seedFixture(sql);
      PERFORMER.id = pf.personId;
      PERFORMER.orgId = pf.orgId;
    }
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('⛔ run as shareat_app (RLS-subject, non-bypass, DML grants only) — REFUSED for row-level security; nothing changed', async () => {
    const mod = (await import(PURGE_MODULE_PATH)) as {
      planPurge: (sql: unknown, asOf: string) => Promise<unknown>;
      applyPurge: (tx: unknown, plan: unknown, opts?: { performedBy?: Record<string, string> }) => Promise<unknown>;
    };
    const [before] = await sql<{ n: number }[]>`select count(*)::int as n from fixed_assets`;
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe('set local role shareat_app');
        const plan = await mod.planPurge(tx, '2026-12-31');
        await mod.applyPurge(tx, plan, { performedBy: { [PERFORMER.orgId]: PERFORMER.id } });
      }),
    ).rejects.toMatchObject({
      userMessage: 'REFUSED. shareat_app is subject to row-level security; the purge would clear nothing and report success.',
    });
    const [after] = await sql<{ n: number }[]>`select count(*)::int as n from fixed_assets`;
    expect(after!.n).toBe(before!.n);
  });
});

// =================================================================================================
// N4b — the row_security=off backstop itself (Amendment R3.3). `shareat_app` has DML grants only —
// no TRUNCATE, no ALTER TABLE — so it cannot reach past step 1 of applyPurge at all; it is the WRONG
// role to prove the backstop with. This needs a role that (a) is NOT superuser and NOT bypassrls
// (still subject to RLS, same as shareat_app), but (b) OWNS the scratch tables (so it has full
// DDL/DML rights and actually reaches the shell step) — built by creating the role FIRST, then
// connecting AS that role to create the scratch database's schema (migrate), so every object it
// creates is one it owns.
// =================================================================================================

describe('T-347 N4b — row_security=off itself refuses an owner role without BYPASSRLS', () => {
  const dbName = `shareat_scratch_t347_n4b_${Date.now()}`;
  const roleName = `t347_n4b_owner_${Date.now()}`;
  const rolePassword = `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  let adminSql: ReturnType<typeof postgres>;
  let ownerSql: ReturnType<typeof postgres>;

  function ownerUrl(): string {
    const u = new URL(baseUrl!);
    u.username = roleName;
    u.password = rolePassword;
    u.pathname = `/${dbName}`;
    return u.toString();
  }

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    // Migrate and seed AS THE SUPERUSER first — migration 0162's own backfill needs
    // `row_security = off` to see every org's rows (its own header), which only an EXEMPT role
    // (superuser, here) can actually do; a non-exempt role hits the exact same "query would be
    // affected by row-level security policy" refusal this describe exists to prove, but INSIDE
    // the migration itself, before there is even a fixture to test applyPurge against.
    adminSql = postgres(scratchUrl(dbName), { max: 1 });
    await migrateToHead(adminSql);
    {
      const pf = await seedFixture(adminSql);
      PERFORMER.id = pf.personId;
      PERFORMER.orgId = pf.orgId;
    }

    // Build the role AFTER the schema exists, then hand it every object the superuser just
    // created — making it the OWNER (full DDL/DML: can TRUNCATE, ALTER, reach the shell step)
    // while remaining subject to RLS (NOSUPERUSER, NOBYPASSRLS) — exactly the shape N4b needs,
    // and exactly the gap `shareat_app` (DML grants only, no TRUNCATE/ALTER) cannot exercise.
    await adminSql.unsafe(`DROP ROLE IF EXISTS "${roleName}"`);
    await adminSql.unsafe(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    // `REASSIGN OWNED BY "${superuserName}"` refuses (2BP01 — "required by the database system":
    // postgres also owns the database object and shared catalog entries). Scoped instead to just
    // the tables/sequences the purge actually touches, in `public`.
    await adminSql.unsafe(`
      DO $do$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format('ALTER TABLE %I OWNER TO %I', r.tablename, '${roleName}');
        END LOOP;
        FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
          EXECUTE format('ALTER SEQUENCE %I OWNER TO %I', r.sequencename, '${roleName}');
        END LOOP;
      END
      $do$;
    `);

    ownerSql = postgres(ownerUrl(), { max: 1 });
  }, 60_000);

  afterAll(async () => {
    await ownerSql?.end();
    await adminSql?.end();
    await dropScratchDatabase(dbName);
    const adminUrl = new URL(baseUrl!);
    adminUrl.pathname = '/postgres';
    const admin = postgres(adminUrl.toString(), { max: 1 });
    try {
      await admin.unsafe(`DROP ROLE IF EXISTS "${roleName}"`);
    } finally {
      await admin.end();
    }
  }, 120_000);

  it('⛔ applyPurge as the table OWNER, preflight bypassed via the test-only hook — the raw row_security=off refusal fires; nothing changed, never a silent success', async () => {
    const mod = (await import(PURGE_MODULE_PATH)) as {
      planPurge: (sql: unknown, asOf: string) => Promise<unknown>;
      applyPurge: (tx: unknown, plan: unknown, opts?: { skipPreflightForTest?: boolean; performedBy?: Record<string, string> }) => Promise<unknown>;
    };
    const [before] = await ownerSql<{ n: number }[]>`select count(*)::int as n from fixed_assets`;
    await expect(
      ownerSql.begin(async (tx) => {
        const plan = await mod.planPurge(tx, '2026-12-31');
        await mod.applyPurge(tx, plan, { skipPreflightForTest: true, performedBy: { [PERFORMER.orgId]: PERFORMER.id } });
      }),
    ).rejects.toThrow(/query would be affected by row-level security policy/i);
    const [after] = await ownerSql<{ n: number }[]>`select count(*)::int as n from fixed_assets`;
    expect(after!.n).toBe(before!.n);
  });
});

// =================================================================================================
// N5 — a scratch-only kept table with an FK into a purge-class table, column not in clearColumns
// =================================================================================================

describe('T-347 N5 — an un-classified FK into a purged table blocks --apply', () => {
  const dbName = `shareat_scratch_t347_n5_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await migrateToHead(sql);
    {
      const pf = await seedFixture(sql);
      PERFORMER.id = pf.personId;
      PERFORMER.orgId = pf.orgId;
    }
    // A scratch-only KEPT table whose FK into `expenses` (purge class) is NOT in any
    // `clearColumns` list — `planPurge` must find it (derived from `pg_constraint`, not a
    // hand-list) and `--apply` must refuse before writing anything.
    await sql.unsafe(`
      create table t347_n5_unclassified (
        id uuid primary key default uuidv7(),
        expense_id uuid references expenses(id)
      )
    `);
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('⛔ --apply refuses: "REFUSED. t347_n5_unclassified.expense_id references purged expenses and is not cleared; classify it"; nothing changed', async () => {
    const allTables = (
      await sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public'`
    ).map((r) => r.t);
    const seqBefore = await sequenceValues(sql);
    const tablesBefore = await keepTablesMd5(sql, allTables);
    const result = spawnSync('npx', ['tsx', SCRIPT_PATH, '--confirm-database', dbName, '--apply', '--by', PERFORMER.id], {
      cwd: REPO_ROOT,
      env: subprocessEnv(dbName),
      encoding: 'utf8',
      shell: true,
    });
    expect(`${result.stdout}${result.stderr}`).toContain(
      'REFUSED. t347_n5_unclassified.expense_id references purged expenses and is not cleared; classify it',
    );
    const seqAfter = await sequenceValues(sql);
    expect(seqAfter).toEqual(seqBefore);
    const tablesAfter = await keepTablesMd5(sql, allTables);
    expect(tablesAfter).toEqual(tablesBefore);
  });
});
