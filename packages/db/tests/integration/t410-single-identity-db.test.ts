/**
 * T-410 S1 (database half, R1-R3, R4, R5) - one person, one id (bible row 322), on the MIGRATED database.
 *
 * Migrations are hand-authored (ADR-012), so a table can exist only in SQL and never reach the Drizzle
 * schema. The unit half cannot see it; this half reads information_schema and pg_constraint.
 *
 * ⚠️ The rules below MIRROR the unit half (`packages/db/tests/unit/t410-single-identity.test.ts`):
 * the allowlist names, the identity pattern and the one-hop NOT NULL rule. A change to one must be made
 * to both. The unit half is the authority for the schema; this half is the authority for the live database.
 *
 * Everything runs inside transactions that are rolled back, so the shared test database is left as found.
 *
 * Mutants (temporary edit, reverted at once, shown red in the lane log):
 *   inv3  a `create table app_users` inside the test's own transaction, fed to the live check -> red with R5
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set (integration tests need a real, migrated database)');

const sql = postgres(url, { max: 1 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Db = postgres.Sql | postgres.TransactionSql;

interface LiveColumn {
  name: string;
  notNull: boolean;
}
interface LiveFk {
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
}
interface LiveTable {
  name: string;
  columns: LiveColumn[];
  fks: LiveFk[];
}

/** R1 - the allowlist, mirrored from the unit half. */
const ALLOWLIST: readonly string[] = [
  'persons',
  'person_identities',
  'person_credentials',
  'sessions',
  'attendance_credentials',
  'clock_terminals',
];
/** R3 exemptions, mirrored: persons is the target; clock_terminals is a device. */
const R3_EXEMPT: readonly string[] = ['persons', 'clock_terminals'];
/** R2 - empty today, mirrored from the unit half. */
const NOT_IDENTITY: readonly string[] = [];

const NAME_PATTERN = /(^|_)(users?|logins?|identit(y|ies)|credentials?|principals?|members?|auth)(_|$)/;
const IDENTITY_COLUMNS: ReadonlySet<string> = new Set([
  'external_id', 'firebase_uid', 'uid', 'password', 'password_hash', 'pin_hash', 'secret_hash',
  'lookup_hash', 'token_hash', 'match_token', 'verifier',
]);

const r5 = (table: string): string =>
  `${table} looks like a second identity table. Bible row 322: one person, one id. ` +
  'Key it to persons.id and add it to the allowlist with a reason, or add it to NOT_IDENTITY with a reason.';

/** Reads the migrated `public` schema: base tables, their columns (nullability) and their foreign keys (pg_constraint). */
async function loadLive(db: Db): Promise<LiveTable[]> {
  const tables = await db<{ table_name: string }[]>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`;
  const columns = await db<{ table_name: string; column_name: string; is_nullable: string }[]>`
    select table_name, column_name, is_nullable from information_schema.columns
     where table_schema = 'public'`;
  const fks = await db<{ name: string; table_name: string; target_table: string; cols: string[]; target_cols: string[] }[]>`
    select c.conname as name, r.relname as table_name, f.relname as target_table,
           array_agg(a.attname::text order by k.ord) as cols,
           array_agg(fa.attname::text order by k.ord) as target_cols
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      join pg_class f on f.oid = c.confrelid
      cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(col, fcol, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.col
      join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = k.fcol
     where c.contype = 'f' and n.nspname = 'public'
     group by c.conname, r.relname, f.relname`;

  return tables.map((t) => ({
    name: t.table_name,
    columns: columns
      .filter((c) => c.table_name === t.table_name)
      .map((c) => ({ name: c.column_name, notNull: c.is_nullable === 'NO' })),
    fks: fks
      .filter((f) => f.table_name === t.table_name)
      .map((f) => ({ columns: f.cols, foreignTable: f.target_table, foreignColumns: f.target_cols })),
  }));
}

const identityLike = (t: LiveTable): boolean =>
  NAME_PATTERN.test(t.name) || t.columns.some((c) => IDENTITY_COLUMNS.has(c.name));

/** R2 + R5 on the live database: an unlisted identity-like table, including one that exists only in SQL. */
function unlistedLive(tables: LiveTable[]): string[] {
  return tables
    .filter((t) => !ALLOWLIST.includes(t.name) && !NOT_IDENTITY.includes(t.name))
    .filter(identityLike)
    .map((t) => r5(t.name));
}

/** Mirror of the unit half's SUBJECT map: only the subject column satisfies R3, never an audit column. */
const SUBJECT_COLUMN: ReadonlyMap<string, string> = new Map([
  ['person_identities', 'person_id'],
  ['person_credentials', 'person_id'],
  ['sessions', 'person_id'],
  ['attendance_credentials', 'employment_id'],
]);

/** The column is NOT NULL and a single-column foreign key to `target.id`. */
function colNotNullFkTo(t: LiveTable, col: string, target: string): boolean {
  const notNull = t.columns.find((c) => c.name === col)?.notNull === true;
  return (
    notNull &&
    t.fks.some((fk) => fk.columns.length === 1 && fk.columns[0] === col && fk.foreignTable === target && fk.foreignColumns.includes('id'))
  );
}

/** R1 + R3 on the live database: every allowlisted table exists and resolves to persons.id in one hop. */
function allowlistLive(tables: LiveTable[]): string[] {
  const out: string[] = [];
  const byName = new Map(tables.map((t) => [t.name, t] as const));
  for (const name of ALLOWLIST) {
    const t = byName.get(name);
    if (!t) {
      out.push(`${name} is on the identity allowlist but does not exist in the migrated database`);
      continue;
    }
    if (R3_EXEMPT.includes(name)) continue;
    const subject = SUBJECT_COLUMN.get(name);
    const employments = byName.get('employments');
    const resolves =
      subject !== undefined &&
      (colNotNullFkTo(t, subject, 'persons') ||
        (!!employments && colNotNullFkTo(t, subject, 'employments') && colNotNullFkTo(employments, 'person_id', 'persons')));
    if (!resolves) {
      out.push(`${name} does not resolve to persons.id through a NOT NULL foreign key (R3)`);
    }
  }
  return out;
}

class Rollback extends Error {}

/** Runs `fn` in a transaction that is always rolled back; returns what `fn` returned. */
async function inRolledBackTransaction<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await sql
    .begin(async (tx) => {
      result = await fn(tx);
      throw new Rollback('always roll back: the shared test database must be left as found');
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return result as T;
}

describe('T-410 S1 - one person, one id (database half)', () => {
  it('the live enumeration finds the migrated schema (floor, so the checks below cannot pass vacuously)', async () => {
    const tables = await loadLive(sql);
    expect(tables.length).toBeGreaterThanOrEqual(100);
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining([...ALLOWLIST]));
  });

  it('R1+R3 on the migrated database: every allowlisted table exists and resolves to persons.id', async () => {
    expect(allowlistLive(await loadLive(sql))).toEqual([]);
  });

  // Invariant 3 - the live half. Mutant: `create table app_users(id uuid)` inside this test's transaction, fed to the check.
  it('inv3: no unlisted identity-like table exists in the migrated database', async () => {
    expect(unlistedLive(await loadLive(sql))).toEqual([]);
  });

  it('inv3: an app_users table created only in SQL (rolled back) is reported with the R5 sentence', async () => {
    const seen = await inRolledBackTransaction(async (tx) => {
      await tx.unsafe('create table app_users (id uuid primary key)');
      return unlistedLive(await loadLive(tx));
    });
    expect(seen).toEqual([r5('app_users')]);
    expect(unlistedLive(await loadLive(sql)), 'the rolled-back table must be gone').toEqual([]);
  });

  it('R3 on the live database: a credential whose person_id is made nullable in SQL (rolled back) fails', async () => {
    const seen = await inRolledBackTransaction(async (tx) => {
      await tx.unsafe('alter table person_credentials alter column person_id drop not null');
      return allowlistLive(await loadLive(tx));
    });
    expect(seen).toEqual(['person_credentials does not resolve to persons.id through a NOT NULL foreign key (R3)']);
  });

  // Ruling: an audit column never satisfies R3. attendance_credentials keeps enrolled_by NOT NULL, so only
  // the subject link can fail here. Mutant: SUBJECT_COLUMN points attendance_credentials at enrolled_by -> green -> red.
  it('R3 on the live database: attendance_credentials with no subject link (enrolled_by alone) fails', async () => {
    const seen = await inRolledBackTransaction(async (tx) => {
      await tx.unsafe('alter table attendance_credentials alter column employment_id drop not null');
      return allowlistLive(await loadLive(tx));
    });
    expect(seen).toEqual(['attendance_credentials does not resolve to persons.id through a NOT NULL foreign key (R3)']);
  });
});
