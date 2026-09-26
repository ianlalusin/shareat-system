/**
 * T-346 S1 — migration 0162's own proof (M1). `docs/tasks/346-store-opening-and-in-service-date.md`
 * §4 (case M1), §3.1, Amendment R1 item 3 (binding — the exact backfill formula).
 *
 * Same technique as `position-access-backfill.test.ts` (0152's own proof): a disposable scratch
 * database, migrated to everything STRICTLY BEFORE the target (a temp folder filtered by journal
 * `when`, never by filename — see that file's own comment for the 0153 incident this avoids),
 * fixtures seeded with raw SQL, then the REAL migrations folder applied (0162 and anything after
 * it, in order). ⛔ This migration only ever runs once per database (RULES §1 rule 9) — the
 * standing lane database cannot prove a backfill against pre-existing data at all.
 *
 * ⛔ RED until migration `0162_t346_*.sql` exists — `buildFolderWithoutTarget` cannot locate a
 * journal entry tagged `0162_` and throws before any fixture is even seeded.
 *
 * "Has traded" / the backfill formula (R1.3, binding — replaces the body's looser wording):
 * `opening_date = least(min(business_date) of sales_days where status <> 'voided', min(entry_date)
 * of journal_entries with source_type = 'sale' and status = 'posted' with a line at the store)`,
 * else NULL. A construction-period expense or a voided-only sales day must not mark a store open.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(
    `Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_TAG_PREFIX = '0162_';

/** A temp copy of `migrations/` with everything at or after 0162's own journal `when` removed —
 *  `migrate()` against it applies every migration strictly BEFORE 0162. Filtered by `when`, never
 *  by filename, so a migration added after 0162 in the future does not silently ride along
 *  (`position-access-backfill.test.ts`'s own header names the exact incident this avoids). */
function buildFolderWithoutTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-0162-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => e.tag.startsWith(TARGET_TAG_PREFIX));
  if (!target) {
    throw new Error(`no journal entry tagged "${TARGET_TAG_PREFIX}" — has 0162 been renamed or removed?`);
  }
  const keptEntries = journal.entries.filter((e: { when: number }) => e.when < target.when);
  const keptTags = new Set(keptEntries.map((e: { tag: string }) => e.tag));

  for (const f of readdirSync(REAL_MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && keptTags.has(f.slice(0, -'.sql'.length))) {
      writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_FOLDER, f)));
    }
  }
  journal.entries = keptEntries;
  writeFileSync(join(metaDir, '_journal.json'), JSON.stringify(journal, null, 2));

  return dir;
}

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

/** DEF-365 — a ceiling for a contended DROP DATABASE, not a claim about typical speed (measured
 *  38s under concurrent load vs. ~60ms quiet, on this same machine — see
 *  `position-access-backfill.test.ts`'s own comment for the full record). */
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

async function applyEverythingExceptTarget(sql: ReturnType<typeof postgres>): Promise<void> {
  const dir = buildFolderWithoutTarget();
  try {
    await migrate(drizzle(sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 0162 and anything added after it, applied together (all pending migrations share one
 *  transaction — confirmed at source, same as 0152's own proof). */
async function applyTarget(sql: ReturnType<typeof postgres>): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrgAndStore(sqlx: ReturnType<typeof postgres>, code: string) {
  const [org] = await sqlx<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [store] = await sqlx<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, ${code}, ${`Store ${code}`}, true) returning id`;
  const [person] = await sqlx<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Fixture Person') returning id`;
  return { orgId: org!.id, storeId: store!.id, personId: person!.id };
}

/** Minimal accounts this file's own postings need — never the full `seedChartOfAccounts`, which
 *  pulls in the domain package; this file stays a pure `packages/db` migration proof. */
async function seedAccounts(sqlx: ReturnType<typeof postgres>, orgId: string): Promise<Record<string, string>> {
  const codes: [string, string, string][] = [
    ['1110', 'Cash on hand', 'asset'],
    ['4100', 'Food sales', 'income'],
    ['6200', 'Rent', 'expense'],
  ];
  const ids: Record<string, string> = {};
  for (const [code, name, type] of codes) {
    const [row] = await sqlx<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable)
      values (${orgId}, ${code}, ${name}, ${type}, ${type === 'income' ? 'credit' : 'debit'}, true)
      returning id`;
    ids[code] = row!.id;
  }
  return ids;
}

async function openPeriodCovering(sqlx: ReturnType<typeof postgres>, orgId: string, date: string): Promise<string> {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const starts = `${y}-${String(m).padStart(2, '0')}-01`;
  const ends = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [row] = await sqlx<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${starts}, ${ends}, 'open')
    returning id`;
  return row!.id;
}

async function postEntryAt(
  sqlx: ReturnType<typeof postgres>,
  orgId: string,
  storeId: string,
  personId: string,
  entryDate: string,
  accts: Record<string, string>,
  sourceType: 'sale' | 'expense',
): Promise<void> {
  const periodId = await openPeriodCovering(sqlx, orgId, entryDate);
  const creditCode = sourceType === 'sale' ? '4100' : '6200';
  // One transaction — each `sqlx\`...\`` statement outside of `sql.begin` auto-commits on its own,
  // so inserting the entry then one line at a time trips migration 0003's minimum-two-lines guard
  // on the entry alone (orchestrator CHANGES, 2026-09-26), same reason T-345's own `postRawEntry`
  // wraps its insert-entry/insert-lines/flip-to-posted sequence in `sql.begin`.
  await sqlx.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${orgId}, ${entryDate}, ${periodId}, ${sourceType}, ${uid('src')}, ${uid('key')}, 'fixture', ${personId}, 'draft')
      returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id) values (${entry!.id}, 1, ${accts['1110']!}, '100.00', 0, ${storeId})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id) values (${entry!.id}, 2, ${accts[creditCode]!}, 0, '100.00', ${storeId})`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
  });
}

async function insertSalesDay(
  sqlx: ReturnType<typeof postgres>,
  orgId: string,
  storeId: string,
  personId: string,
  businessDate: string,
  status: 'open' | 'voided',
): Promise<void> {
  await sqlx`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by, voided_by, voided_at, void_reason)
    values (${orgId}, ${storeId}, ${businessDate}, ${status}, '0', '0', '0', ${personId},
      ${status === 'voided' ? personId : null}, ${status === 'voided' ? sqlx`now()` : null}, ${status === 'voided' ? 'fixture' : null})`;
}

async function openingDateOf(sqlx: ReturnType<typeof postgres>, storeId: string): Promise<string | null> {
  const rows = await sqlx<{ opening_date: string | null }[]>`select opening_date::text as opening_date from stores where id = ${storeId}`;
  return rows[0]?.opening_date ?? null;
}

describe('T-346 S1 / migration 0162 — backfills stores.opening_date (M1)', () => {
  const dbName = `shareat_scratch_0162_backfill_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;

  let firstSaleWinsStoreId: string;
  let noActivityStoreId: string;
  let expenseOnlyStoreId: string;
  let voidedOnlyStoreId: string;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await applyEverythingExceptTarget(sql);

    // Fixture 1 — R1.3's own worked example: first sales_day 2026-08-03, first sale-sourced
    // posted journal line 2026-08-01. least(...) picks 2026-08-01.
    {
      const { orgId, storeId, personId } = await newOrgAndStore(sql, uid('FSW'));
      const accts = await seedAccounts(sql, orgId);
      await insertSalesDay(sql, orgId, storeId, personId, '2026-08-03', 'open');
      await postEntryAt(sql, orgId, storeId, personId, '2026-08-01', accts, 'sale');
      firstSaleWinsStoreId = storeId;
    }

    // Fixture 2 — no activity of any kind. opening_date must stay NULL.
    {
      const { storeId } = await newOrgAndStore(sql, uid('NOA'));
      noActivityStoreId = storeId;
    }

    // Fixture 3 (R1.3) — the store's ONLY activity is a construction-period expense, never a sale.
    // A rent posting must not mark the store open.
    {
      const { orgId, storeId, personId } = await newOrgAndStore(sql, uid('EXP'));
      const accts = await seedAccounts(sql, orgId);
      await postEntryAt(sql, orgId, storeId, personId, '2026-05-10', accts, 'expense');
      expenseOnlyStoreId = storeId;
    }

    // Fixture 4 (R1.3) — the store's ONLY sales day is voided. A voided day must not count.
    {
      const { orgId, storeId, personId } = await newOrgAndStore(sql, uid('VOI'));
      await insertSalesDay(sql, orgId, storeId, personId, '2026-06-01', 'voided');
      voidedOnlyStoreId = storeId;
    }

    await applyTarget(sql);
  });

  // DEF-365 — see dropScratchDatabase's own comment (and position-access-backfill.test.ts's fuller
  // one) for why this ceiling is 120s and not a claim about typical speed.
  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('first sale 08-03 + first sale-sourced posted line 08-01 → least() picks 08-01', async () => {
    expect(await openingDateOf(sql, firstSaleWinsStoreId)).toBe('2026-08-01');
  });

  it('⛔ a store with no activity at all → NULL', async () => {
    expect(await openingDateOf(sql, noActivityStoreId)).toBeNull();
  });

  it('⛔ R1.3: a store whose only activity is a construction-period expense → NULL, not the expense date', async () => {
    expect(await openingDateOf(sql, expenseOnlyStoreId)).toBeNull();
  });

  it('⛔ R1.3: a store whose only sales day is voided → NULL, not the voided day\'s date', async () => {
    expect(await openingDateOf(sql, voidedOnlyStoreId)).toBeNull();
  });

  // ⭐ R3.2 — asserts the backfill's EFFECT precisely (exactly which row, and how many), not merely
  // that the column exists or that "something, somewhere" got set. The migration runs under `SET
  // LOCAL row_security = off` (R3.2) specifically so it sees every org's rows regardless of which
  // role applies this migration; if that ever regressed to a bare application (RLS back on), the
  // backfill would silently match zero rows for an org this test's own role cannot see as itself —
  // an exact count of 1, naming the one store expected to carry it, is what would catch that,
  // where a bare `toBeGreaterThan(0)` would not.
  it('EFFECT, precisely: exactly one of the four fixture stores ends up non-null, and it is the FSW one', async () => {
    const [row] = await sql<{ c: number }[]>`select count(*)::int as c from stores where opening_date is not null`;
    expect(row!.c).toBe(1);
    expect(await openingDateOf(sql, firstSaleWinsStoreId)).toBe('2026-08-01');
    expect(await openingDateOf(sql, noActivityStoreId)).toBeNull();
    expect(await openingDateOf(sql, expenseOnlyStoreId)).toBeNull();
    expect(await openingDateOf(sql, voidedOnlyStoreId)).toBeNull();
  });
});

// =================================================================================================
