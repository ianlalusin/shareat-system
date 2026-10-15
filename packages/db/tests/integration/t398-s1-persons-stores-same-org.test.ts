/**
 * T-398 S1 / DEF-491 part 1 -- docs/tasks/398-padre-garcia-franchise-org.md S1 legs P1-P4, N1, M1, M2.
 * Real Postgres via TEST_DATABASE_URL, `_test` name guard.
 *
 * Every FK to persons(id) and stores(id) from an org-scoped table gets a composite
 * (org_id, col) -> parent(org_id, id) twin in the S1 migration (0194). Until it exists a cross-org
 * reference is accepted: P1-P3 and M1/M2 are red today for exactly that reason.
 *
 * Every write that is expected to be ACCEPTED today runs in a transaction that is rolled back, so the
 * shared test database never keeps a cross-org row (the builder applies the S1 migration to it, and
 * the migration's pre-flight would refuse over residue).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_ROLE } from '../../src/rls/registry';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type PgErr = Error & { code?: string };
class Rollback extends Error {}

/**
 * Run `fn` as shareat_app with app.org_id = `org` (or as the owner when `org` is null), inside a
 * transaction that is ALWAYS rolled back. Resolves with the error `fn` raised (undefined = accepted)
 * and whatever `fn` returned.
 */
async function attempt<T>(
  org: string | null,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<{ err?: PgErr; value?: T }> {
  const out: { err?: PgErr; value?: T } = {};
  try {
    await sql.begin(async (tx) => {
      if (org) {
        await tx.unsafe(`set local role ${APP_ROLE}`);
        await tx`select set_config('app.org_id', ${org}, true)`;
      }
      try {
        await tx.savepoint(async (sp) => {
          out.value = await fn(sp as unknown as postgres.TransactionSql);
        });
      } catch (e) {
        out.err = e as PgErr;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

async function orgFixture(s: postgres.Sql, hint: string) {
  const code = uid(`t398s1-${hint}`);
  const [org] = await s<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await s<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const [person] = await s<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  return { orgId, storeId: store!.id, personId: person!.id };
}

// Representative children. Each insert needs only the columns shown.
const insSupplier = (tx: postgres.Sql | postgres.TransactionSql, org: string, createdBy: string) =>
  tx`insert into suppliers (org_id, name, created_by) values (${org}, ${uid('Sup')}, ${createdBy}) returning id`;
const insCustomer = (tx: postgres.Sql | postgres.TransactionSql, org: string, createdBy: string) =>
  tx`insert into customers (org_id, name, created_by) values (${org}, ${uid('Cus')}, ${createdBy}) returning id`;
const insPriceList = (tx: postgres.Sql | postgres.TransactionSql, org: string, createdBy: string) =>
  tx`insert into price_lists (org_id, name, created_by) values (${org}, ${uid('PL')}, ${createdBy}) returning id`;
const insChannel = (tx: postgres.Sql | postgres.TransactionSql, org: string, storeId: string) =>
  tx`insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${org}, ${storeId}, ${uid('Ch')}, false, '1220') returning id`;
const insMoneyAccount = (tx: postgres.Sql | postgres.TransactionSql, org: string, storeId: string) =>
  tx`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active) values (${org}, ${storeId}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
const insPosition = (tx: postgres.Sql | postgres.TransactionSql, org: string, storeId: string | null) =>
  tx`insert into positions (org_id, store_id, name, is_canonical) values (${org}, ${storeId}, ${uid('Pos')}, ${storeId === null}) returning id`;

// =================================================================================================
// P1-P4, N1 -- live-DB behaviour
// =================================================================================================

describe('P1 -- as shareat_app (org A), an INSERT pointing at ORG B\'s PERSON is refused on three tables', () => {
  const cases: [string, (tx: postgres.TransactionSql, a: string, p: string) => Promise<unknown>][] = [
    ['suppliers.created_by', (tx, a, p) => insSupplier(tx, a, p)],
    ['customers.created_by', (tx, a, p) => insCustomer(tx, a, p)],
    ['price_lists.created_by', (tx, a, p) => insPriceList(tx, a, p)],
  ];
  it.each(cases)('%s -> 23503 (red today: ACCEPTED)', async (name, run) => {
    const a = await orgFixture(sql, 'p1a');
    const b = await orgFixture(sql, 'p1b');
    const r = await attempt(a.orgId, (tx) => run(tx, a.orgId, b.personId));
    expect(r.err?.code, `${name}: today's red - no error, the cross-org INSERT was accepted`).toBe('23503');
    expect(r.err?.message).toMatch(/same_org_fk/);
  });
});

describe('P2 -- as shareat_app (org A), an INSERT pointing at ORG B\'s STORE is refused on three tables', () => {
  const cases: [string, (tx: postgres.TransactionSql, a: string, s: string) => Promise<unknown>][] = [
    ['sales_channels.store_id', (tx, a, s) => insChannel(tx, a, s)],
    ['money_accounts.store_id', (tx, a, s) => insMoneyAccount(tx, a, s)],
    ['positions.store_id', (tx, a, s) => insPosition(tx, a, s)],
  ];
  it.each(cases)('%s -> 23503 (red today: ACCEPTED)', async (name, run) => {
    const a = await orgFixture(sql, 'p2a');
    const b = await orgFixture(sql, 'p2b');
    const r = await attempt(a.orgId, (tx) => run(tx, a.orgId, b.storeId));
    expect(r.err?.code, `${name}: today's red - no error, the cross-org INSERT was accepted`).toBe('23503');
    expect(r.err?.message).toMatch(/same_org_fk/);
  });
});

describe('P3 -- the OWNER connection (bypasses RLS) is refused on a cross-org UPDATE of one person FK and one store FK', () => {
  it('suppliers.created_by -> B\'s person: 23503, naming suppliers_created_by_same_org_fk (red today: accepted)', async () => {
    const a = await orgFixture(sql, 'p3pa');
    const b = await orgFixture(sql, 'p3pb');
    const r = await attempt(null, async (tx) => {
      const [row] = (await insSupplier(tx, a.orgId, a.personId)) as unknown as { id: string }[];
      await tx`update suppliers set created_by = ${b.personId} where id = ${row!.id}`;
    });
    expect(r.err?.code, "today's red: accepted").toBe('23503');
    expect(r.err?.message).toMatch(/suppliers_created_by_same_org_fk/);
  });
  it('sales_channels.store_id -> B\'s store: 23503, naming sales_channels_store_id_same_org_fk (red today: accepted)', async () => {
    const a = await orgFixture(sql, 'p3sa');
    const b = await orgFixture(sql, 'p3sb');
    const r = await attempt(null, async (tx) => {
      const [row] = (await insChannel(tx, a.orgId, a.storeId)) as unknown as { id: string }[];
      await tx`update sales_channels set store_id = ${b.storeId} where id = ${row!.id}`;
    });
    expect(r.err?.code, "today's red: accepted").toBe('23503');
    expect(r.err?.message).toMatch(/sales_channels_store_id_same_org_fk/);
  });
});

describe('P4 -- same-org positive control on all six: the guard is the org check, not a broken FK', () => {
  it('all six inserts with org A\'s OWN person/store succeed as shareat_app', async () => {
    const a = await orgFixture(sql, 'p4');
    const r = await attempt(a.orgId, async (tx) => {
      await insSupplier(tx, a.orgId, a.personId);
      await insCustomer(tx, a.orgId, a.personId);
      await insPriceList(tx, a.orgId, a.personId);
      await insChannel(tx, a.orgId, a.storeId);
      await insMoneyAccount(tx, a.orgId, a.storeId);
      await insPosition(tx, a.orgId, a.storeId);
      return 6;
    });
    expect(r.err, `same-org writes must succeed: ${r.err?.message}`).toBeUndefined();
    expect(r.value).toBe(6);
  });
});

describe('N1 -- MATCH SIMPLE: a NULL on a nullable person FK (positions.created_by) / store FK succeeds', () => {
  it('positions.created_by = NULL, customers.counterparty_store_id = NULL, positions.store_id = NULL', async () => {
    const a = await orgFixture(sql, 'n1');
    const r = await attempt(a.orgId, async (tx) => {
      const [s] = (await insPosition(tx, a.orgId, null)) as unknown as { id: string }[];
      await tx`update positions set created_by = ${a.personId} where id = ${s!.id}`;
      await tx`update positions set created_by = null where id = ${s!.id}`;
      const [c] = (await insCustomer(tx, a.orgId, a.personId)) as unknown as { id: string }[];
      await tx`update customers set counterparty_store_id = null where id = ${c!.id}`;
      await insPosition(tx, a.orgId, null);
      return 1;
    });
    expect(r.err, `NULL must pass: ${r.err?.message}`).toBeUndefined();
  });
});

// =================================================================================================
// M1-M2 -- scratch databases at the migration before S1's (0193), then everything pending.
// One base database is built once; M1 and M2 each get a template copy.
// =================================================================================================

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const BASE_TAG = '0193_t391_purchase_unit_and_master_links';

interface JournalEntry {
  tag: string;
  when: number;
}
function journalEntries(): JournalEntry[] {
  return (JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries;
}
function buildFolderThroughTag(targetTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-through-0193-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const entries = journalEntries();
  const target = entries.find((e) => e.tag === targetTag);
  if (!target) throw new Error(`journal entry for "${targetTag}" not found`);
  const kept = entries.filter((e) => e.when <= target.when);
  const keptTags = new Set(kept.map((e) => e.tag));
  for (const f of readdirSync(REAL_MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && keptTags.has(f.slice(0, -4))) writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_FOLDER, f)));
  }
  const copy = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  copy.entries = kept;
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(copy, null, 2));
  return dir;
}
function adminUrl(db = 'postgres'): string {
  const u = new URL(url!);
  u.pathname = `/${db}`;
  return u.toString();
}
async function admin<T>(fn: (a: postgres.Sql) => Promise<T>): Promise<T> {
  const a = postgres(adminUrl(), { max: 1 });
  try {
    return await fn(a);
  } finally {
    await a.end();
  }
}
const dropDb = async (name: string) => {
  try {
    await admin((a) => a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  } catch (e) {
    // idempotent: a database already gone (or being dropped) is not a failure
    if (!/does not exist|being accessed/i.test((e as Error).message)) throw e;
  }
};
const applyEverything = (s: postgres.Sql) => migrate(drizzle(s), { migrationsFolder: REAL_MIGRATIONS_FOLDER });

const stamp = Date.now();
const BASE_DB = `shareat_scratch_t398s1_base_${stamp}`;
let baseBuilt = false;
async function ensureBase(): Promise<void> {
  if (baseBuilt) return;
  await dropDb(BASE_DB);
  await admin((a) => a.unsafe(`CREATE DATABASE "${BASE_DB}"`));
  const s = postgres(adminUrl(BASE_DB), { max: 1 });
  const dir = buildFolderThroughTag(BASE_TAG);
  try {
    await migrate(drizzle(s), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.end();
  }
  baseBuilt = true;
}
async function cloneBase(name: string): Promise<postgres.Sql> {
  await ensureBase();
  await dropDb(name);
  await admin((a) => a.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${BASE_DB}"`));
  return postgres(adminUrl(name), { max: 1 });
}

/** Every org-scoped single-column FK to persons/stores lacking an (org_id, col) twin, via the catalog. */
async function bareFks(s: postgres.Sql): Promise<string[]> {
  const rows = await s<{ k: string }[]>`
    select cr.relname || '.' || a.attname || '->' || pr.relname as k
    from pg_constraint con
    join pg_class cr on cr.oid = con.conrelid
    join pg_class pr on pr.oid = con.confrelid
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and cardinality(con.conkey) = 1 and pr.relname in ('persons', 'stores')
      and con.connamespace = 'public'::regnamespace
      and exists (select 1 from pg_attribute o where o.attrelid = con.conrelid and o.attname = 'org_id' and not o.attisdropped)
      and not exists (
        select 1 from pg_constraint t
        where t.conrelid = con.conrelid and t.confrelid = con.confrelid and t.contype = 'f' and cardinality(t.conkey) = 2
          and (select attname from pg_attribute where attrelid = t.conrelid and attnum = t.conkey[1]) = 'org_id'
          and (select attname from pg_attribute where attrelid = t.conrelid and attnum = t.conkey[2]) = a.attname)
    order by 1`;
  return rows.map((r) => r.k);
}
async function sameOrgFkCount(s: postgres.Sql): Promise<number> {
  const [r] = await s<{ n: string }[]>`select count(*)::text as n from pg_constraint where conname like '%same_org_fk'`;
  return Number(r!.n);
}
async function personsStoresUniques(s: postgres.Sql): Promise<string[]> {
  const rows = await s<{ d: string }[]>`
    select conrelid::regclass::text || ' ' || pg_get_constraintdef(oid) as d from pg_constraint
    where conrelid in ('persons'::regclass, 'stores'::regclass) and contype = 'u' order by 1`;
  return rows.map((r) => r.d);
}
async function appliedCount(s: postgres.Sql): Promise<number> {
  const [r] = await s<{ n: string }[]>`select count(*)::text as n from drizzle.__drizzle_migrations`;
  return Number(r!.n);
}

describe('M1 -- pre-flight: a scratch DB at 0193 with one cross-org persons row and one cross-org stores row, then apply everything pending', () => {
  const dbName = `shareat_scratch_t398s1_m1_${stamp}`;
  let s: postgres.Sql | undefined;
  afterAll(async () => {
    await s?.end({ timeout: 5 });
    await dropDb(dbName);
  }, 120_000);

  it('RAISEs naming DEF-491, suppliers.created_by and sales_channels.store_id; no constraint, unique or migration row is left; seeded rows unchanged', async () => {
    s = await cloneBase(dbName);
    const a = await orgFixture(s, 'm1a');
    const b = await orgFixture(s, 'm1b');
    const [sup] = await insSupplier(s, a.orgId, b.personId);
    const [ch] = await insChannel(s, a.orgId, b.storeId);
    const fksBefore = await sameOrgFkCount(s);
    const uniquesBefore = await personsStoresUniques(s);
    const appliedBefore = await appliedCount(s);

    let migrationError: Error | undefined;
    try {
      await applyEverything(s);
    } catch (e) {
      migrationError = e as Error;
    }
    expect(migrationError, "today's red: no S1 migration exists, so migrate() ran nothing and raised nothing").toBeDefined();
    expect(migrationError?.message).toMatch(/DEF-491/);
    expect(migrationError?.message).toMatch(/suppliers[._ -]+created_by/);
    expect(migrationError?.message).toMatch(/sales_channels[._ -]+store_id/);

    expect(await sameOrgFkCount(s), 'no composite FK may be left behind (the whole migration rolled back)').toBe(fksBefore);
    expect(await personsStoresUniques(s), 'no UNIQUE (org_id, id) may be left on persons/stores').toEqual(uniquesBefore);
    expect(await appliedCount(s), 'no migration row may be recorded').toBe(appliedBefore);
    const [supRow] = await s<{ created_by: string }[]>`select created_by from suppliers where id = ${sup!.id}`;
    const [chRow] = await s<{ store_id: string }[]>`select store_id from sales_channels where id = ${ch!.id}`;
    expect(supRow!.created_by).toBe(b.personId);
    expect(chRow!.store_id).toBe(b.storeId);
  }, 240_000);
});

describe('M2 -- positive control: the same scratch technique with same-org data only', () => {
  const dbName = `shareat_scratch_t398s1_m2_${stamp}`;
  let s: postgres.Sql | undefined;
  afterAll(async () => {
    await s?.end({ timeout: 5 });
    await dropDb(dbName);
    await dropDb(BASE_DB);
  }, 120_000);

  it('the pending migration(s) apply cleanly; afterwards no persons/stores FK is bare (C1/C8 hold) and the seeded rows are intact', async () => {
    s = await cloneBase(dbName);
    const a = await orgFixture(s, 'm2');
    const [sup] = await insSupplier(s, a.orgId, a.personId);
    const [ch] = await insChannel(s, a.orgId, a.storeId);
    const bareBefore = (await bareFks(s)).length;
    expect(bareBefore, 'sanity: the base database has bare persons/stores FKs before S1').toBeGreaterThan(0);
    const appliedBefore = await appliedCount(s);

    await expect(applyEverything(s), 'the S1 migration must apply over same-org data').resolves.toBeUndefined();

    expect(await appliedCount(s), "today's red: no migration after 0193 exists, nothing was applied").toBeGreaterThan(appliedBefore);
    const bare = await bareFks(s);
    expect(bare.length, `${bare.length} persons/stores FKs still lack a composite twin; first: ${bare.slice(0, 5).join(', ')}`).toBe(0);
    const uniques = await personsStoresUniques(s);
    expect(uniques.some((u) => /persons .*\(org_id, id\)/.test(u)), `persons needs UNIQUE (org_id, id): ${JSON.stringify(uniques)}`).toBe(true);
    expect(uniques.some((u) => /stores .*\(org_id, id\)/.test(u)), `stores needs UNIQUE (org_id, id): ${JSON.stringify(uniques)}`).toBe(true);
    const [supRow] = await s<{ created_by: string }[]>`select created_by from suppliers where id = ${sup!.id}`;
    const [chRow] = await s<{ store_id: string }[]>`select store_id from sales_channels where id = ${ch!.id}`;
    expect(supRow!.created_by).toBe(a.personId);
    expect(chRow!.store_id).toBe(a.storeId);
  }, 240_000);
});
