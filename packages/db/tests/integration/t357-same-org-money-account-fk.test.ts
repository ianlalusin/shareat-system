/**
 * T-357 / DEF-490 — `docs/tasks/357-def-490-same-org-money-account-fk.md`, legs K1-K2, F1-F5, N1,
 * M1-M2. Real Postgres via TEST_DATABASE_URL, `_test` name guard.
 *
 * ⛔ 0171 has NOT been applied to this database yet. Every K/F leg below is red today for exactly
 * that reason: no composite FK exists, so a cross-org money-account reference is silently accepted.
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

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

class RollbackSentinel extends Error {}

async function asOrg<T>(org: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.org_id', ${org}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

async function caught<T>(p: Promise<T>): Promise<(Error & { code?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  return undefined;
}

/** Same shape as `t350-s6-followups.test.ts:147-154` — one org, one store, one money account. */
async function orgFixture(hint: string) {
  const code = uid(`t357-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const personId = person!.id;
  const [account] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${orgId}, ${storeId}, ${`Bank ${uid('m')}`}, 'bank', '1140', 'office', true) returning id`;
  return { orgId, storeId, personId, accountId: account!.id };
}

// =================================================================================================
// K1-K2 — catalog checks. No role switch needed (read-only pg_constraint).
// =================================================================================================

const R2_FKS: ReadonlyArray<{ table: string; col: string }> = [
  { table: 'sales_channels', col: 'destination_money_account_id' },
  { table: 'channel_settlements', col: 'destination_money_account_id' },
  { table: 'money_transfers', col: 'from_money_account_id' },
  { table: 'money_transfers', col: 'to_money_account_id' },
  { table: 'cash_requests', col: 'released_from_money_account_id' },
  { table: 'ap_payments', col: 'money_account_id' },
  { table: 'ar_collections', col: 'money_account_id' },
  { table: 'pay_runs', col: 'money_account_id' },
  { table: 'thirteenth_month_runs', col: 'money_account_id' },
  { table: 'separations', col: 'money_account_id' },
  { table: 'recurring_expenses', col: 'default_money_account_id' },
];

describe('K1 — catalog: each of R2\'s 11 (table, col) gets a composite same-org FK to money_accounts(org_id, id)', () => {
  it.each(R2_FKS)('%s.%s: a RESTRICT-delete FOREIGN KEY (org_id, %s) REFERENCES money_accounts(org_id, id) exists — red today: 0 of 11 exist', async ({ table, col }) => {
    const rows = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = ${table}::regclass and contype = 'f' and confrelid = 'money_accounts'::regclass`;
    const wantRe = new RegExp(
      `FOREIGN KEY \\(org_id, ${col}\\) REFERENCES money_accounts\\(org_id, id\\)[^;]*ON DELETE RESTRICT`,
    );
    const match = rows.some((r) => wantRe.test(r.def));
    expect(match, `${table}.${col}: no composite FK found. Candidates: ${JSON.stringify(rows.map((r) => r.def))}`).toBe(true);
  });
});

describe('K2 — catalog: money_accounts has a unique/PK constraint on exactly (org_id, id); the 16 single-column FKs still exist (R3)', () => {
  it('a UNIQUE or PRIMARY KEY constraint on (org_id, id) exists — red today: no (org_id, id) unique', async () => {
    const rows = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'money_accounts'::regclass and contype in ('u', 'p')`;
    const match = rows.some((r) => /\(org_id, id\)/.test(r.def));
    expect(match, `constraints seen: ${JSON.stringify(rows.map((r) => r.def))}`).toBe(true);
  });

  it('the single-column FK to money_accounts still exists on every one of the 16 referencing tables (R3 — not dropped)', async () => {
    const ALL_16_TABLES = [...new Set(R2_FKS.map((f) => f.table))].concat([
      'expense_payments', 'remittance_lines', 'sales_day_tenders', 'till_count_lines',
    ]);
    for (const table of ALL_16_TABLES) {
      const rows = await sql<{ conkey: number[] }[]>`
        select conkey from pg_constraint
        where conrelid = ${table}::regclass and contype = 'f' and confrelid = 'money_accounts'::regclass`;
      const hasSingleColumn = rows.some((r) => r.conkey.length === 1);
      expect(hasSingleColumn, `${table}: expected at least one single-column FK to money_accounts to survive`).toBe(true);
    }
  });
});

// =================================================================================================
// F1-F3, N1 — as shareat_app, app.org_id = A. F4-F5 — as the admin/owner connection.
// =================================================================================================

describe('F1 — as shareat_app (org A), INSERT an A sales_channels row pointing at B\'s money account', () => {
  it('rejects 23503 — red today: ACCEPTED (1 row)', async () => {
    const a = await orgFixture('f1a');
    const b = await orgFixture('f1b');
    const err = await caught(
      asOrg(a.orgId, (tx) => tx`
        insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
        values (${a.orgId}, ${a.storeId}, ${`Channel ${uid('c')}`}, false, '1220', ${b.accountId})`),
    );
    expect(err?.code, "today's red: no error, the cross-org INSERT was accepted").toBe('23503');
  });
});

describe('F2 — as shareat_app (org A), UPDATE an A channel\'s destination to B\'s account', () => {
  it('rejects 23503; the stored value is unchanged — red today: ACCEPTED (count 1)', async () => {
    const a = await orgFixture('f2a');
    const b = await orgFixture('f2b');
    const [channel] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${a.orgId}, ${a.storeId}, ${`Channel ${uid('c')}`}, false, '1220', ${a.accountId}) returning id`;

    const err = await caught(
      asOrg(a.orgId, (tx) => tx`update sales_channels set destination_money_account_id = ${b.accountId} where id = ${channel!.id}`),
    );
    expect(err?.code, "today's red: no error, the cross-org UPDATE was accepted").toBe('23503');

    const [row] = await sql<{ destination_money_account_id: string }[]>`
      select destination_money_account_id from sales_channels where id = ${channel!.id}`;
    expect(row!.destination_money_account_id, 'the stored value must be unchanged after the rejected UPDATE').toBe(a.accountId);
  });
});

describe('F3 — same-org positive control: the same INSERT and UPDATE with A\'s OWN account — guard, proves F1/F2 are the org check, not a broken FK', () => {
  it('both succeed', async () => {
    const a = await orgFixture('f3');
    const insertResult = await asOrg(a.orgId, (tx) => tx`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${a.orgId}, ${a.storeId}, ${`Channel ${uid('c')}`}, false, '1220', ${a.accountId}) returning id`);
    expect(insertResult.length, 'expected the same-org INSERT to succeed').toBe(1);

    const [account2] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${a.orgId}, ${a.storeId}, ${`Bank2 ${uid('m')}`}, 'bank', '1140', 'office', true) returning id`;
    const updateResult = await asOrg(a.orgId, (tx) =>
      tx`update sales_channels set destination_money_account_id = ${account2!.id} where id = ${insertResult[0]!.id}`,
    );
    expect(updateResult.count, 'expected the same-org UPDATE to succeed').toBe(1);
  });
});

describe('F4 — owner (admin sql, bypasses RLS), cross-org INSERT of a money_transfers row', () => {
  it('rejects 23503 — the composite applies to whoever writes, not just the app role — red today: accepted', async () => {
    const a = await orgFixture('f4a');
    const b = await orgFixture('f4b');
    // ⛔ `tx.savepoint(async sp => ...)`, not a raw `tx.unsafe('savepoint ...')`/`rollback to
    // savepoint`: postgres.js's own savepoint helper catches an error thrown inside it and
    // resolves to a normal rejection scoped to that savepoint, keeping the outer transaction
    // viable. A manually-issued raw SAVEPOINT does not get that integration — the connection's
    // internal error tracking still marks the WHOLE transaction errored, so `sql.begin()` itself
    // rejects even though the query's own promise was `caught()`. Same bug class as T-355's N2.
    let error: (Error & { code?: string }) | undefined;
    try {
      await sql.begin(async (tx) => {
        try {
          await tx.savepoint(async (sp) => {
            await sp`
              insert into money_transfers (org_id, store_id, from_money_account_id, to_money_account_id, amount_out, amount_in, transfer_date, created_by)
              values (${a.orgId}, ${a.storeId}, ${a.accountId}, ${b.accountId}, '100.00', '100.00', '2026-01-15', ${a.personId})`;
          });
        } catch (err) {
          error = err as Error & { code?: string };
        }
        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
    expect(error?.code, "today's red: accepted").toBe('23503');
    expect(error?.message, 'expected the same-org composite FK name in the error').toMatch(/money_transfers_to_money_account_id_same_org_fk/);
  });
});

describe('F5 — owner cross-org UPDATE of recurring_expenses.default_money_account_id (a nullable member of the 11)', () => {
  it('rejects 23503 — red today: accepted', async () => {
    const a = await orgFixture('f5a');
    const b = await orgFixture('f5b');
    const [{ seedExpenseCategories }] = await Promise.all([import('../../seed/expense-categories')]);
    await seedExpenseCategories(sql, a.orgId);
    const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${a.orgId} limit 1`;

    // Same fix as F4 — `tx.savepoint(...)`, never a raw SAVEPOINT/ROLLBACK TO SAVEPOINT pair.
    let error: (Error & { code?: string }) | undefined;
    try {
      await sql.begin(async (tx) => {
        const [rec] = await tx<{ id: string }[]>`
          insert into recurring_expenses (org_id, store_id, name, category_id, default_amount, interval, anchor_day, next_due_date)
          values (${a.orgId}, ${a.storeId}, ${`Rent ${uid('r')}`}, ${category!.id}, '1000.00', 'monthly', 1, '2026-02-01')
          returning id`;
        try {
          await tx.savepoint(async (sp) => {
            await sp`update recurring_expenses set default_money_account_id = ${b.accountId} where id = ${rec!.id}`;
          });
        } catch (err) {
          error = err as Error & { code?: string };
        }
        throw new RollbackSentinel();
      });
    } catch (err) {
      if (!(err instanceof RollbackSentinel)) throw err;
    }
    expect(error?.code, "today's red: accepted").toBe('23503');
    expect(error?.message, 'expected the same-org composite FK name in the error').toMatch(/recurring_expenses_default_money_account_id_same_org_fk/);
  });
});

describe('N1 — MATCH SIMPLE: as the app role, a NULL destination on INSERT, then UPDATE back to NULL — guard', () => {
  it('both succeed', async () => {
    const a = await orgFixture('n1');
    const insertResult = await asOrg(a.orgId, (tx) => tx`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${a.orgId}, ${a.storeId}, ${`Channel ${uid('c')}`}, false, '1220', null) returning id`);
    expect(insertResult.length, 'expected the NULL-destination INSERT to succeed').toBe(1);

    const updateWithAccount = await asOrg(a.orgId, (tx) =>
      tx`update sales_channels set destination_money_account_id = ${a.accountId} where id = ${insertResult[0]!.id}`,
    );
    expect(updateWithAccount.count).toBe(1);

    const updateBackToNull = await asOrg(a.orgId, (tx) =>
      tx`update sales_channels set destination_money_account_id = null where id = ${insertResult[0]!.id}`,
    );
    expect(updateBackToNull.count, 'expected the UPDATE back to NULL to succeed (MATCH SIMPLE skips a NULL member)').toBe(1);
  });
});

// =================================================================================================
// M1-M2 — scratch-DB technique, matching `t349-s3-def456-repair-migration.test.ts`.
// =================================================================================================

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');

interface JournalEntry {
  tag: string;
  when: number;
}
function journal(): JournalEntry[] {
  return (JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries;
}
function find0170Tag(): string {
  const candidates = journal().filter((e) => e.tag.includes('t356_def489_existing_table_revokes'));
  expect(candidates.length, `expected 1 migration tagged t356_def489_existing_table_revokes, found ${candidates.length}`).toBe(1);
  return candidates[0]!.tag;
}
function buildFolderThroughTag(targetTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-through-0170-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });
  const entries = journal();
  const target = entries.find((e) => e.tag === targetTag);
  if (!target) throw new Error(`journal entry for "${targetTag}" vanished between lookup and use`);
  const keptEntries = entries.filter((e) => e.when <= target.when);
  const keptTags = new Set(keptEntries.map((e) => e.tag));
  for (const f of readdirSync(REAL_MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && keptTags.has(f.slice(0, -'.sql'.length))) {
      writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_FOLDER, f)));
    }
  }
  const journalCopy = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  journalCopy.entries = keptEntries;
  writeFileSync(join(metaDir, '_journal.json'), JSON.stringify(journalCopy, null, 2));
  return dir;
}
async function createScratchDatabase(name: string): Promise<void> {
  const adminUrl = new URL(url!);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}
async function dropScratchDatabase(name: string): Promise<void> {
  const adminUrl = new URL(url!);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}
function scratchUrl(name: string): string {
  const u = new URL(url!);
  u.pathname = `/${name}`;
  return u.toString();
}
async function applyThroughTag(s: ReturnType<typeof postgres>, targetTag: string): Promise<void> {
  const dir = buildFolderThroughTag(targetTag);
  try {
    await migrate(drizzle(s), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function applyEverything(s: ReturnType<typeof postgres>): Promise<void> {
  await migrate(drizzle(s), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}

async function scratchOrgFixture(s: ReturnType<typeof postgres>, hint: string) {
  const code = uid(`t357m-${hint}`);
  const [org] = await s<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await s<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const storeId = store!.id;
  const [person] = await s<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const personId = person!.id;
  const [account] = await s<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${orgId}, ${storeId}, ${`Bank ${uid('m')}`}, 'bank', '1140', 'office', true) returning id`;
  return { orgId, storeId, personId, accountId: account!.id };
}

describe('M1 — pre-flight: a scratch DB at 0170 with one cross-org sales_channels row and one cross-org money_transfers row, then apply 0171', () => {
  const dbName = `shareat_scratch_t357m1_${Date.now()}`;
  let s: ReturnType<typeof postgres>;

  afterAll(async () => {
    await s?.end();
    await dropScratchDatabase(dbName);
  }, 60_000);

  it('rejects; the message names DEF-490, sales_channels = 1 and money_transfers = 1; no composite FK/unique afterward; both seeded rows unchanged — red today: 0171 is absent, a plain migrate would not raise', async () => {
    const tag0170 = find0170Tag();
    await createScratchDatabase(dbName);
    s = postgres(scratchUrl(dbName), { max: 1 });
    await applyThroughTag(s, tag0170);

    const a = await scratchOrgFixture(s, 'a');
    const b = await scratchOrgFixture(s, 'b');
    const [channel] = await s<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${a.orgId}, ${a.storeId}, ${`Channel ${uid('c')}`}, false, '1220', ${b.accountId}) returning id`;
    const [transfer] = await s<{ id: string }[]>`
      insert into money_transfers (org_id, store_id, from_money_account_id, to_money_account_id, amount_out, amount_in, transfer_date, created_by)
      values (${a.orgId}, ${a.storeId}, ${a.accountId}, ${b.accountId}, '50.00', '50.00', '2026-01-10', ${a.personId}) returning id`;

    let migrationError: Error | undefined;
    try {
      await applyEverything(s);
    } catch (err) {
      migrationError = err as Error;
    }
    expect(migrationError, "today's red: 0171 does not exist, so migrate() ran everything through 0170 with no error to catch").toBeDefined();
    expect(migrationError?.message).toMatch(/DEF-490/);
    expect(migrationError?.message).toMatch(/sales_channels[^0-9]*1\b/);
    expect(migrationError?.message).toMatch(/money_transfers[^0-9]*1\b/);

    const constraints = await s<{ conname: string }[]>`
      select conname from pg_constraint where conname like '%same_org_fk' or conname = 'money_accounts_org_id_id_unique'`;
    expect(constraints, 'no composite FK or (org_id,id) unique should exist — the whole migration rolled back').toEqual([]);

    const [channelRow] = await s<{ destination_money_account_id: string }[]>`
      select destination_money_account_id from sales_channels where id = ${channel!.id}`;
    expect(channelRow!.destination_money_account_id).toBe(b.accountId);
    const [transferRow] = await s<{ to_money_account_id: string }[]>`
      select to_money_account_id from money_transfers where id = ${transfer!.id}`;
    expect(transferRow!.to_money_account_id).toBe(b.accountId);
  }, 90_000);
});

describe('M2 — positive control: the same scratch-DB technique, same-org seeds only', () => {
  const dbName = `shareat_scratch_t357m2_${Date.now()}`;
  let s: ReturnType<typeof postgres>;

  afterAll(async () => {
    await s?.end();
    await dropScratchDatabase(dbName);
  }, 60_000);

  it('0171 applies cleanly; K1 holds on it — as M1', async () => {
    const tag0170 = find0170Tag();
    await createScratchDatabase(dbName);
    s = postgres(scratchUrl(dbName), { max: 1 });
    await applyThroughTag(s, tag0170);

    const a = await scratchOrgFixture(s, 'same');
    // A second SAME-ORG account — money_transfers_distinct_accounts_check forbids from = to.
    const [account2] = await s<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${a.orgId}, ${a.storeId}, ${`Bank2 ${uid('m')}`}, 'bank', '1140', 'office', true) returning id`;
    await s`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${a.orgId}, ${a.storeId}, ${`Channel ${uid('c')}`}, false, '1220', ${a.accountId})`;
    await s`
      insert into money_transfers (org_id, store_id, from_money_account_id, to_money_account_id, amount_out, amount_in, transfer_date, created_by)
      values (${a.orgId}, ${a.storeId}, ${a.accountId}, ${account2!.id}, '10.00', '10.00', '2026-01-10', ${a.personId})`;

    await expect(applyEverything(s), '0171 must apply cleanly over same-org data').resolves.toBeUndefined();

    const rows = await s<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'sales_channels'::regclass and contype = 'f' and confrelid = 'money_accounts'::regclass`;
    const match = rows.some((r) => /FOREIGN KEY \(org_id, destination_money_account_id\) REFERENCES money_accounts\(org_id, id\)/.test(r.def));
    expect(match, `K1 must hold on M2's scratch DB — candidates: ${JSON.stringify(rows.map((r) => r.def))}`).toBe(true);
  }, 90_000);
});
