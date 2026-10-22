/**
 * T-398 S4 / DEF-491 part 3 -- migration 0213's pre-flight on scratch databases (M1, M2).
 * docs/tasks/398-padre-garcia-franchise-org.md S4, A1, A2. Real Postgres via TEST_DATABASE_URL, `_test` name guard.
 *
 * A base database is migrated to the journal entry just before 0213 (derived from the journal, never typed) and cloned from
 * a template per leg. Seeds use the catalog-driven synthesizer in t398-s3-fixture.ts (replica mode, CHECKs stripped).
 *
 * MUTANTS: pre-flight dropped -> M1 (no DEF-491 in the error, or no error at all);
 *   pre-flight checks cross-org only -> M1 (the dangling seed must be named);
 *   pre-flight misses one of the two seeded FKs -> M1 (both must be named);
 *   function/trigger created before the pre-flight raises, or not rolled back -> M1 (nothing may remain);
 *   fewer or more than 55 triggers on clean data -> M2.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dbUrl, dropDb, insertOrg, insertSynthResolved, MIGRATIONS_FOLDER, withAdmin } from './t398-s3-fixture';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}
const journalFile = () => JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
const entryNumber = (tag: string) => Number(tag.slice(0, 4));
function baseTag(): string {
  const below = journalFile().entries.filter((e) => entryNumber(e.tag) < 213);
  return below[below.length - 1]!.tag;
}

function buildFolderThroughTag(targetTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-through-s4-base-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const all = journalFile();
  const target = all.entries.find((e) => e.tag === targetTag)!;
  const kept = all.entries.filter((e) => e.when <= target.when);
  const keptTags = new Set(kept.map((e) => e.tag));
  for (const f of readdirSync(MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && keptTags.has(f.slice(0, -4))) writeFileSync(join(dir, f), readFileSync(join(MIGRATIONS_FOLDER, f)));
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...all, entries: kept }, null, 2));
  return dir;
}

const stamp = Date.now();
const BASE_DB = `shareat_t398s4_test_base_${stamp}`;
let baseBuilt = false;
async function ensureBase(): Promise<void> {
  if (baseBuilt) return;
  await dropDb(url!, BASE_DB);
  await withAdmin(url!, (a) => a.unsafe(`CREATE DATABASE "${BASE_DB}"`));
  const s = postgres(dbUrl(url!, BASE_DB), { max: 1 });
  const dir = buildFolderThroughTag(baseTag());
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
  await dropDb(url!, name);
  await withAdmin(url!, (a) => a.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${BASE_DB}"`));
  return postgres(dbUrl(url!, name), { max: 1 });
}
const applyEverything = (s: postgres.Sql) => migrate(drizzle(s), { migrationsFolder: MIGRATIONS_FOLDER });

/** Two of the 55 guarded derived FKs: a line whose header is in org A and whose money account / item is the seeded one. */
const SEEDS = [
  { child: 'sales_day_tenders', col: 'money_account_id', parent: 'money_accounts' },
  { child: 'stock_usage_lines', col: 'item_id', parent: 'items' },
] as const;

async function stripAllChecks(s: postgres.Sql) {
  const ks = await s<{ t: string; c: string }[]>`
    select c.relname as t, con.conname as c from pg_constraint con join pg_class c on c.oid = con.conrelid
    where con.contype = 'c' and c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relispartition`;
  for (const k of ks) await s.unsafe(`alter table "${k.t}" drop constraint "${k.c}"`);
}

type Mode = 'mixed' | 'same';

/** 'mixed': the first seed points at a parent in org B (cross-org), the second at a uuid that exists nowhere (dangling). 'same': both same-org. */
async function seed(s: postgres.Sql, mode: Mode): Promise<{ child: string; id: string; value: string }[]> {
  await stripAllChecks(s);
  return s.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const a = await insertOrg(tx, 'a');
    const b = mode === 'mixed' ? await insertOrg(tx, 'b') : a;
    const out = [];
    for (const [i, x] of SEEDS.entries()) {
      const value =
        mode === 'mixed' && i === 1
          ? (await tx<{ u: string }[]>`select gen_random_uuid()::text as u`)[0]!.u
          : await insertSynthResolved(tx, x.parent, b);
      const id = await insertSynthResolved(tx, x.child, a, { [x.col]: `'${value}'::uuid` });
      out.push({ child: x.child, id, value });
    }
    return out;
  });
}

async function state(s: postgres.Sql) {
  const [r] = await s<{ fns: number; trgs: number; applied: number }[]>`
    select (select count(*)::int from pg_proc where proname = 'assert_same_org_via_parent' and pronamespace = 'public'::regnamespace) as fns,
      (select count(*)::int from pg_trigger t join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and p.proname = 'assert_same_org_via_parent') as trgs,
      (select count(*)::int from drizzle.__drizzle_migrations) as applied`;
  return r!;
}

describe('M1 -- fail-closed pre-flight: one cross-org row and one dangling row in two of the 55 derived FKs, then everything pending is applied', () => {
  const dbName = `shareat_t398s4_test_m1_${stamp}`;
  let s: postgres.Sql | undefined;
  afterAll(async () => {
    await s?.end({ timeout: 5 });
    await dropDb(url!, dbName);
  }, 120_000);

  it('RAISEs naming DEF-491 and both columns; no function, trigger or migration row is left; the seeded rows are unchanged', async () => {
    s = await cloneBase(dbName);
    const rows = await seed(s, 'mixed');
    const before = await state(s);
    let err: Error | undefined;
    try {
      await applyEverything(s);
    } catch (e) {
      err = e as Error;
    }
    expect(err, 'RED today: no 0213 exists, so migrate() ran nothing and raised nothing').toBeDefined();
    const msg = `${err?.message ?? ''} ${(err as { cause?: Error } | undefined)?.cause?.message ?? ''}`;
    expect(msg, 'mutant: pre-flight dropped (a bare error, or none)').toMatch(/DEF-491/);
    for (const x of SEEDS) {
      expect(msg, `mutant: pre-flight checks cross-org only / misses one FK - it must name ${x.child}.${x.col}`).toMatch(new RegExp(`${x.child}[._ -]+${x.col}`));
    }
    const after = await state(s);
    expect(after, 'nothing may remain: no function, no trigger, no migration row').toEqual(before);
    expect(after.fns + after.trgs).toBe(0);
    for (const [i, x] of SEEDS.entries()) {
      const [r] = await s.unsafe<{ v: string }[]>(`select "${x.col}"::text as v from "${x.child}" where id = $1`, [rows[i]!.id]);
      expect(r!.v, `${x.child}.${x.col} untouched (no silent fix)`).toBe(rows[i]!.value);
    }
  }, 300_000);
});

describe('M2 -- positive control: the same two FKs with same-org data', () => {
  const dbName = `shareat_t398s4_test_m2_${stamp}`;
  let s: postgres.Sql | undefined;
  afterAll(async () => {
    await s?.end({ timeout: 5 });
    await dropDb(url!, dbName);
    await dropDb(url!, BASE_DB);
  }, 120_000);

  it('0213 applies cleanly and creates the function and exactly 55 triggers; seeds intact', async () => {
    s = await cloneBase(dbName);
    const rows = await seed(s, 'same');
    const before = await state(s);
    await expect(applyEverything(s), '0213 must apply over same-org data').resolves.toBeUndefined();
    const after = await state(s);
    expect(after.applied, 'RED today: no migration after the base exists').toBeGreaterThan(before.applied);
    expect(after.fns).toBe(1);
    expect(after.trgs, 'exactly 55 triggers (D3)').toBe(55);
    for (const [i, x] of SEEDS.entries()) {
      const [r] = await s.unsafe<{ v: string }[]>(`select "${x.col}"::text as v from "${x.child}" where id = $1`, [rows[i]!.id]);
      expect(r!.v).toBe(rows[i]!.value);
    }
  }, 300_000);
});
