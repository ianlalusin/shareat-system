import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-327 test 2 — docs/tasks/327-a-poison-value-that-passes-every-guard.md §Tests item 2.
 *
 * The anti-rot test: SCHEMA COVERAGE, not a value scan. The column list is derived at runtime —
 * nothing here is a literal count (⛔ spec's own correction: the first draft of this spec said 172,
 * which was 160 real base-table columns plus 12 unrelated `pgView` column descriptors that
 * happened to share a count; Postgres cannot put a CHECK on a view at all, so those 12 must never
 * appear in the derived list, and this query excludes them structurally — `relkind = 'r'` — rather
 * than by any number).
 *
 * ⛔ BOTH HALVES READ `pg_catalog`, NEVER `information_schema` — orchestrator, 2026-09-19.
 * `information_schema` views are PRIVILEGE-FILTERED by definition: they show only what the
 * connected role holds some privilege on. `pg_catalog` is not. A population sourced from
 * `information_schema.columns` can silently SHRINK the day a table's grants don't cover this
 * suite's role — its numeric columns stop being candidates for `missing` at all, `missing` stays
 * `[]`, and the test is green while unguarded columns exist. Harmless today (`TEST_DATABASE_URL`
 * connects as `postgres`), which is exactly why it would go unnoticed until read a year from now
 * against a role that isn't. The population query below reads `pg_attribute`/`pg_class`/
 * `pg_namespace` directly — the same catalog family the coverage half already uses — so both
 * halves share one visibility rule.
 *
 * ⛔ COVERAGE IS BOUND BY SHAPE, NOT BY A RECONSTRUCTED NAME — orchestrator, 2026-09-19, measured
 * live: `store_attendance_config_holiday_special_non_working_multiplier_finite_check` (75 bytes)
 * and its `_working_` sibling (71 bytes) both exceed Postgres's silent 63-byte identifier limit.
 * The builder shortens the MIDDLE of those two names so `_finite_check` survives truncation —
 * which means the actual constraint name for those two columns is NOT
 * `<table>_<column>_finite_check`, and a test that rebuilds that exact string would go red on two
 * correct constraints, in a file the builder may never touch to work around. This repo's own
 * lesson (a census bound by one spelling missed 21 of 56 files, and a second and third spelling
 * were each invisible to the ones before them) applies to a constraint name exactly as it applies
 * to a file path: bind to what the constraint COVERS (`pg_constraint.conkey`, translated through
 * `pg_attribute` to real column names) plus what its name ENDS WITH, never to a name rebuilt from
 * the table/column strings. That survives a shortened middle, survives a column rename, and still
 * fails exactly when it should — the day migration `0156` adds an unguarded column.
 *
 * RED now: no `_finite_check` constraint exists anywhere, so `missing` below is the whole derived
 * column list. Green only once migration `0155` covers every one of them with a CHECK whose name
 * ends `_finite_check`. This is also what fails the day a future migration adds an unguarded
 * numeric column — a freshly migrated, empty database cannot hide that the way a value scan would.
 *
 * ⛔ THE PREDICATE, not only the name — orchestrator, 2026-09-19. The suffix is now load-bearing in
 * THREE places: this test's own coverage filter, `constraint-messages.ts`'s suffix rule (the
 * operator sentence), and `recordIfUnmappedConstraint`'s `mappedMessage` check (whether a refusal
 * is even recorded). A migration that copy-pastes a `_finite_check`-named constraint with the WRONG
 * body — `CHECK (col >= 0)`, say — passes the name-and-coverage test above, lets `NaN` through
 * (`NaN >= 0` is `true` in Postgres, the identical fact P1 measured), renders the wrong sentence,
 * and never reaches the register that would have surfaced it. All silent, together, on a name
 * match alone. So this file also reads `pg_get_constraintdef(con.oid)` and asserts its SHAPE —
 * normalised whitespace, the real column identifier substituted in from each row's own data, never
 * a table of 160 hard-coded strings — matches the finite-range form the contract specifies.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

const sql = postgres(url, { max: 5 });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-327 test 2 — every base-table numeric column carries a _finite_check', () => {
  it('⛔ every numeric column on a base table is COVERED by a check constraint whose name ends _finite_check', async () => {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      select cl.relname as table_name, a.attname as column_name
      from pg_attribute a
      join pg_class cl on cl.oid = a.attrelid
      join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public'
        and cl.relkind = 'r'
        and a.atttypid = 'numeric'::regtype
        and a.attnum > 0
        and not a.attisdropped`;

    // DEF-179's own trap, named in scripts/money-positivity-census.ts: a scan of nothing passes
    // silently unless something says so. This is a floor on the DERIVATION working at all — never
    // a count of what it is supposed to find.
    expect(columns.length).toBeGreaterThan(0);

    // ⛔ SHAPE, not a rebuilt name: `conkey` holds the attnums each CHECK constraint actually
    // covers, translated back to real column names via pg_attribute — never assembled from the
    // table/column strings, so a name Postgres had to shorten (identifiers cap at 63 bytes) is
    // matched the same as any other.
    const checks = await sql<
      { table_name: string; constraint_name: string; column_name: string; definition: string }[]
    >`
      select cls.relname as table_name, con.conname as constraint_name, att.attname as column_name,
             pg_get_constraintdef(con.oid) as definition
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace ns on ns.oid = cls.relnamespace
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
      where ns.nspname = 'public' and con.contype = 'c'`;

    const finiteChecks = checks.filter((c) => c.constraint_name.endsWith('_finite_check'));

    // ⚠️ Kept as a PAIR deliberately: "covers this column" ALONE would be green today, before 0155
    // exists — most of these columns already carry a `> 0` or range CHECK for an unrelated reason.
    // "Name ends _finite_check" ALONE is back to a spelling bet. Both together is what stays true
    // and stays falsifiable.
    const finiteGuarded = new Set(finiteChecks.map((c) => `${c.table_name}.${c.column_name}`));

    const missing = columns
      .map((col) => `${col.table_name}.${col.column_name}`)
      .filter((key) => !finiteGuarded.has(key));

    expect(missing).toEqual([]);

    // ⛔ THE PREDICATE, not only the name — see the header. The expected string is built from each
    // row's OWN column name, never a literal table of 160 names, so a copy-pasted wrong body is
    // what this catches and a legitimate rename or a new column changes nothing about the check.
    const wrongShape = finiteChecks
      .filter((c) => {
        const normalised = c.definition.replace(/\s+/g, ' ').trim();
        const expected = `CHECK (((${c.column_name} > '-Infinity'::numeric) AND (${c.column_name} < 'Infinity'::numeric)))`;
        return normalised !== expected;
      })
      .map((c) => `${c.table_name}.${c.constraint_name}: ${c.definition}`);

    expect(wrongShape).toEqual([]);
  });
});
