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
// I9 — S2, migration 0163's own triggers/CHECK (R1.9: appended here rather than a new file, DB /
// APP role / raw SQL, same family as this file's own M1). Not a backfill-proof scratch DB like M1
// above — these are ordinary INSERT/UPDATE behaviours against the real `_test` database, which
// already has 0163 applied once the builder lands it. §3.3 steps 3-6, Amendment R4 (R1.1, R1.2,
// R1.8, R4.2).
//
// ⛔ RED until migration `0163_t346_asset_in_service.sql` exists: every case here selects or writes
// `fixed_assets.in_service_on` / `in_service_source`, which do not exist yet — "column ... does not
// exist" — except the two guard-trigger cases, which instead find no rejection at all (the trigger
// does not exist to raise it), and the two CHECK cases (23514), which likewise find the INSERT
// resolves instead of rejecting, since the CHECK does not exist yet either.
// =================================================================================================

describe('T-346 S2 / migration 0163 — the in-service fill trigger, its guard, and the shape CHECK (I9)', () => {
  const sql9 = postgres(baseUrl!, { max: 5 });
  let seq9 = 0;
  const uid9 = (p: string) => `i9-${p}-${Date.now()}-${++seq9}`;

  afterAll(async () => {
    await sql9.end({ timeout: 5 });
  });

  async function org9(codeHint: string) {
    const code = uid9(codeHint);
    const [org] = await sql9<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    return org!.id;
  }
  async function store9(orgId: string, openingDate: string | null): Promise<string> {
    const [row] = await sql9<{ id: string }[]>`
      insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid9('s')}, 'Store', ${openingDate}) returning id`;
    return row!.id;
  }
  async function person9(orgId: string): Promise<string> {
    const [row] = await sql9<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Fixture') returning id`;
    return row!.id;
  }
  /** Every column `fixed_assets_valuation_shape_check` requires when NOT `pending_valuation`. */
  async function insertAsset9(input: {
    orgId: string;
    storeId: string;
    personId: string;
    acquiredOn: string;
    cost?: string;
    usefulLifeMonths?: number;
    interval?: 'monthly' | 'quarterly' | 'semiannual' | 'annually';
    status?: 'active' | 'pending_valuation';
    inServiceSource?: 'acquired' | 'store_opening' | 'set' | null;
    inServiceOn?: string | null;
  }): Promise<string> {
    const cols: string[] = ['org_id', 'store_id', 'name', 'category', 'acquired_on', 'cost', 'salvage_value', 'useful_life_months', 'interval', 'status', 'created_by'];
    const status = input.status ?? 'active';
    const vals: unknown[] = [
      input.orgId, input.storeId, 'Chiller', 'equipment', input.acquiredOn, input.cost ?? '24000.00', '0',
      input.usefulLifeMonths ?? 24, input.interval ?? 'monthly', status, input.personId,
    ];
    if (input.inServiceSource !== undefined) {
      cols.push('in_service_source');
      vals.push(input.inServiceSource);
    }
    if (input.inServiceOn !== undefined) {
      cols.push('in_service_on');
      vals.push(input.inServiceOn);
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const [row] = (await sql9.unsafe(
      `insert into fixed_assets (${cols.join(', ')}) values (${placeholders}) returning id`,
      vals as never[],
    )) as unknown as { id: string }[];
    return row!.id;
  }
  async function inServiceOf9(assetId: string): Promise<{ source: string | null; on: string | null }> {
    const [row] = await sql9<{ in_service_source: string | null; in_service_on: string | null }[]>`
      select in_service_source, in_service_on::text as in_service_on from fixed_assets where id = ${assetId}`;
    return { source: row?.in_service_source ?? null, on: row?.in_service_on ?? null };
  }
  async function openPeriod9(orgId: string, aroundDate: string): Promise<void> {
    const [y, m] = aroundDate.split('-').map(Number) as [number, number];
    await sql9`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${`${y}-${String(m).padStart(2, '0')}-01`}, ${new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)}, 'open')`;
  }
  async function seedAccounts9(orgId: string): Promise<Record<string, string>> {
    const codes: [string, string, string][] = [
      ['6700', 'Depreciation', 'expense'],
      ['1590', 'Accumulated depreciation', 'asset'],
    ];
    const ids: Record<string, string> = {};
    for (const [code, name, type] of codes) {
      const [row] = await sql9<{ id: string }[]>`
        insert into accounts (org_id, code, name, type, normal_balance, is_postable)
        values (${orgId}, ${code}, ${name}, ${type}, ${type === 'income' ? 'credit' : 'debit'}, true) returning id`;
      ids[code] = row!.id;
    }
    return ids;
  }
  /** Posts one depreciation entry with a caller-chosen KEY MONTH and a caller-chosen entry_date, so
   *  R1.2's "the month comes from the KEY, never entry_date" can be tested directly — mirrors
   *  T-345's own catch-up shape (dated on the booking day, keyed to the month it belongs to). */
  async function postDepreciationKeyed(
    orgId: string,
    storeId: string,
    personId: string,
    assetId: string,
    keyMonth: string,
    entryDate: string,
    accts: Record<string, string>,
  ): Promise<void> {
    await openPeriod9(orgId, entryDate);
    await sql9.begin(async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
        values (${orgId}, ${entryDate},
          (select id from fiscal_periods where org_id = ${orgId} and starts_on <= ${entryDate} and ends_on >= ${entryDate}),
          'depreciation', ${assetId}, ${`asset:${assetId}:depreciation:${keyMonth}`}, 'fixture', ${personId}, 'draft')
        returning id`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id) values (${entry!.id}, 1, ${accts['6700']!}, '1000.00', 0, ${storeId})`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id) values (${entry!.id}, 2, ${accts['1590']!}, 0, '1000.00', ${storeId})`;
      await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
    });
  }
  async function expectGuard9(promise: Promise<unknown>, detail: RegExp): Promise<void> {
    await expect(promise).rejects.toMatchObject({ code: 'P0001', message: expect.stringMatching(detail) });
  }

  // --- R1.8 / §3.3 step 4 — the fill rule itself -------------------------------------------------

  it('an insert with no in-service columns is filled both ways: store_opening when the store has no date, acquired when it already opened', async () => {
    const orgId = await org9('fill');
    const personId = await person9(orgId);
    const heldStore = await store9(orgId, null);
    const openStore = await store9(orgId, '2020-01-01');

    const heldAsset = await insertAsset9({ orgId, storeId: heldStore, personId, acquiredOn: '2026-03-15' });
    expect(await inServiceOf9(heldAsset)).toEqual({ source: 'store_opening', on: null });

    const acquiredAsset = await insertAsset9({ orgId, storeId: openStore, personId, acquiredOn: '2026-03-15' });
    expect(await inServiceOf9(acquiredAsset)).toEqual({ source: 'acquired', on: '2026-03-15' });
  });

  it('source NULL with in_service_on supplied ⇒ "set", the value is kept (R1.8)', async () => {
    const orgId = await org9('setfill');
    const personId = await person9(orgId);
    const storeId = await store9(orgId, null);
    const assetId = await insertAsset9({
      orgId, storeId, personId, acquiredOn: '2026-03-15', inServiceOn: '2026-12-01',
    });
    expect(await inServiceOf9(assetId)).toEqual({ source: 'set', on: '2026-12-01' });
  });

  it('⛔ R1.8/R4.2: "acquired" with a supplied value ≠ acquired_on raises "must equal it"', async () => {
    const orgId = await org9('acqmismatch');
    const personId = await person9(orgId);
    const storeId = await store9(orgId, null);
    await expectGuard9(
      Promise.resolve(
        insertAsset9({
          orgId, storeId, personId, acquiredOn: '2026-03-15',
          inServiceSource: 'acquired', inServiceOn: '2026-04-01',
        }),
      ),
      /an in-service date on the acquisition date must equal it/,
    );
  });

  // T-347 Amendment R3.2 — this used to assert a 23514 refusal, but that only ever held because
  // the pre-0164 `fixed_assets_disposal_pair_check` refused EVERY `pending_valuation` row,
  // regardless of `in_service_source`. Once 0164 adds the shell's own branch, this insert reaches
  // `fixed_assets_in_service_a_fill`, whose very first lines force a `pending_valuation` row's
  // in-service columns to NULL unconditionally (0163:70-73) — the fill trigger silently corrects
  // a caller-supplied source rather than the row ever being rejected for carrying one.
  it('a shell (pending_valuation) with a supplied in-service source is accepted, and the fill trigger silently nulls it', async () => {
    const orgId = await org9('shell');
    const personId = await person9(orgId);
    const storeId = await store9(orgId, null);
    const [row] = (await sql9.unsafe(
      `insert into fixed_assets (org_id, store_id, name, category, status, in_service_source, created_by)
       values ($1, $2, 'Shell', 'equipment', 'pending_valuation', 'acquired', $3)
       returning id`,
      [orgId, storeId, personId] as never[],
    )) as unknown as { id: string }[];
    expect(await inServiceOf9(row!.id)).toEqual({ source: null, on: null });
  });

  // --- R4.2 — correcting acquired_on on an 'acquired' asset re-derives in_service_on --------------

  describe('R4.2 — UPDATE of acquired_on on an "acquired" asset', () => {
    it('re-derives in_service_on to match, with no error', async () => {
      const orgId = await org9('redervie');
      const personId = await person9(orgId);
      // A store with NO opening date fills 'store_opening' (held), not 'acquired' — the fill rule
      // is "store_opening if opening_date IS NULL OR > acquired_on, else acquired". An already-open
      // store (like the fill-rule test's own openStore) is what actually resolves 'acquired'.
      const storeId = await store9(orgId, '2020-01-01');
      const assetId = await insertAsset9({ orgId, storeId, personId, acquiredOn: '2026-03-15' });
      expect((await inServiceOf9(assetId)).source).toBe('acquired');

      await sql9`update fixed_assets set acquired_on = '2026-04-01' where id = ${assetId}`;
      expect(await inServiceOf9(assetId)).toEqual({ source: 'acquired', on: '2026-04-01' });
    });

    it('⛔ the SAME update also supplying a conflicting in_service_on raises', async () => {
      const orgId = await org9('redervie-conflict');
      const personId = await person9(orgId);
      const storeId = await store9(orgId, '2020-01-01'); // already-open ⇒ 'acquired', same reason as above
      const assetId = await insertAsset9({ orgId, storeId, personId, acquiredOn: '2026-03-15' });
      expect((await inServiceOf9(assetId)).source).toBe('acquired');
      await expectGuard9(
        sql9.unsafe(
          `update fixed_assets set acquired_on = $1, in_service_on = $2 where id = $3`,
          ['2026-04-01', '2026-05-01', assetId] as never[],
        ),
        /an in-service date on the acquisition date must equal it/,
      );
    });
  });

  // --- R1.1 — the guard is a bare BEFORE UPDATE, no column list, so it also catches a move made by
  // the fill itself (store_id change) or by propagation (store opening_date change) ---------------

  describe('R1.1 — the guard catches an in-service move made by ANOTHER column\'s own update', () => {
    it('⛔ store_id changed to a store that opens later, past a posted month, raises the guard error', async () => {
      const orgId = await org9('storemove');
      const personId = await person9(orgId);
      const accts = await seedAccounts9(orgId);
      const earlyStore = await store9(orgId, null); // no date ⇒ store_opening, held NULL (the fill rule)
      const lateStore = await store9(orgId, '2026-09-01');
      const assetId = await insertAsset9({ orgId, storeId: earlyStore, personId, acquiredOn: '2026-03-15' });
      // Fails loudly if the fixture's own fill assumption is wrong, same discipline as the
      // propagation case below.
      expect(await inServiceOf9(assetId)).toEqual({ source: 'store_opening', on: null });
      // Held — a raw-SQL post still lands (postDepreciationKeyed bypasses the domain schedule
      // entirely), and the guard cares only about the OLD-vs-NEW in_service_on transition, not
      // whether the asset was "supposed to" owe this month.
      await postDepreciationKeyed(orgId, earlyStore, personId, assetId, '2026-03', '2026-03-31', accts);

      await expectGuard9(
        sql9`update fixed_assets set store_id = ${lateStore} where id = ${assetId}`,
        /already has depreciation posted for 2026-03; reverse it before moving its in-service date/,
      );
    });

    it('⛔ a store opening_date update, propagating a follower past a posted month, raises the guard naming the asset', async () => {
      const orgId = await org9('propmove');
      const personId = await person9(orgId);
      const accts = await seedAccounts9(orgId);
      // Opens AFTER acquisition — the fill rule's "store_opening if opening_date IS NULL OR >
      // acquired_on" only takes this branch when the date is later than acquired_on (2026-03-15).
      // 2026-01-01 (an earlier date) would resolve 'acquired' instead, and a later opening_date
      // update would never touch an 'acquired' asset at all — the guard could never fire.
      const storeId = await store9(orgId, '2026-04-01');
      const assetId = await insertAsset9({ orgId, storeId, personId, acquiredOn: '2026-03-15' });
      // Fails loudly if that assumption is wrong, rather than the guard assertion below failing
      // for an unrelated reason.
      expect(await inServiceOf9(assetId)).toEqual({ source: 'store_opening', on: '2026-04-01' });

      await postDepreciationKeyed(orgId, storeId, personId, assetId, '2026-04', '2026-04-30', accts);

      await expectGuard9(
        sql9`update stores set opening_date = '2026-09-01' where id = ${storeId}`,
        /Chiller.*already has depreciation posted for 2026-04; reverse it before moving its in-service date/,
      );
    });
  });

  // --- R1.2 — the guard reads the posted month from the KEY, never entry_date --------------------

  describe('R1.2 — the illegal month comes from the KEY, not entry_date', () => {
    it('⛔ a T-345 catch-up keyed 2026-04, dated 2026-09: moving in-service to 2026-06 is refused', async () => {
      const orgId = await org9('catchupkey');
      const personId = await person9(orgId);
      const accts = await seedAccounts9(orgId);
      const storeId = await store9(orgId, '2026-01-01');
      const assetId = await insertAsset9({ orgId, storeId, personId, acquiredOn: '2026-03-15' });
      // Keyed for April, but booked (dated) in September — same shape as a T-345 catch-up.
      await postDepreciationKeyed(orgId, storeId, personId, assetId, '2026-04', '2026-09-15', accts);

      await expectGuard9(
        sql9`update fixed_assets set in_service_source = 'set', in_service_on = '2026-06-01' where id = ${assetId}`,
        /already has depreciation posted for 2026-04; reverse it before moving its in-service date/,
      );
    });

    it('⛔ a quarterly asset keyed 2026-06 (period Apr-Jun): moving in-service to 2026-05 is refused', async () => {
      const orgId = await org9('quarterkey');
      const personId = await person9(orgId);
      const accts = await seedAccounts9(orgId);
      const storeId = await store9(orgId, '2026-01-01');
      const assetId = await insertAsset9({
        orgId, storeId, personId, acquiredOn: '2026-01-01', interval: 'quarterly',
      });
      // Key 2026-06 covers the quarter Apr-Jun (period start = key month − (step−1) = 06 − 2 = 04).
      await postDepreciationKeyed(orgId, storeId, personId, assetId, '2026-06', '2026-06-30', accts);

      await expectGuard9(
        sql9`update fixed_assets set in_service_source = 'set', in_service_on = '2026-05-01' where id = ${assetId}`,
        /already has depreciation posted for 2026-06; reverse it before moving its in-service date/,
      );
    });
  });
});
