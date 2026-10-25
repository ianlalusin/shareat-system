/**
 * T-398 S3 / DEF-491 -- migration 0213, its text (L1, D7) and its behaviour on scratch databases (M1, M2).
 * docs/tasks/398-padre-garcia-franchise-org.md S3, A1, A11, B6, C2, D2, D7. Real Postgres via TEST_DATABASE_URL,
 * `_test` name guard; scratch database names contain "_test".
 *
 * M1/M2 build a base database migrated to the entry BEFORE 0213 (the last journal entry whose number is
 * below 0213, which is 0212; derived from the journal, never typed), then clone it from a template. Seed rows are made
 * through the catalog-driven synthesizer in t398-s3-fixture.ts (replica mode, with CHECKs stripped on the
 * four tables the seeds touch, so the rest of the schema stays exactly as the migration will find it).
 *
 * MUTANTS (each names the leg that must go red):
 *   - the pre-flight DO block dropped                  -> M1 (message assertion: no DEF-491; the error would be a bare 23503)
 *   - the pre-flight misses one of the 145 FKs         -> M1 (each of the three seeds must be named)
 *   - one composite dropped / one UNIQUE (org_id, id) not added -> M2 (counts 145 / 38, and the K1 scope re-read)
 *   - VALIDATE ordered before ADD ... NOT VALID         -> M2 (the migration fails on the scratch database)
 *   - SET LOCAL lock_timeout missing or not first       -> L1
 *   - the header carries no budget / no pg_constraint query / wrong counts -> L1
 *   - a duplicate UNIQUE (org_id, id) on a parent that has one -> M2 (migration fails: duplicate constraint name / count 38 wrong)
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dbUrl, dropDb, insertOrg, insertSynthResolved, MIGRATIONS_FOLDER, orgIdUniqueCounts, readRefGaps, readScope, withAdmin } from './t398-s3-fixture';

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

/** The entry just before S3's (number <= 212, i.e. 0212_t464_pos_tablet_pairings): the base the scratch databases are built to. */
function baseTag(): string {
  const below = journalFile().entries.filter((e) => entryNumber(e.tag) <= 212);
  return below[below.length - 1]!.tag;
}
const s3Entry = () => journalFile().entries.find((e) => e.tag.startsWith('0213_'));

// =================================================================================================
// L1 (D7) -- 0213's own text: lock_timeout first, a budget in the header, the pg_constraint query, a fail-closed pre-flight
// =================================================================================================

describe('L1 (D7) -- the 0213 migration text', () => {
  const text = (): string => {
    const e = s3Entry();
    expect(e, 'no journal entry numbered 0213: the S3 migration does not exist yet').toBeDefined();
    return readFileSync(join(MIGRATIONS_FOLDER, `${e!.tag}.sql`), 'utf8');
  };
  const statements = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim() !== '');

  it('RED until the migration exists: the journal has exactly one 0213 entry, after 0211, and its file is LF-only UTF-8 with no BOM', () => {
    const entries = journalFile().entries.filter((e) => e.tag.startsWith('0213_'));
    expect(entries.length, 'journal entries numbered 0213').toBe(1);
    const t = text();
    expect(t.includes('\r'), 'CRLF line endings').toBe(false);
    expect(t.charCodeAt(0), 'BOM').not.toBe(0xfeff);
  });

  it('RED until the migration exists: the first statement is SET LOCAL lock_timeout = \'5s\' and it mentions DEF-491', () => {
    const t = text();
    expect(t).toMatch(/DEF-491/);
    expect(statements(t)[0] ?? '').toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'/i);
  });

  it('RED until the migration exists: the header states the budget (a measured time, the lock mode), the pg_constraint query (B6) and the counts (D2: 145 composites, 38 new uniques)', () => {
    const header = text().split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(header, 'the header must state the budget').toMatch(/budget/i);
    expect(header, 'a measured time with a unit').toMatch(/\d+(\.\d+)?\s*(s|ms|sec|seconds)\b/i);
    expect(header).toMatch(/SHARE ROW EXCLUSIVE/i);
    expect(header, 'B6/D2: the pg_constraint query that lists the parents is pasted in the header').toMatch(/pg_constraint/i);
    expect(header, 'D2: 145 composite FKs').toMatch(/\b145\b/);
    expect(header, 'D2: 38 new UNIQUE (org_id, id)').toMatch(/\b38\b/);
  });

  it('RED until the migration exists: a fail-closed pre-flight (DO block that RAISEs naming DEF-491) comes after lock_timeout and before the first ADD CONSTRAINT', () => {
    const t = text();
    const lock = t.search(/SET LOCAL lock_timeout/i);
    const doBlock = t.search(/\bDO \$\$/);
    const raise = t.search(/RAISE EXCEPTION/i);
    const firstAdd = t.search(/ADD CONSTRAINT/i);
    expect(doBlock, 'a DO $$ pre-flight block').toBeGreaterThan(lock);
    expect(raise, 'RAISE EXCEPTION inside it').toBeGreaterThan(doBlock);
    expect(firstAdd, 'the pre-flight precedes every ADD CONSTRAINT').toBeGreaterThan(raise);
    expect(t.slice(doBlock, firstAdd)).toMatch(/DEF-491/);
  });
});

// =================================================================================================
// M1 / M2 -- scratch databases at the entry before 0213
// =================================================================================================

function buildFolderThroughTag(targetTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-through-base-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const all = journalFile();
  const target = all.entries.find((e) => e.tag === targetTag);
  if (!target) throw new Error(`journal entry for "${targetTag}" not found`);
  const kept = all.entries.filter((e) => e.when <= target.when);
  const keptTags = new Set(kept.map((e) => e.tag));
  for (const f of readdirSync(MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && keptTags.has(f.slice(0, -4))) writeFileSync(join(dir, f), readFileSync(join(MIGRATIONS_FOLDER, f)));
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...all, entries: kept }, null, 2));
  return dir;
}

const stamp = Date.now();
const BASE_DB = `shareat_t398s3_test_base_${stamp}`;
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
// T-472 S1: apply THROUGH 0213 only. Later migrations (0214 triggers, 0216 new bridge tables with their own composite FKs) are out
// of this test's scope and would change its pinned counts (145 composites / 38 uniques); every migration the test means is <= 0213.
async function applyEverything(s: postgres.Sql): Promise<void> {
  const dir = buildFolderThroughTag(s3Entry()!.tag);
  try {
    await migrate(drizzle(s), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Three seeds, one per kind of gap: two org->org FKs read from the catalog scope, and one FK-less ref-gap column (A11/D2). */
const SEEDS = [
  { child: 'supplier_items', col: 'supplier_id', parent: 'suppliers' },
  { child: 'price_list_items', col: 'price_list_id', parent: 'price_lists' },
  { child: 'owner_drawing_closes', col: 'adjustment_entry_id', parent: 'journal_entries' },
] as const;

async function stripAllChecks(s: postgres.Sql) {
  const ks = await s<{ t: string; c: string }[]>`
    select c.relname as t, con.conname as c from pg_constraint con join pg_class c on c.oid = con.conrelid
    where con.contype = 'c' and c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relispartition`;
  for (const k of ks) await s.unsafe(`alter table "${k.t}" drop constraint "${k.c}"`);
}

type SeedMode = 'cross' | 'same' | 'dangling';

/**
 * Seed one row per SEED. 'cross': the referenced parent is in a second org. 'same': same org. 'dangling': the
 * column holds a uuid that exists nowhere. Every OTHER NOT NULL FK column of a seeded row points at a real
 * same-org row (insertSynthResolved), so the only thing the migration can object to is the seeded column.
 * CHECKs are stripped on the clone (replica mode skips FKs and user triggers).
 */
async function seed(s: postgres.Sql, mode: SeedMode): Promise<{ child: string; id: string; parentOrg: string; parentId: string }[]> {
  await stripAllChecks(s);
  return s.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const a = await insertOrg(tx, 'ma');
    const b = mode === 'cross' ? await insertOrg(tx, 'mb') : a;
    const out = [];
    for (const x of SEEDS) {
      const parentId = mode === 'dangling' ? (await tx<{ u: string }[]>`select gen_random_uuid()::text as u`)[0]!.u : await insertSynthResolved(tx, x.parent, b);
      const id = await insertSynthResolved(tx, x.child, a, { [x.col]: `'${parentId}'::uuid` });
      out.push({ child: x.child, id, parentOrg: b, parentId });
    }
    return out;
  });
}

async function constraintCounts(s: postgres.Sql) {
  const [r] = await s<{ composites: number; uniques: number; applied: number }[]>`
    select
      (select count(*)::int from pg_constraint con where con.contype = 'f' and con.connamespace = 'public'::regnamespace
         and cardinality(con.conkey) = 2
         and (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) = 'org_id'
         and (select attname from pg_attribute where attrelid = con.confrelid and attnum = con.confkey[2]) = 'id') as composites,
      (select count(*)::int from pg_constraint u where u.contype = 'u' and u.connamespace = 'public'::regnamespace and cardinality(u.conkey) = 2
         and (select array_agg(attname::text order by attname) from pg_attribute where attrelid = u.conrelid and attnum = any(u.conkey)) = array['id', 'org_id']) as uniques,
      (select count(*)::int from drizzle.__drizzle_migrations) as applied`;
  return r!;
}

async function seededColumn(s: postgres.Sql, x: { child: string; id: string }, col: string): Promise<string> {
  const [r] = await s.unsafe<{ v: string }[]>(`select "${col}"::text as v from "${x.child}" where id = $1`, [x.id]);
  return r!.v;
}

describe('M1 -- fail-closed pre-flight: cross-org rows seeded on a scratch DB before 0213, then everything pending is applied', () => {
  const dbName = `shareat_t398s3_test_m1_${stamp}`;
  let s: postgres.Sql | undefined;
  afterAll(async () => {
    await s?.end({ timeout: 5 });
    await dropDb(url!, dbName);
  }, 120_000);

  it('RAISEs naming DEF-491 and all three seeded FKs; no constraint, unique or migration row is left; seeded rows unchanged', async () => {
    s = await cloneBase(dbName);
    const rows = await seed(s, 'cross');
    const before = await constraintCounts(s);

    let err: Error | undefined;
    try {
      await applyEverything(s);
    } catch (e) {
      err = e as Error;
    }
    expect(err, "RED today: no 0213 exists, so migrate() ran nothing and raised nothing").toBeDefined();
    const msg = `${err?.message ?? ''} ${(err as { cause?: Error } | undefined)?.cause?.message ?? ''}`;
    expect(msg, 'the pre-flight must name DEF-491 (a bare FK-violation error means the pre-flight is missing)').toMatch(/DEF-491/);
    for (const x of SEEDS) {
      expect(msg, `the pre-flight must name ${x.child}.${x.col}`).toMatch(new RegExp(`${x.child}[._ -]+${x.col}`));
    }

    const after = await constraintCounts(s);
    expect(after, 'the whole migration must roll back: no composite, no unique, no migration row left behind').toEqual(before);
    for (const [i, x] of SEEDS.entries()) {
      expect(await seededColumn(s, rows[i]!, x.col), `${x.child}.${x.col} must be untouched (no silent fix)`).toBe(rows[i]!.parentId);
    }
  }, 300_000);
});

describe('M3 -- the pre-flight also refuses DANGLING references (a uuid that exists nowhere), not only cross-org ones', () => {
  const dbName = `shareat_t398s3_test_m3_${stamp}`;
  let s: postgres.Sql | undefined;
  afterAll(async () => {
    await s?.end({ timeout: 5 });
    await dropDb(url!, dbName);
  }, 120_000);

  it('RAISEs naming DEF-491 and all three seeded columns (mutant: a pre-flight that compares org_id only would pass and the ADD CONSTRAINT would fail with a bare 23503); nothing is left behind', async () => {
    s = await cloneBase(dbName);
    const rows = await seed(s, 'dangling');
    const before = await constraintCounts(s);
    let err: Error | undefined;
    try {
      await applyEverything(s);
    } catch (e) {
      err = e as Error;
    }
    expect(err, 'RED today: no 0213, nothing raised').toBeDefined();
    const msg = `${err?.message ?? ''} ${(err as { cause?: Error } | undefined)?.cause?.message ?? ''}`;
    expect(msg).toMatch(/DEF-491/);
    for (const x of SEEDS) expect(msg, `the pre-flight must name ${x.child}.${x.col}`).toMatch(new RegExp(`${x.child}[._ -]+${x.col}`));
    expect(await constraintCounts(s)).toEqual(before);
    for (const [i, x] of SEEDS.entries()) expect(await seededColumn(s, rows[i]!, x.col)).toBe(rows[i]!.parentId);
  }, 300_000);
});

describe('M2 -- positive control: the same scratch technique with same-org data only', () => {
  const dbName = `shareat_t398s3_test_m2_${stamp}`;
  let s: postgres.Sql | undefined;
  afterAll(async () => {
    await s?.end({ timeout: 5 });
    await dropDb(url!, dbName);
    await dropDb(url!, BASE_DB);
  }, 120_000);

  it('0213 applies cleanly over same-org data: exactly 145 composites and 38 UNIQUE (org_id, id) are added, no FK is left bare, every parent has exactly one key, seeds intact', async () => {
    s = await cloneBase(dbName);
    const rows = await seed(s, 'same');
    const before = await constraintCounts(s);
    const bareBefore = (await readScope(s)).filter((e) => !e.hasComposite).length;
    expect(bareBefore, 'sanity: the base has the 141 bare org->org FKs before 0213').toBe(141);

    await expect(applyEverything(s), '0213 must apply over same-org data').resolves.toBeUndefined();

    const after = await constraintCounts(s);
    expect(after.applied, "RED today: no migration after the base exists, nothing was applied").toBeGreaterThan(before.applied);
    expect(after.composites - before.composites, 'D2: 141 catalog FKs + 4 ref-gap FKs = 145 new composites').toBe(145);
    expect(after.uniques - before.uniques, 'D2: 38 new UNIQUE (org_id, id) (7 parents already had one, B6)').toBe(38);

    const scope = await readScope(s);
    expect(scope.filter((e) => !e.hasComposite).map((e) => `${e.child}.${e.col}->${e.parent}`), 'bare org->org FKs after 0213').toEqual([]);
    expect((await readRefGaps(s)).filter((e) => !e.hasComposite).map((e) => `${e.child}.${e.col}`), 'ref-gap columns without a composite').toEqual([]);
    const parents = [...new Set(scope.map((e) => e.parent))];
    const counts = await orgIdUniqueCounts(s, parents);
    expect(Object.entries(counts).filter(([, n]) => n !== 1), 'parents without exactly one UNIQUE (org_id, id)').toEqual([]);

    for (const [i, x] of SEEDS.entries()) {
      expect(await seededColumn(s, rows[i]!, x.col)).toBe(rows[i]!.parentId);
    }
  }, 300_000);
});
