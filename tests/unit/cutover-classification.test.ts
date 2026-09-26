import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../packages/db/schema';
import {
  CUTOVER_CLASSIFICATION,
  NON_TABLE_RELATIONS,
  PURGE_ORDER_HINT,
  type CutoverEntry,
} from '../../packages/db/src/cutover/classification';

/**
 * ADR-007 §4 — classification is MANDATORY, and this test is the enforcement.
 *
 * **The measure of T-119's success is a build failure**, not this file passing. If someone
 * adds a table next month and CI does not stop them until they have answered "does this
 * survive the cutover?", the design did not work however green everything looks.
 *
 * A unit test on purpose: it must fail on a laptop the moment the schema changes, not the
 * moment a database happens to be available.
 *
 * Tables are enumerated from the DRIZZLE SCHEMA rather than from a hand-written list — the
 * schema is the source, so a table cannot exist without appearing here. A hand-list would
 * rot in exactly the way the classification itself is designed not to.
 */

function schemaTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) names.push(getTableName(value));
  }
  return [...new Set(names)].sort();
}

/** Column names as the DATABASE knows them, for verifying clearColumns / dateColumn. */
function schemaColumnNames(table: string): string[] {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable) && getTableName(value) === table) {
      // `getTableColumns` is Drizzle's PUBLIC accessor. Reaching into `_.columns` works
      // until a minor version moves it, and would then fail as "column does not exist" —
      // a guard reporting a false problem is worse than no guard.
      return Object.values(getTableColumns(value)).map((c) => c.name);
    }
  }
  return [];
}

describe('cutover classification — every table declares whether it survives', () => {
  it('enumerates tables from the schema itself, not a hand-written list', () => {
    const tables = schemaTableNames();
    // A sanity floor: if this ever returns nothing, the enumeration broke and every
    // assertion below would pass vacuously — which is the failure mode a coverage guard
    // must never have.
    expect(tables.length).toBeGreaterThan(5);
    expect(tables).toContain('journal_lines');
  });

  it('EVERY schema table is classified — an unlisted table fails the build', () => {
    const unclassified = schemaTableNames().filter((t) => !(t in CUTOVER_CLASSIFICATION));
    expect(
      unclassified,
      unclassified.length === 0
        ? ''
        : `These tables have no cutover classification:\n  ${unclassified.join('\n  ')}\n\n` +
            'Every table must declare whether it survives the 1 January 2027 cutover. Add an ' +
            'entry to packages/db/src/cutover/classification.ts with a REASON in prose:\n' +
            "  keep       — configuration and base data, untouched\n" +
            "  purge      — operational/financial, every row deleted\n" +
            "  keep_shell — row survives, named financial columns cleared\n" +
            "  date_scoped— rows split by date\n\n" +
            'There is deliberately no default: a default would be a decision made by whoever ' +
            'wrote it, for data they have never seen. See ADR-007 §4.',
    ).toEqual([]);
  });

  it('every classification refers to a table that actually exists', () => {
    const known = new Set(schemaTableNames());
    const stale = Object.keys(CUTOVER_CLASSIFICATION).filter((t) => !known.has(t));
    expect(
      stale,
      `Classified but not in the schema (dropped table, or a typo): ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('every entry carries a non-empty reason', () => {
    const missing = Object.entries(CUTOVER_CLASSIFICATION)
      .filter(([, e]) => !e.reason || e.reason.trim().length < 10)
      .map(([t]) => t);
    expect(
      missing,
      `No usable reason: ${missing.join(', ')}. In December the reader is not the author.`,
    ).toEqual([]);
  });

  it('every keep_shell entry names columns, and each column exists on that table', () => {
    const problems: string[] = [];
    for (const [table, entry] of Object.entries(CUTOVER_CLASSIFICATION)) {
      if (entry.class !== 'keep_shell') continue;
      if (entry.clearColumns.length === 0) {
        problems.push(`${table}: keep_shell with no clearColumns — that is just "keep"`);
        continue;
      }
      const cols = new Set(schemaColumnNames(table));
      for (const c of entry.clearColumns) {
        if (!cols.has(c)) problems.push(`${table}.${c} does not exist`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every date_scoped entry names a real date column and a valid keepFrom', () => {
    const problems: string[] = [];
    for (const [table, entry] of Object.entries(CUTOVER_CLASSIFICATION)) {
      if (entry.class !== 'date_scoped') continue;
      if (!schemaColumnNames(table).includes(entry.dateColumn)) {
        problems.push(`${table}.${entry.dateColumn} does not exist`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.keepFrom)) {
        problems.push(`${table}: keepFrom "${entry.keepFrom}" is not YYYY-MM-DD`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the ETL tables carry notBefore — they are evidence, and must survive 1 January', () => {
    // ADR-007 §6. Purging them on the cutover date destroys the ability to answer "where did
    // this figure come from?" during the exact month that question is asked.
    for (const t of ['etl_source_documents', 'etl_runs', 'etl_quarantine', 'etl_reconciliation']) {
      const entry = CUTOVER_CLASSIFICATION[t] as CutoverEntry | undefined;
      expect(entry, `${t} must be classified`).toBeDefined();
      expect(entry!.class).toBe('purge');
      expect(
        (entry as { notBefore?: string }).notBefore,
        `${t} must carry notBefore — it is the evidence behind the opening balance`,
      ).toBe('2027-01-31');
    }
  });

  it('the purge-order hint lists only purge-class tables, children first', () => {
    for (const t of PURGE_ORDER_HINT) {
      expect(CUTOVER_CLASSIFICATION[t]?.class, `${t} in purge order but not purge-class`).toBe('purge');
    }
    // journal_lines before journal_entries, or the FK trips.
    expect(PURGE_ORDER_HINT.indexOf('journal_lines')).toBeLessThan(
      PURGE_ORDER_HINT.indexOf('journal_entries'),
    );
  });

  it('views are never treated as tables', () => {
    const tables = new Set(schemaTableNames());
    for (const v of NON_TABLE_RELATIONS) {
      expect(tables.has(v), `${v} is a view and must not be enumerated as a table`).toBe(false);
      expect(v in CUTOVER_CLASSIFICATION, `${v} is a view — it holds no rows to purge`).toBe(false);
    }
  });
});

/**
 * T-347 U1 — `docs/tasks/347-def-437-cutover-purge-assets.md` §4 (case U1), §3.2.
 *
 * `KeepShellEntry` gains two optional fields the purge engine's shell step needs:
 * `set?: Record<string, string | boolean>` (columns the shell step writes a fixed value into,
 * rather than nulling) and `dropWhere?: { column: string; in: readonly string[] }` (rows deleted
 * outright rather than shelled — `fixed_assets`'s disposed rows).
 *
 * ⛔ RED on current `main` (property unknown): `KeepShellEntry` does not declare `set` or
 * `dropWhere` yet, so narrowing to `entry.class === 'keep_shell'` and reading `entry.set` /
 * `entry.dropWhere` below fails `tsc` — "Property 'set' does not exist on type 'KeepShellEntry'".
 * This is a TYPECHECK red, not a vitest runtime red: the project's vitest transform does not
 * type-check, so `npm run test` alone would let `entry.set` evaluate to `undefined` at runtime
 * and these assertions would fail on their VALUES instead (also red, but for a different, weaker
 * reason) — `npm run typecheck` is what proves "property unknown" precisely.
 */
describe('T-347 U1 — keep_shell set/dropWhere columns are well-formed (R1.5)', () => {
  it('every `set` column exists on its table and is never also in clearColumns', () => {
    const problems: string[] = [];
    for (const [table, entry] of Object.entries(CUTOVER_CLASSIFICATION)) {
      if (entry.class !== 'keep_shell') continue;
      const set = entry.set;
      if (!set) continue;
      const cols = new Set(schemaColumnNames(table));
      for (const col of Object.keys(set)) {
        if (!cols.has(col)) problems.push(`${table}.${col} (set) does not exist`);
        if (entry.clearColumns.includes(col)) problems.push(`${table}.${col} is in both set and clearColumns`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every `dropWhere` column exists on its table', () => {
    const problems: string[] = [];
    for (const [table, entry] of Object.entries(CUTOVER_CLASSIFICATION)) {
      if (entry.class !== 'keep_shell') continue;
      const dropWhere = entry.dropWhere;
      if (!dropWhere) continue;
      const cols = new Set(schemaColumnNames(table));
      if (!cols.has(dropWhere.column)) problems.push(`${table}.${dropWhere.column} (dropWhere) does not exist`);
    }
    expect(problems).toEqual([]);
  });

  it('fixed_assets.clearColumns contains in_service_on and in_service_source (R1.5)', () => {
    const entry = CUTOVER_CLASSIFICATION['fixed_assets'];
    expect(entry?.class).toBe('keep_shell');
    if (entry?.class === 'keep_shell') {
      expect(entry.clearColumns).toContain('in_service_on');
      expect(entry.clearColumns).toContain('in_service_source');
    }
  });

  it('fixed_assets carries a dropWhere for disposed shells, and a set reclassifying the survivor to pending_valuation (§3.2)', () => {
    const entry = CUTOVER_CLASSIFICATION['fixed_assets'];
    expect(entry?.class).toBe('keep_shell');
    if (entry?.class === 'keep_shell') {
      expect(entry.dropWhere).toEqual({ column: 'status', in: ['disposed'] });
      expect(entry.set).toEqual({ status: 'pending_valuation', needs_review: false });
    }
  });
});
