/**
 * T-398 S3 test helper (not a test file) -- a catalog-driven row synthesizer and the S3 scope reader.
 *
 * Nothing here is a hand list of tables: the scope (which FKs and which parents) comes from
 * pg_constraint, and a row for ANY table is built from pg_attribute (every NOT NULL column with no
 * default gets a type-appropriate value). Setup inserts run under session_replication_role = replica
 * (the test connection is a superuser), so they skip FK checks and user triggers: a row can be built
 * without first building its whole ancestry. The leg under test then switches back to origin and
 * changes ONE foreign-key column, which is the only thing the composite FK has to check
 * (Postgres re-checks an FK only when its key columns change).
 *
 * WHY A SCRATCH DATABASE (measured, not assumed): a synthesized row breaks real CHECK constraints (status
 * enums, revenue identities, path shapes ...) and real business triggers, and Postgres re-checks EVERY FK of
 * a row that was inserted by the SAME transaction that updates it. So the F legs run in a throwaway database
 * migrated to head, from which every CHECK constraint and every user trigger is removed once
 * (`buildScratchAtHead`): rows are committed in replica mode, then the leg updates ONE FK column in a second,
 * rolled-back transaction. The only thing left that can refuse the update is the foreign key under test.
 * The database name contains "_test" (the repo's guard) and is dropped afterwards.
 *
 * OVERRIDES is the one place a value may be hand-chosen: a column whose NOT NULL value cannot be synthesized.
 * Keys are `table.column`; values are SQL expressions.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Q = postgres.Sql | postgres.TransactionSql;

export interface ScopeFk {
  child: string;
  col: string;
  parent: string;
  /** true when an (org_id, col) -> parent (org_id, id) composite already exists */
  hasComposite: boolean;
  /** 'catalog' = a single-column FK found in pg_constraint; 'ref-gap' = a column with no FK until S3 (A11/D2) */
  origin: 'catalog' | 'ref-gap';
}

/**
 * D2: the four FK-less journal-entry references S3 turns into composite FKs. They have NO single-column
 * FK to find in the catalog, so the spec names them; they are the only hand-named columns in this suite.
 */
export const REF_GAP_COLUMNS: readonly { child: string; col: string; parent: string }[] = [
  { child: 'payslips', col: 'journal_entry_id', parent: 'journal_entries' },
  { child: 'separations', col: 'journal_entry_id', parent: 'journal_entries' },
  { child: 'thirteenth_month_payouts', col: 'journal_entry_id', parent: 'journal_entries' },
  { child: 'owner_drawing_closes', col: 'adjustment_entry_id', parent: 'journal_entries' },
];

/**
 * Every single-column org->org FK in `public` (both ends carry org_id; parent is not organizations, persons
 * or stores -- S1 did those), read from pg_constraint. "hasComposite" is true when a two-column FK
 * (org_id, col) on the same child references (org_id, id) on the same parent.
 */
export async function readScope(q: Q): Promise<ScopeFk[]> {
  const rows = await q<{ child: string; col: string; parent: string; has_composite: boolean }[]>`
    with fks as (
      select con.oid, con.conrelid, con.confrelid, con.conkey, con.confkey, cardinality(con.conkey) n,
        (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) col
      from pg_constraint con where con.contype = 'f' and con.connamespace = 'public'::regnamespace)
    select cr.relname as child, f.col, pr.relname as parent,
      exists(select 1 from fks f2
        where f2.conrelid = f.conrelid and f2.confrelid = f.confrelid and f2.n = 2 and f2.oid <> f.oid
          and (select attname from pg_attribute where attrelid = f.conrelid and attnum = f2.conkey[1]) = 'org_id'
          and (select attname from pg_attribute where attrelid = f.conrelid and attnum = f2.conkey[2]) = f.col
          and (select attname from pg_attribute where attrelid = f.confrelid and attnum = f2.confkey[1]) = 'org_id'
          and (select attname from pg_attribute where attrelid = f.confrelid and attnum = f2.confkey[2]) = 'id') as has_composite
    from fks f
    join pg_class cr on cr.oid = f.conrelid
    join pg_class pr on pr.oid = f.confrelid
    where f.n = 1 and pr.relname not in ('organizations', 'persons', 'stores')
      and exists(select 1 from pg_attribute a where a.attrelid = f.conrelid and a.attname = 'org_id' and not a.attisdropped)
      and exists(select 1 from pg_attribute a where a.attrelid = f.confrelid and a.attname = 'org_id' and not a.attisdropped)
    order by 1, 2, 3`;
  return rows.map((r) => ({ child: r.child, col: r.col, parent: r.parent, hasComposite: r.has_composite, origin: 'catalog' as const }));
}

/** The four ref-gap columns, with hasComposite read from the catalog (a two-column FK on (org_id, col)). */
export async function readRefGaps(q: Q): Promise<ScopeFk[]> {
  const out: ScopeFk[] = [];
  for (const g of REF_GAP_COLUMNS) {
    const [r] = await q<{ n: number }[]>`
      select count(*)::int as n from pg_constraint con
      where con.contype = 'f' and con.conrelid = ${g.child}::regclass and con.confrelid = ${g.parent}::regclass
        and cardinality(con.conkey) = 2
        and (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) = 'org_id'
        and (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[2]) = ${g.col}
        and (select attname from pg_attribute where attrelid = con.confrelid and attnum = con.confkey[2]) = 'id'`;
    out.push({ ...g, hasComposite: (r?.n ?? 0) > 0, origin: 'ref-gap' });
  }
  return out;
}

/** `(org_id, id)` uniques per parent, counting PRIMARY/UNIQUE constraints whose column set is exactly {org_id, id}. */
export async function orgIdUniqueCounts(q: Q, parents: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const p of parents) {
    const [r] = await q<{ n: number }[]>`
      select count(*)::int as n from pg_constraint u
      where u.conrelid = ${p}::regclass and u.contype in ('u', 'p') and cardinality(u.conkey) = 2
        and (select array_agg(attname::text order by attname) from pg_attribute where attrelid = u.conrelid and attnum = any(u.conkey)) = array['id', 'org_id']`;
    out[p] = r?.n ?? 0;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// The row synthesizer
// -------------------------------------------------------------------------------------------------

/** `table.column` -> SQL expression, for a column whose CHECK rejects the synthesized value. Filled by running the suite. */
export const OVERRIDES: Record<string, string> = {};

interface Col {
  name: string;
  typ: string;
  notnull: boolean;
  hasDefault: boolean;
  generated: boolean;
  identity: boolean;
  labels: string[] | null;
}

const colCache = new Map<string, Col[]>();
async function columnsOf(q: Q, table: string): Promise<Col[]> {
  const hit = colCache.get(table);
  if (hit) return hit;
  const rows = await q<
    { name: string; typ: string; nn: boolean; hasdef: boolean; gen: string; ident: string; labels: string[] | null }[]
  >`
    select a.attname as name, format_type(a.atttypid, a.atttypmod) as typ, a.attnotnull as nn, a.atthasdef as hasdef,
      a.attgenerated as gen, a.attidentity as ident,
      (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid) as labels
    from pg_attribute a
    where a.attrelid = ${table}::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum`;
  const cols = rows.map((r) => ({
    name: r.name,
    typ: r.typ,
    notnull: r.nn,
    hasDefault: r.hasdef,
    generated: r.gen !== '',
    identity: r.ident !== '',
    labels: r.labels,
  }));
  colCache.set(table, cols);
  return cols;
}

let counter = 0;
const q1 = (s: string) => `'${s.replace(/'/g, "''")}'`;

function literalFor(table: string, c: Col): string {
  const ov = OVERRIDES[`${table}.${c.name}`];
  if (ov !== undefined) return ov;
  const n = ++counter;
  const t = c.typ;
  if (c.labels && c.labels.length > 0) return `${q1(c.labels[0]!)}::${t}`;
  if (t.endsWith('[]')) return `'{}'::${t}`;
  if (t === 'uuid') return 'gen_random_uuid()';
  if (t === 'text') return `('t' || ${n} || substr(md5(random()::text), 1, 8))`;
  const vc = /^(character varying|character)\((\d+)\)$/.exec(t);
  if (vc) return `substr('t' || ${n} || md5(random()::text), 1, ${Math.min(Number(vc[2]), 12)})`;
  if (t === 'integer' || t === 'smallint' || t === 'bigint') return String(1 + (n % 900));
  if (t.startsWith('numeric')) return '1';
  if (t === 'boolean') return 'false';
  if (t === 'date') return 'current_date';
  if (t.startsWith('timestamp')) return 'now()';
  if (t.startsWith('time ')) return `'00:00'`;
  if (t === 'jsonb' || t === 'json') return `'{}'::${t}`;
  if (t === 'bytea') return `'\\x00'::bytea`;
  if (t === 'double precision' || t === 'real') return '1';
  if (t === 'inet') return `'127.0.0.1'::inet`;
  throw new Error(`fixture: no literal for ${table}.${c.name} of type ${t}; add an OVERRIDES entry`);
}

/**
 * Insert one row into `table` for `orgId` and return its id. Every NOT NULL column without a default
 * is synthesized; `extra` (column -> SQL expression) wins over the synthesized value. Must run under
 * session_replication_role = replica (FKs and user triggers are then skipped) -- the caller sets it.
 */
export async function insertSynth(q: Q, table: string, orgId: string, extra: Record<string, string> = {}): Promise<string> {
  const cols = await columnsOf(q, table);
  const names: string[] = [];
  const exprs: string[] = [];
  for (const c of cols) {
    if (c.generated || c.identity) continue;
    if (c.name === 'org_id') {
      names.push('org_id');
      exprs.push(q1(orgId) + '::uuid');
      continue;
    }
    if (extra[c.name] !== undefined) {
      names.push(c.name);
      exprs.push(extra[c.name]!);
      continue;
    }
    if (c.notnull && !c.hasDefault) {
      names.push(c.name);
      exprs.push(literalFor(table, c));
    }
  }
  const hasId = cols.some((c) => c.name === 'id');
  const stmt = `insert into "${table}" (${names.map((n) => `"${n}"`).join(', ')}) values (${exprs.join(', ')}) returning ${hasId ? 'id::text' : 'null'} as id`;
  const rows = await q.unsafe<{ id: string }[]>(stmt);
  return rows[0]!.id;
}

/** Is `col` of `table` nullable? */
export async function isNullable(q: Q, table: string, col: string): Promise<boolean> {
  const cols = await columnsOf(q, table);
  const c = cols.find((x) => x.name === col);
  if (!c) throw new Error(`fixture: ${table}.${col} does not exist`);
  return !c.notnull;
}

export async function insertOrg(q: Q, hint: string): Promise<string> {
  const code = `t398s3-${hint}-${Date.now()}-${++counter}`;
  const [o] = await q<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return o!.id;
}

// -------------------------------------------------------------------------------------------------
// The scratch database
// -------------------------------------------------------------------------------------------------

export const MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');

export function dbUrl(baseUrl: string, db: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

export async function withAdmin<T>(baseUrl: string, fn: (a: postgres.Sql) => Promise<T>): Promise<T> {
  const a = postgres(dbUrl(baseUrl, 'postgres'), { max: 1 });
  try {
    return await fn(a);
  } finally {
    await a.end();
  }
}

export async function dropDb(baseUrl: string, name: string): Promise<void> {
  try {
    await withAdmin(baseUrl, (a) => a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  } catch (e) {
    if (!/does not exist|being accessed/i.test((e as Error).message)) throw e;
  }
}

/**
 * Create `name` (must contain "_test"), migrate it to head, then remove every CHECK constraint and disable
 * every user trigger on every ordinary table, so synthesized rows are accepted and only foreign keys can
 * refuse a write. Returns an open connection pool.
 */
export async function buildScratchAtHead(baseUrl: string, name: string): Promise<postgres.Sql> {
  if (!/_test/.test(name)) throw new Error(`scratch database name must contain "_test": ${name}`);
  await dropDb(baseUrl, name);
  await withAdmin(baseUrl, (a) => a.unsafe(`CREATE DATABASE "${name}"`));
  const s = postgres(dbUrl(baseUrl, name), { max: 4 });
  await migrate(drizzle(s), { migrationsFolder: MIGRATIONS_FOLDER });
  const checks = await s<{ t: string; c: string }[]>`
    select c.relname as t, con.conname as c from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    where con.contype = 'c' and c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relispartition`;
  for (const k of checks) await s.unsafe(`alter table "${k.t}" drop constraint "${k.c}"`);
  const tables = await s<{ t: string }[]>`
    select c.relname as t from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relispartition
      and exists (select 1 from pg_trigger g where g.tgrelid = c.oid and not g.tgisinternal)`;
  for (const t of tables) await s.unsafe(`alter table "${t.t}" disable trigger user`);
  // Append-only tables give the app role INSERT but not UPDATE, so an UPDATE leg would stop at 42501 before
  // the foreign key is consulted. The scratch database is disposable: grant UPDATE so the leg reaches the FK
  // (row-level security still applies to the app role, so the org A / org B visibility rules are unchanged).
  await s.unsafe(`grant update on all tables in schema public to shareat_app`);
  return s;
}

/**
 * Like insertSynth, but every NOT NULL single-column FK column (other than org_id) gets a REAL parent row in
 * the same org, built recursively (depth-limited), so a validated FK -- including a composite one -- accepts
 * the row. Needed where a migration will validate the row (M2); the F legs deliberately use dangling values.
 */
export async function insertSynthResolved(q: Q, table: string, orgId: string, extra: Record<string, string> = {}, depth = 0): Promise<string> {
  const fks = await q<{ col: string; parent: string; nn: boolean }[]>`
    select a.attname as col, pr.relname as parent, a.attnotnull as nn
    from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    join pg_class pr on pr.oid = con.confrelid
    where con.contype = 'f' and con.conrelid = ${table}::regclass and cardinality(con.conkey) = 1
      and a.attname <> 'org_id' and pr.relname <> 'organizations' and pr.relname <> ${table}`;
  const resolved: Record<string, string> = { ...extra };
  if (depth < 4) {
    for (const f of fks) {
      if (!f.nn || resolved[f.col] !== undefined) continue;
      const parentId = await insertSynthResolved(q, f.parent, orgId, {}, depth + 1);
      resolved[f.col] = `'${parentId}'::uuid`;
    }
  }
  return insertSynth(q, table, orgId, resolved);
}
