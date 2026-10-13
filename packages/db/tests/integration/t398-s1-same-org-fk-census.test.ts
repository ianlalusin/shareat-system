/**
 * T-398 S1 / DEF-491 part 1 -- docs/tasks/398-padre-garcia-franchise-org.md R1, A1, A8, S1 legs
 * C1-C8, L1. Real Postgres via TEST_DATABASE_URL, `_test` name guard.
 *
 * The census reads pg_constraint / pg_trigger and fails the build on any foreign key that crosses a
 * tenant boundary without a same-org guard and is not listed in
 * packages/db/src/rls/same-org-fk-exemptions.ts. Every list in that file is PINNED BY VALUE below:
 * changing the file without changing this test is red.
 *
 * Red today (0193): the post-S1 baseline pin (C4/C4b), C1b and C8 (229 persons/stores org->org FKs
 * have no composite twin), L1 (no S1 migration). Green by construction: C2, C3, C5-C7 and the pin
 * detectors (they prove the checker, which lives in this file).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CROSS_ORG_BY_DESIGN,
  JSONB_REFERENCES,
  NO_FK_REFERENCES,
  OPEN_DEF_491,
  ORG_LESS_TABLES,
  type ByDesignEntry,
  type OpenFkEntry,
} from '../../src/rls/same-org-fk-exemptions';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// =================================================================================================
// PINS -- by value. Changing a list in same-org-fk-exemptions.ts without changing these is red.
// S3 and S4 testers lower OPEN_BASELINE when their builders delete entries.
// =================================================================================================

const sha = (lines: readonly string[]) => createHash('sha256').update([...lines].sort().join('\n')).digest('hex');

/** OPEN_DEF_491 as it must stand AFTER S1 (all current gaps minus the persons/stores org->org ones). */
const OPEN_BASELINE = { count: 223, sha256: '341d656a156ce5e35006ba7dfba23171f824ad17ed65a83806bcd3259585c783' } as const;
/** Planner-ruled permanent exceptions. Empty until S5 adds the inter-entity links. */
const BY_DESIGN_PIN: readonly string[] = [];
const ORG_LESS_PIN: readonly string[] = ['etl_quarantine', 'etl_reconciliation', 'etl_runs', 'etl_source_documents'];
const NO_FK_PIN = { count: 26, sha256: 'aa5b1c19e4f13d6746cee042c9d7a05c11fb6c22f4a612863e90d5cb4914491d' } as const;
const JSONB_PIN = { count: 8, sha256: '13dd5a5b6db1b96ff5028398cf4f3d5a2dca8d1bdb865dd1a41c156a9b1eaaec' } as const;

const openKeys = (l: readonly OpenFkEntry[]) => l.map((e) => e.fk);
const noFkKeys = (l: readonly { column: string; kind: string }[]) => l.map((e) => `${e.column}|${e.kind}`);

/** The pin comparison, as a function so a leg can prove it detects a widened list. */
function pinMismatch(keys: readonly string[], pin: { count: number; sha256: string }): string | null {
  if (keys.length !== pin.count) return `count ${keys.length} != pinned ${pin.count}`;
  if (sha(keys) !== pin.sha256) return `sha256 differs from the pin (same count, different members)`;
  return null;
}

// =================================================================================================
// Catalog reader + the census, as pure functions over rows (so legs can feed synthetic rows).
// =================================================================================================

type Q = postgres.Sql | postgres.TransactionSql;
type Kind = 'org->org' | 'derived->org' | 'org->derived' | 'derived->derived';

interface FkRow {
  child: string;
  col: string;
  parent: string;
  kind: Kind;
  hasTwin: boolean;
  hasTrigger: boolean;
}
const keyOf = (r: { child: string; col: string; parent: string }) => `${r.child}.${r.col}->${r.parent}`;

async function readFks(q: Q): Promise<FkRow[]> {
  const rows = await q<{ child: string; col: string; parent: string; child_org: boolean; parent_org: boolean; has_twin: boolean }[]>`
    with fks as (
      select con.oid, con.conrelid, con.confrelid, con.conkey, cardinality(con.conkey) n,
        (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) col
      from pg_constraint con where con.contype = 'f' and con.connamespace = 'public'::regnamespace)
    select cr.relname as child, f.col, pr.relname as parent,
      exists(select 1 from pg_attribute a where a.attrelid = f.conrelid and a.attname = 'org_id' and not a.attisdropped) as child_org,
      exists(select 1 from pg_attribute a where a.attrelid = f.confrelid and a.attname = 'org_id' and not a.attisdropped) as parent_org,
      exists(select 1 from fks f2 where f2.conrelid = f.conrelid and f2.confrelid = f.confrelid and f2.n = 2 and f2.oid <> f.oid
        and (select attname from pg_attribute where attrelid = f.conrelid and attnum = f2.conkey[1]) = 'org_id'
        and (select attname from pg_attribute where attrelid = f.conrelid and attnum = f2.conkey[2]) = f.col) as has_twin
    from fks f
    join pg_class cr on cr.oid = f.conrelid
    join pg_class pr on pr.oid = f.confrelid
    where f.n = 1 and pr.relname <> 'organizations'
    order by 1, 2, 3`;
  const trig = await q<{ tbl: string; args: string }[]>`
    select c.relname as tbl, encode(t.tgargs, 'hex') as args
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and t.tgfoid::regproc::text like '%assert_same_org_via_parent'`;
  // R3: TG_ARGV = (child FK column, header table, header FK column, target table)
  const guarded = new Set<string>();
  for (const t of trig) {
    const a = Buffer.from(t.args, 'hex').toString('utf8').split('\0');
    if (a.length >= 4) guarded.add(`${t.tbl}.${a[0]}->${a[3]}`);
  }
  return rows
    .filter((r) => !(ORG_LESS_PIN.includes(r.child) && ORG_LESS_PIN.includes(r.parent)))
    .map((r) => ({
      child: r.child,
      col: r.col,
      parent: r.parent,
      kind: `${r.child_org ? 'org' : 'derived'}->${r.parent_org ? 'org' : 'derived'}` as Kind,
      hasTwin: r.has_twin,
      hasTrigger: guarded.has(`${r.child}.${r.col}->${r.parent}`),
    }));
}

interface Lists {
  byDesign: readonly ByDesignEntry[];
  open: readonly OpenFkEntry[];
}
interface Verdict {
  /** unguarded, in neither list */
  gaps: string[];
  /** listed in OPEN_DEF_491 but now guarded, or no longer in the catalog */
  stale: string[];
  /** a listed entry whose `kind` disagrees with the catalog */
  kindMismatch: string[];
  /** on both lists, or a by-design entry with no reason / no ruling id */
  badByDesign: string[];
}
const RULING_RE = /^(T-\d+ (R|A|S)\d+|bible row \d+)/;

function isGuarded(r: FkRow): boolean {
  return r.kind === 'org->org' ? r.hasTwin : r.hasTrigger;
}

function census(fks: readonly FkRow[], lists: Lists): Verdict {
  const byKey = new Map(fks.map((r) => [keyOf(r), r]));
  const design = new Set(lists.byDesign.map((e) => e.fk));
  const open = new Set(lists.open.map((e) => e.fk));
  const v: Verdict = { gaps: [], stale: [], kindMismatch: [], badByDesign: [] };
  for (const r of fks) {
    const k = keyOf(r);
    if (!isGuarded(r) && !design.has(k) && !open.has(k)) v.gaps.push(k);
  }
  for (const e of lists.open) {
    const r = byKey.get(e.fk);
    if (!r || isGuarded(r)) v.stale.push(e.fk);
    else if (r.kind !== e.kind) v.kindMismatch.push(`${e.fk}: listed ${e.kind}, catalog ${r.kind}`);
  }
  for (const e of lists.byDesign) {
    if (open.has(e.fk)) v.badByDesign.push(`${e.fk}: on both lists`);
    if (!e.reason?.trim()) v.badByDesign.push(`${e.fk}: no reason`);
    if (!RULING_RE.test(e.ruling ?? '')) v.badByDesign.push(`${e.fk}: by-design entries need a planner ruling id`);
  }
  return v;
}

const REAL: Lists = { byDesign: CROSS_ORG_BY_DESIGN, open: OPEN_DEF_491 };
const withoutClosedByS1: Lists = { byDesign: CROSS_ORG_BY_DESIGN, open: OPEN_DEF_491.filter((e) => e.closedBy !== 'T-398 S1') };

class Rollback extends Error {}
/** Run `fn` in a transaction that is always rolled back (DDL is transactional in Postgres). */
async function scratch<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await sql.begin(async (tx) => {
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out as T;
}

// =================================================================================================
// C1 / C1b -- the census itself.
// =================================================================================================

describe('C1 -- every cross-tenant FK is guarded, or in exactly one of the two lists', () => {
  it('no unlisted gap, no stale entry, no kind mismatch, no bad by-design entry', async () => {
    const v = census(await readFks(sql), REAL);
    expect(v.gaps.length, `unlisted unguarded FKs (${v.gaps.length}): ${v.gaps.slice(0, 20).join(', ')}`).toBe(0);
    expect(v.stale, `stale entries (${v.stale.length}): ${v.stale.slice(0, 20).join(', ')}`).toEqual([]);
    expect(v.kindMismatch).toEqual([]);
    expect(v.badByDesign).toEqual([]);
  });
});

describe('C1b -- with the S1-closed entries REMOVED from OPEN_DEF_491 the census is still clean (the spec\'s "tester removes the 214, records the red")', () => {
  it('RED until the S1 migration adds the persons/stores composites: every entry marked closedBy T-398 S1 is a gap', async () => {
    const v = census(await readFks(sql), withoutClosedByS1);
    const closedCount = OPEN_DEF_491.filter((e) => e.closedBy === 'T-398 S1').length;
    expect(v.gaps.length, `${v.gaps.length} FKs lack a composite twin (file marks ${closedCount} as closedBy S1); first: ${v.gaps.slice(0, 8).join(', ')}`).toBe(0);
  });
});

// =================================================================================================
// C2 -- stale / unknown / double-listed / mis-kinded entries are caught (synthetic catalog rows).
// =================================================================================================

describe('C2 -- the checker reports stale, unknown, double-listed and mis-kinded entries (synthetic rows through the real checker)', () => {
  const fake: FkRow[] = [
    { child: 'a', col: 'p_id', parent: 'persons', kind: 'org->org', hasTwin: true, hasTrigger: false },
    { child: 'b', col: 's_id', parent: 'stores', kind: 'org->org', hasTwin: false, hasTrigger: false },
    { child: 'c', col: 'h_id', parent: 'headers', kind: 'derived->org', hasTwin: false, hasTrigger: false },
  ];
  it('an OPEN entry whose FK now has a twin is STALE, naming it', () => {
    const v = census(fake, { byDesign: [], open: [{ fk: 'a.p_id->persons', kind: 'org->org' }, { fk: 'b.s_id->stores', kind: 'org->org' }, { fk: 'c.h_id->headers', kind: 'derived->org' }] });
    expect(v.stale).toEqual(['a.p_id->persons']);
    expect(v.gaps).toEqual([]);
  });
  it('an OPEN entry for an FK that does not exist is stale', () => {
    const v = census(fake, { byDesign: [], open: [{ fk: 'zz.nope->stores', kind: 'org->org' }, { fk: 'b.s_id->stores', kind: 'org->org' }, { fk: 'c.h_id->headers', kind: 'derived->org' }] });
    expect(v.stale).toEqual(['zz.nope->stores']);
  });
  it('an unlisted unguarded FK is a gap; a trigger guards a derived FK', () => {
    const v = census([...fake, { ...fake[2]!, col: 'g_id', hasTrigger: true }], { byDesign: [], open: [{ fk: 'c.h_id->headers', kind: 'derived->org' }] });
    expect(v.gaps).toEqual(['b.s_id->stores']);
  });
  it('a kind mismatch and a double-listed / unruled by-design entry are reported', () => {
    const v = census(fake, {
      byDesign: [{ fk: 'b.s_id->stores', reason: 'x', ruling: 'whatever' }],
      open: [{ fk: 'b.s_id->stores', kind: 'derived->org' }, { fk: 'c.h_id->headers', kind: 'derived->org' }],
    });
    expect(v.kindMismatch.length).toBe(1);
    expect(v.badByDesign.join('|')).toMatch(/on both lists/);
    expect(v.badByDesign.join('|')).toMatch(/planner ruling id/);
  });
});

// =================================================================================================
// C3 -- a brand-new bare org->org FK is caught (scratch table in a rolled-back transaction).
// =================================================================================================

describe('C3 -- a brand-new bare org->org FK on a scratch table is named by the census', () => {
  it('CREATE TABLE zz_c3 (org_id, store_id REFERENCES stores(id)) -> gap zz_c3.store_id->stores', async () => {
    const v = await scratch(async (tx) => {
      await tx.unsafe(`create table zz_c3 (id uuid primary key, org_id uuid not null references organizations(id), store_id uuid references stores(id))`);
      return census(await readFks(tx), REAL);
    });
    expect(v.gaps).toContain('zz_c3.store_id->stores');
  });
  it('a derived child (no org_id) with a bare FK to an org table is named too', async () => {
    const v = await scratch(async (tx) => {
      await tx.unsafe(`create table zz_c3d (id uuid primary key, store_id uuid references stores(id))`);
      return census(await readFks(tx), REAL);
    });
    expect(v.gaps).toContain('zz_c3d.store_id->stores');
  });
});

// =================================================================================================
// C4 -- the ratchet and the by-value pins.
// =================================================================================================

describe('C4 -- OPEN_DEF_491 can only shrink, and is pinned by value', () => {
  it('RED until the builder deletes the closedBy-S1 entries: length <= the post-S1 baseline', () => {
    expect(OPEN_DEF_491.length, `OPEN_DEF_491 has ${OPEN_DEF_491.length} entries, ${OPEN_DEF_491.filter((e) => e.closedBy).length} of them marked closedBy S1; baseline ${OPEN_BASELINE.count}`).toBeLessThanOrEqual(OPEN_BASELINE.count);
  });
  it('C4b -- the members equal the pinned post-S1 set (a swapped entry at equal count is red too)', () => {
    expect(pinMismatch(openKeys(OPEN_DEF_491), OPEN_BASELINE)).toBeNull();
  });
  it('no duplicate keys in OPEN_DEF_491', () => {
    const k = openKeys(OPEN_DEF_491);
    expect(new Set(k).size).toBe(k.length);
  });
  it('the pin detector itself: a widened list (one persons FK added) and a swapped list are both reported', () => {
    const base = ['x.a->y', 'x.b->y'];
    const pin = { count: 2, sha256: sha(base) };
    expect(pinMismatch(base, pin)).toBeNull();
    expect(pinMismatch([...base, 'x.p_id->persons'], pin)).toMatch(/count/);
    expect(pinMismatch(['x.a->y', 'x.c->y'], pin)).toMatch(/sha256/);
  });
});

describe('C4c -- CROSS_ORG_BY_DESIGN cannot be widened silently', () => {
  it('equals the pinned list, and every entry has a reason and a planner ruling id', () => {
    expect(CROSS_ORG_BY_DESIGN.map((e) => e.fk).sort()).toEqual([...BY_DESIGN_PIN].sort());
    expect(census([], REAL).badByDesign).toEqual([]);
  });
  it('mutant: a persons FK added to by-design without a ruling id is rejected by the checker', () => {
    const v = census(
      [{ child: 'expenses', col: 'created_by', parent: 'persons', kind: 'org->org', hasTwin: false, hasTrigger: false }],
      { byDesign: [{ fk: 'expenses.created_by->persons', reason: 'because', ruling: '' }], open: [] },
    );
    expect(v.badByDesign.join('|')).toMatch(/planner ruling id/);
  });
  it('ORG_LESS_TABLES equals its pin', () => {
    expect([...ORG_LESS_TABLES].sort()).toEqual([...ORG_LESS_PIN].sort());
  });
});

// =================================================================================================
// C5 -- journal_lines.party_id (text, no FK) is checked against the party table of the line's own org.
// =================================================================================================

const PARTY_TABLES: Record<string, readonly string[]> = {
  supplier: ['suppliers'],
  customer: ['customers'],
  employee: ['persons', 'employments'],
  store: ['stores'],
  channel: ['sales_channels'],
  money_account: ['money_accounts'],
  loan: ['loans'],
  cash_request: ['cash_requests'],
  owner: ['owners'],
  liability: ['liabilities'],
};

/** Lines whose party exists, but in ANOTHER org than the line's entry. */
async function crossOrgPartyLines(q: Q): Promise<string[]> {
  const bad: string[] = [];
  for (const [type, tables] of Object.entries(PARTY_TABLES)) {
    for (const t of tables) {
      const rows = await q.unsafe<{ id: string }[]>(
        `select jl.id from journal_lines jl
           join journal_entries je on je.id = jl.entry_id
           join "${t}" p on p.id::text = jl.party_id
          where jl.party_type = $1 and p.org_id <> je.org_id`,
        [type],
      );
      bad.push(...rows.map((r) => `${type}:${r.id}`));
    }
  }
  return bad;
}

async function seedOrgWithSupplier(tx: Q, hint: string) {
  const code = `c5-${hint}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [o] = await tx<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [p] = await tx<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [s] = await tx<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${`Sup ${code}`}, ${p!.id}) returning id`;
  return { orgId, supplierId: s!.id };
}

async function seedEntryWithPartyLine(tx: postgres.TransactionSql, orgId: string, partyId: string) {
  await seedChartOfAccounts(tx as unknown as postgres.Sql, orgId);
  const [per] = await tx<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open') returning id`;
  const [ap] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '2110'`;
  const [e] = await tx<{ id: string }[]>`
    insert into journal_entries (org_id, entry_date, period_id, source_type, source_id)
    values (${orgId}, '2026-01-15', ${per!.id}, 'test', ${`c5-${Date.now()}`}) returning id`;
  await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, party_type, party_id)
           values (${e!.id}, 1, ${ap!.id}, '0', '10.00', 'supplier', ${partyId})`;
}

describe('C5 -- journal_lines.party_id against the party table of the line\'s own org', () => {
  it('the live database holds no cross-org party reference', async () => {
    expect(await crossOrgPartyLines(sql)).toEqual([]);
  });
  it('a line in org A whose supplier party_id belongs to org B is FOUND', async () => {
    const found = await scratch(async (tx) => {
      const a = await seedOrgWithSupplier(tx, 'a');
      const b = await seedOrgWithSupplier(tx, 'b');
      await seedEntryWithPartyLine(tx, a.orgId, b.supplierId);
      return crossOrgPartyLines(tx);
    });
    expect(found.length, 'the seeded cross-org party_id must be reported').toBe(1);
  }, 60_000);
  it('positive control: the same line pointing at org A\'s OWN supplier is not flagged', async () => {
    const found = await scratch(async (tx) => {
      const a = await seedOrgWithSupplier(tx, 'a2');
      await seedEntryWithPartyLine(tx, a.orgId, a.supplierId);
      return crossOrgPartyLines(tx);
    });
    expect(found).toEqual([]);
  }, 60_000);
});

// =================================================================================================
// C6 -- a *_id / *_by column with no FK must be declared; jsonb columns must be declared.
// =================================================================================================

async function readNoFkColumns(q: Q): Promise<string[]> {
  const rows = await q<{ t: string; col: string }[]>`
    select c.relname as t, a.attname as col
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and (a.attname like '%\_id' or a.attname like '%\_ids' or a.attname like '%\_by')
      and a.attname <> 'org_id'
      and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'f' and a.attnum = any(k.conkey))
    order by 1, 2`;
  return rows.map((r) => `${r.t}.${r.col}`);
}
async function readJsonbColumns(q: Q): Promise<string[]> {
  const rows = await q<{ t: string; col: string }[]>`
    select c.relname as t, a.attname as col
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.atttypid in ('jsonb'::regtype, 'json'::regtype)
    order by 1, 2`;
  return rows.map((r) => `${r.t}.${r.col}`);
}

describe('C6 -- the declared no-FK reference list and the jsonb list', () => {
  const declared = new Set(NO_FK_REFERENCES.map((e) => e.column));
  it('every no-FK *_id column is declared, and every declaration still exists (no stale)', async () => {
    const found = await readNoFkColumns(sql);
    expect(found.filter((c) => !declared.has(c)), 'undeclared no-FK reference columns').toEqual([]);
    expect([...declared].filter((c) => !found.includes(c)), 'declared columns that no longer exist or now have an FK').toEqual([]);
  });
  it('every declaration has a reason', () => {
    expect(NO_FK_REFERENCES.filter((e) => !e.reason.trim()).map((e) => e.column)).toEqual([]);
    expect(JSONB_REFERENCES.filter((e) => !e.reason.trim()).map((e) => e.column)).toEqual([]);
  });
  it('journal_lines.party_id is declared as asserted-party (C5 asserts it)', () => {
    expect(NO_FK_REFERENCES.find((e) => e.column === 'journal_lines.party_id')?.kind).toBe('asserted-party');
  });
  it('the no-FK list and the jsonb list are pinned by value', () => {
    expect(pinMismatch(noFkKeys(NO_FK_REFERENCES), NO_FK_PIN)).toBeNull();
    expect(pinMismatch(noFkKeys(JSONB_REFERENCES), JSONB_PIN)).toBeNull();
  });
  it('every jsonb column is declared, and none is stale', async () => {
    const found = await readJsonbColumns(sql);
    const decl = new Set(JSONB_REFERENCES.map((e) => e.column));
    expect(found.filter((c) => !decl.has(c)), 'undeclared jsonb columns').toEqual([]);
    expect([...decl].filter((c) => !found.includes(c)), 'declared jsonb columns that no longer exist').toEqual([]);
  });
  it('mutant: a new *_id column with no FK and no declaration is reported', async () => {
    const found = await scratch(async (tx) => {
      await tx.unsafe(`create table zz_c6 (id uuid primary key, org_id uuid not null, widget_id uuid)`);
      return readNoFkColumns(tx);
    });
    expect(found).toContain('zz_c6.widget_id');
    expect(declared.has('zz_c6.widget_id')).toBe(false);
  });
  it('mutant: a new jsonb column with no declaration is reported', async () => {
    const found = await scratch(async (tx) => {
      await tx.unsafe(`create table zz_c6j (id uuid primary key, org_id uuid not null, refs jsonb)`);
      return readJsonbColumns(tx);
    });
    expect(found).toContain('zz_c6j.refs');
    expect(JSONB_REFERENCES.some((e) => e.column === 'zz_c6j.refs')).toBe(false);
  });
});

// =================================================================================================
// C7 -- every child of a composite same-org FK has org_id NOT NULL.
// =================================================================================================

async function nullableCompositeChildren(q: Q): Promise<string[]> {
  const rows = await q<{ t: string }[]>`
    select distinct c.relname as t
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_attribute oa on oa.attrelid = c.oid and oa.attname = 'org_id' and not oa.attisdropped
    where con.contype = 'f' and con.connamespace = 'public'::regnamespace
      and cardinality(con.conkey) = 2
      and (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) = 'org_id'
      and not oa.attnotnull
    order by 1`;
  return rows.map((r) => r.t);
}

describe('C7 -- org_id is NOT NULL on every composite same-org child', () => {
  it('no composite child has a nullable org_id', async () => {
    expect(await nullableCompositeChildren(sql)).toEqual([]);
  });
  it('mutant: a composite FK on a table whose org_id is nullable is reported', async () => {
    const found = await scratch(async (tx) => {
      // money_accounts carries UNIQUE (org_id, id) since 0171; stores does not until the S1 migration.
      await tx.unsafe(`create table zz_c7 (id uuid primary key, org_id uuid, ma uuid,
        foreign key (org_id, ma) references money_accounts (org_id, id))`);
      return nullableCompositeChildren(tx);
    });
    expect(found).toContain('zz_c7');
  });
});

// =================================================================================================
// C8 -- the S1 target itself, independent of the lists: persons and stores are fully twinned.
// =================================================================================================

describe('C8 -- every org-scoped FK to persons or stores has a composite (org_id, col) twin', () => {
  it('RED until the S1 migration: lists the FKs still bare', async () => {
    const bare = (await readFks(sql)).filter((r) => r.kind === 'org->org' && (r.parent === 'persons' || r.parent === 'stores') && !r.hasTwin).map(keyOf);
    expect(bare.length, `${bare.length} persons/stores FKs lack a composite twin (spec says 143+71=214; measured ${bare.length}); first: ${bare.slice(0, 6).join(', ')}`).toBe(0);
  });
  it('persons and stores each carry a UNIQUE (org_id, id)', async () => {
    for (const t of ['persons', 'stores']) {
      const rows = await sql<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = ${t}::regclass and contype in ('u', 'p')`;
      expect(rows.some((r) => /\(org_id, id\)/.test(r.def)), `${t}: no UNIQUE (org_id, id); constraints: ${JSON.stringify(rows.map((r) => r.def))}`).toBe(true);
    }
  });
});

// =================================================================================================
// L1 -- A1: the S1 migration starts with SET LOCAL lock_timeout and states its budget in the header.
// =================================================================================================

const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');

describe('L1 -- the S1 migration text (A1)', () => {
  it('RED until the migration exists: the entry after 0193 contains SET LOCAL lock_timeout first, and a header budget', () => {
    const j = (JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] }).entries;
    const at = j.findIndex((e) => e.tag.startsWith('0193_'));
    const next = j[at + 1];
    expect(next, 'no journal entry after 0193: the S1 migration (0194) does not exist yet').toBeDefined();
    const text = readFileSync(join(MIGRATIONS, `${next!.tag}.sql`), 'utf8');
    expect(text, 'migration must mention DEF-491').toMatch(/DEF-491/);
    const firstStatement = text.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim() !== '')[0] ?? '';
    expect(firstStatement, 'the first statement must be SET LOCAL lock_timeout').toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'/i);
    const header = text.split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(header, 'the header must state the measured budget (time and locks)').toMatch(/budget/i);
    expect(header).toMatch(/\d+(\.\d+)?\s*(s|ms|sec|seconds)\b/i);
    expect(header).toMatch(/SHARE ROW EXCLUSIVE/i);
  });
});
