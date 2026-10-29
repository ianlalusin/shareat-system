/**
 * T-398 S3 / DEF-491 -- the remaining org->org parents get composite same-org foreign keys (migration 0213).
 * docs/tasks/398-padre-garcia-franchise-org.md S3, A1, A11, B6, C2, D2, D7. Real Postgres via TEST_DATABASE_URL.
 *
 * Legs here: K1 (the census is whole), K2 (exactly one UNIQUE (org_id, id) per parent), F (a cross-org
 * reference is refused as shareat_app), O (and as the table owner), S (same-org controls), N (NULL passes),
 * and the exemptions-file pins (OPEN 223 -> 82, NO_FK 28 -> 24, D2). The migration's own legs (L1, M1, M2)
 * are in t398-s3-migration.test.ts; the purge leg (P1, D1) in t398-s3-purge-composite-fk.test.ts.
 *
 * Every expected list is READ from pg_constraint (t398-s3-fixture.ts), never typed: the scope is every
 * single-column org->org FK to a parent other than organizations/persons/stores, plus the four FK-less
 * journal-entry references D2 names. Today (0211) 141 of those FKs have no composite twin.
 *
 * Every write runs in a transaction that is ALWAYS rolled back, so the shared test database never keeps a
 * cross-org row (the builder applies 0213 to it, and the pre-flight would refuse over residue).
 *
 * MUTANTS (each is named by the leg that must go red):
 *   - drop one composite from 0213                    -> K1 "every org->org FK has a composite twin" names it; its F and O legs go red
 *   - drop one UNIQUE (org_id, id) the migration adds -> the composite cannot be created; K2 / M2 red
 *   - add a duplicate UNIQUE (org_id, id) on a parent -> K2 ("exactly one") names the parent
 *   - composite made (org_id, col) -> parent (id) wrongly -> K1's shape check (confkey = org_id, id) red
 *   - one of the 4 ref-gap FKs not added             -> K1 "ref-gap" leg and its F/O legs red
 *   - OPEN_DEF_491 / NO_FK_REFERENCES not shrunk      -> the pin legs red (and the S1 census file's pins)
 *   - batch_id left as 'ref-gap'                      -> the D2 leg red
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import * as exemptions from '../../src/rls/same-org-fk-exemptions';
import { NO_FK_REFERENCES, OPEN_DEF_491 } from '../../src/rls/same-org-fk-exemptions';
import { APP_ROLE } from '../../src/rls/registry';
import { buildScratchAtHead, dropDb, insertOrg, insertSynth, isNullable, orgIdUniqueCounts, readRefGaps, readScope, type ScopeFk } from './t398-s3-fixture';

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

// The scope, read once from the catalog at collection time (top-level await; vitest supports it).
const catalogScope = await readScope(sql);
const refGaps = await readRefGaps(sql);
const scope: ScopeFk[] = [...catalogScope, ...refGaps];
const parents = [...new Set(scope.map((e) => e.parent))].sort();

const REF_GAPS_BY_NAME = refGaps.map((g) => `${g.child}.${g.col}`);
const label = (e: ScopeFk) => `${e.child}.${e.col} -> ${e.parent}`;

// =================================================================================================
// K1 -- the census is whole
// =================================================================================================

describe('K1 -- every org->org FK in scope has a composite (org_id, col) -> parent (org_id, id) twin', () => {
  it('sanity: the catalog scope is not trivially empty (141 bare FKs before 0213, 179 in all) and names a parent set', () => {
    expect(catalogScope.length, 'scope read from pg_constraint').toBeGreaterThanOrEqual(141);
    expect(parents.length).toBeGreaterThanOrEqual(45);
  });

  it('RED until 0213: no single-column org->org FK is left without its composite twin', () => {
    const bare = catalogScope.filter((e) => !e.hasComposite).map(label);
    expect(bare.length, `${bare.length} org->org FKs still lack a composite twin (spec: 141 before 0213); first: ${bare.slice(0, 8).join('; ')}`).toBe(0);
  });

  it('RED until 0213: each of the four ref-gap columns (D2) now has a composite FK to journal_entries (org_id, id)', () => {
    const missing = refGaps.filter((e) => !e.hasComposite).map(label);
    expect(missing, 'ref-gap columns with no composite FK').toEqual([]);
  });

  it('RED until 0213: the census is clean when OPEN_DEF_491 holds no org->org entry (the spec\'s "remove the 141, record the red")', () => {
    const bareNotListed = catalogScope.filter((e) => !e.hasComposite).map(label);
    const stillListed = OPEN_DEF_491.filter((e) => e.kind === 'org->org').map((e) => e.fk);
    expect(stillListed.length, `OPEN_DEF_491 still lists ${stillListed.length} org->org entries; first: ${stillListed.slice(0, 5).join(', ')}`).toBe(0);
    expect(bareNotListed).toEqual([]);
  });

  it("RED until 0213: each composite's ON DELETE action mirrors the single-column FK it twins (RESTRICT, CASCADE, SET NULL (col)); a blanket RESTRICT is the mutant", async () => {
    const rows = await sql<{ child: string; col: string; single: string; comp: string; set_cols: string | null; comp_set: string | null }[]>`
      with fks as (select con.*, cardinality(con.conkey) n,
          (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) c1,
          (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[2]) c2
        from pg_constraint con where con.contype = 'f' and con.connamespace = 'public'::regnamespace)
      select cr.relname as child, s.c1 as col, s.confdeltype::text as single, t.confdeltype::text as comp,
        (select string_agg(attname, ',') from pg_attribute where attrelid = s.conrelid and attnum = any(s.confdelsetcols)) as set_cols,
        (select string_agg(attname, ',') from pg_attribute where attrelid = t.conrelid and attnum = any(t.confdelsetcols)) as comp_set
      from fks s join pg_class cr on cr.oid = s.conrelid
      join fks t on t.conrelid = s.conrelid and t.confrelid = s.confrelid and t.n = 2 and t.c1 = 'org_id' and t.c2 = s.c1
      where s.n = 1`;
    const inScope = new Set(catalogScope.map((e) => `${e.child}.${e.col}`));
    const bad = rows
      .filter((r) => inScope.has(`${r.child}.${r.col}`))
      .filter((r) => r.single !== r.comp || (r.single === 'n' && r.comp_set !== r.col)) // SET NULL on a composite must name only the column (never org_id)
      .map((r) => `${r.child}.${r.col}: single ${r.single}(${r.set_cols ?? ''}) vs composite ${r.comp}(${r.comp_set ?? ''})`);
    expect(bad, 'composites whose ON DELETE differs from their single-column twin').toEqual([]);
  });

  it("RED until 0213 is fixed: each composite has the same DEFERRABLE / INITIALLY DEFERRED setting as the single-column FK it twins (a composite left immediate beside a deferred twin is the mutant)", async () => {
    const rows = await sql<{ child: string; col: string; s_def: boolean; s_dfd: boolean; c_def: boolean; c_dfd: boolean }[]>`
      with fks as (select con.*, cardinality(con.conkey) n,
          (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) c1,
          (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[2]) c2
        from pg_constraint con where con.contype = 'f' and con.connamespace = 'public'::regnamespace)
      select cr.relname as child, s.c1 as col, s.condeferrable as s_def, s.condeferred as s_dfd,
        t.condeferrable as c_def, t.condeferred as c_dfd
      from fks s join pg_class cr on cr.oid = s.conrelid
      join fks t on t.conrelid = s.conrelid and t.confrelid = s.confrelid and t.n = 2 and t.c1 = 'org_id' and t.c2 = s.c1
      where s.n = 1`;
    const inScope = new Set(catalogScope.map((e) => `${e.child}.${e.col}`));
    const bad = rows
      .filter((r) => inScope.has(`${r.child}.${r.col}`))
      .filter((r) => r.s_def !== r.c_def || r.s_dfd !== r.c_dfd)
      .map((r) => `${r.child}.${r.col}: single deferrable=${r.s_def} deferred=${r.s_dfd}, composite deferrable=${r.c_def} deferred=${r.c_dfd}`);
    expect(bad, 'composites whose deferral differs from their single-column twin').toEqual([]);
  });

  it('every composite child carries org_id NOT NULL (A8 C7 over the new FKs)', async () => {
    const rows = await sql<{ t: string }[]>`
      select distinct c.relname as t
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_attribute oa on oa.attrelid = c.oid and oa.attname = 'org_id' and not oa.attisdropped
      where con.contype = 'f' and con.connamespace = 'public'::regnamespace and cardinality(con.conkey) = 2
        and (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) = 'org_id'
        and not oa.attnotnull`;
    expect(rows.map((r) => r.t)).toEqual([]);
  });
});

describe('K1b -- the exemptions file after S3 (D2): no org->org left open, NO_FK 24, no ref-gap left, batch_id reclassified', () => {
  // Not a count: S4 (0214) moves the 27 via-header FKs to VIA_HEADER_GUARDED and triggers the other 55, so OPEN_DEF_491 is now empty.
  // What S3 guarantees is that no org->org FK sits in either list.
  it('no S3-scope org->org FK is still listed in OPEN_DEF_491 or VIA_HEADER_GUARDED, and no OPEN entry is kind org->org', () => {
    const s3 = new Set(catalogScope.map((e) => `${e.child}.${e.col}->${e.parent}`));
    const viaList = ((exemptions as Record<string, unknown>).VIA_HEADER_GUARDED as readonly string[] | undefined) ?? [];
    const orgOrgKind = OPEN_DEF_491.filter((e) => e.kind === 'org->org').map((e) => e.fk);
    const s3InOpen = OPEN_DEF_491.map((e) => e.fk).filter((k) => s3.has(k));
    const s3InVia = viaList.filter((k) => s3.has(k));
    expect(orgOrgKind, 'OPEN_DEF_491 entries of kind org->org').toEqual([]);
    expect(s3InOpen, 'S3-scope org->org FKs still in OPEN_DEF_491').toEqual([]);
    expect(s3InVia, 'S3-scope org->org FKs in VIA_HEADER_GUARDED').toEqual([]);
  });
  it('RED until the builder edits NO_FK_REFERENCES: 24 entries, no ref-gap kind remains', () => {
    // T-455 S1 (0215): +lobby_entries.client_request_id (idempotency-key). 24 -> 25.
    // T-472 S1 (0216): +5 pos_bridge external keys (pos_store_id x2, firestore_doc_id, parent_doc_id, pos_item_id). 25 -> 30.
    expect(NO_FK_REFERENCES.length, `NO_FK_REFERENCES has ${NO_FK_REFERENCES.length} entries; S3 leaves 24`).toBe(31); // T-398 S6 (0220): +franchise_access_log.session_id (snapshot), 30 -> 31
    expect(NO_FK_REFERENCES.filter((e) => e.kind === 'ref-gap').map((e) => e.column)).toEqual([]);
  });
  it('RED until reclassified (D2): pos_v1_day_feeds.batch_id is an idempotency-key (it has no parent), still declared, still FK-less', async () => {
    const e = NO_FK_REFERENCES.find((x) => x.column === 'pos_v1_day_feeds.batch_id');
    expect(e, 'batch_id must stay declared as a no-FK reference').toBeDefined();
    expect(e!.kind).toBe('idempotency-key');
    const fk = await sql`
      select 1 from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
      where con.contype = 'f' and con.conrelid = 'pos_v1_day_feeds'::regclass and a.attname = 'batch_id'`;
    expect(fk.length, 'batch_id must NOT get an FK (D2: a minted grouping id with no parent)').toBe(0);
  });
  it('the four columns that left the no-FK list are not still declared there', () => {
    const gone = REF_GAPS_BY_NAME.filter((c) => NO_FK_REFERENCES.some((e) => e.column === c));
    expect(gone, 'ref-gap columns still listed as FK-less').toEqual([]);
  });
});
// =================================================================================================
// K2 (B6) -- exactly one UNIQUE (org_id, id) on every parent
// =================================================================================================

describe('K2 -- every parent of a composite carries exactly one UNIQUE (org_id, id)', () => {
  it.each(parents.map((p) => [p]))('%s', async (p) => {
    const counts = await orgIdUniqueCounts(sql, [p]);
    expect(counts[p], `${p}: expected exactly one UNIQUE (org_id, id); 0 = composite cannot exist, 2+ = duplicate (B6 mutant)`).toBe(1);
  });
});

// =================================================================================================
// F / O / S / N -- behaviour, one set per FK in scope (the spec asks >= 1 per parent; this runs every FK)
// =================================================================================================

type PgErr = Error & { code?: string; constraint_name?: string };
class Rollback extends Error {}

interface LegResult {
  err?: PgErr;
  rows: number;
}

// The F/O/S/N legs run in a scratch database at head with CHECKs and user triggers stripped (see the fixture header).
const SCRATCH = `shareat_t398s3_test_fk_${Date.now()}`;
let ssql: postgres.Sql;
beforeAll(async () => {
  ssql = await buildScratchAtHead(url, SCRATCH);
}, 300_000);
afterAll(async () => {
  await ssql?.end({ timeout: 5 });
  await dropDb(url, SCRATCH);
}, 120_000);

/**
 * Setup (committed, replica mode): one child row in org A, one parent row in org B and one in org A.
 * Leg (a second transaction, origin mode, as shareat_app with app.org_id = A when `asApp`, ALWAYS rolled
 * back): set the child's FK column to the chosen parent.
 */
async function leg(e: ScopeFk, target: 'foreign' | 'own' | 'null', asApp: boolean): Promise<LegResult> {
  const ids = await ssql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const a = await insertOrg(tx, 'a');
    const b = await insertOrg(tx, 'b');
    const parentB = await insertSynth(tx, e.parent, b);
    const parentA = await insertSynth(tx, e.parent, a);
    const childId = await insertSynth(tx, e.child, a);
    return { a, parentA, parentB, childId };
  });
  const out: LegResult = { rows: -1 };
  try {
    await ssql.begin(async (tx) => {
      // F and O: check deferred FKs at the statement, so a DEFERRABLE INITIALLY DEFERRED composite fires inside the rolled-back leg.
      if (target === 'foreign') await tx`set constraints all immediate`;
      if (asApp) {
        await tx.unsafe(`set local role ${APP_ROLE}`);
        await tx`select set_config('app.org_id', ${ids.a}, true)`;
      }
      const value = target === 'foreign' ? ids.parentB : target === 'own' ? ids.parentA : null;
      try {
        await tx.savepoint(async (sp) => {
          const r = await sp.unsafe(`update "${e.child}" set "${e.col}" = $1 where id = $2 returning id`, [value, ids.childId]);
          out.rows = r.length;
        });
      } catch (err) {
        out.err = err as PgErr;
      }
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

const legCases = scope.map((e) => [label(e), e] as const);

describe('S -- same-org control: pointing the column at the org\'s OWN parent succeeds (proves the fixture, and that the guard is the org check)', () => {
  it.each(legCases)('%s as shareat_app', async (_name, e) => {
    const r = await leg(e, 'own', true);
    expect(r.err, `same-org update must succeed: ${r.err?.message}`).toBeUndefined();
    expect(r.rows, 'the update must touch exactly the one fixture row (0 = the row was invisible to RLS or the fixture is wrong)').toBe(1);
  });
});

describe('F -- as shareat_app (org A), pointing the column at ORG B\'s parent is refused with 23503', () => {
  it.each(legCases)('%s', async (_name, e) => {
    const r = await leg(e, 'foreign', true);
    expect(r.err, `RED today: no error (rows touched: ${r.rows}) - the cross-org reference was ACCEPTED`).toBeDefined();
    expect(r.err?.code, `${r.err?.message}`).toBe('23503');
  });
});

describe('O -- the table OWNER (bypasses RLS) is refused the same cross-org UPDATE with 23503', () => {
  it.each(legCases)('%s', async (_name, e) => {
    const r = await leg(e, 'foreign', false);
    expect(r.err, `RED today: no error (rows touched: ${r.rows}) - the cross-org reference was ACCEPTED`).toBeDefined();
    expect(r.err?.code, `${r.err?.message}`).toBe('23503');
  });
});

describe('N -- MATCH SIMPLE: setting a nullable FK column to NULL passes the composite', () => {
  it.each(legCases)('%s', async (_name, e) => {
    if (!(await isNullable(sql, e.child, e.col))) return; // a NOT NULL column cannot be set to NULL; nothing to prove
    const r = await leg(e, 'null', true);
    expect(r.err, `NULL on a nullable column must pass: ${r.err?.message}`).toBeUndefined();
  });
});
