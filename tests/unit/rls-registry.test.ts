import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../packages/db/schema';
import { RLS_REGISTRY, tablesWithScope } from '../../packages/db/src/rls/registry';

/**
 * T-120 §5 — every table declares how it is org-scoped, and an unlisted one FAILS THE BUILD.
 *
 * Same shape and same reasoning as the cutover-classification guard: no default class,
 * because a default is a decision made by whoever wrote it for data they have never seen.
 * Here the stakes are higher — the wrong default leaks a tenant's books rather than losing
 * some configuration.
 *
 * A unit test on purpose: it must fail on a laptop the moment the schema changes, not the
 * moment a database happens to be available.
 */

function schemaTables(): { name: string; columns: string[] }[] {
  const out: { name: string; columns: string[] }[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    out.push({
      name: getTableName(value),
      columns: Object.values(getTableColumns(value)).map((c) => c.name),
    });
  }
  return out;
}

describe('RLS registry — every table declares its scoping', () => {
  it('the enumeration finds tables at all', () => {
    // Without this floor, a broken enumeration would make every assertion below pass
    // vacuously — the one failure mode a coverage guard must never have.
    const t = schemaTables();
    expect(t.length).toBeGreaterThan(5);
    expect(t.map((x) => x.name)).toContain('journal_lines');
  });

  it('EVERY schema table is in the RLS registry — an unlisted table fails the build', () => {
    const missing = schemaTables()
      .map((t) => t.name)
      .filter((t) => !(t in RLS_REGISTRY));
    expect(
      missing,
      missing.length === 0
        ? ''
        : `These tables declare no RLS scoping:\n  ${missing.join('\n  ')}\n\n` +
            'Add an entry to packages/db/src/rls/registry.ts:\n' +
            "  org_column  — the row carries org_id\n" +
            "  derived     — no org_id; scoped through a parent (give `via`)\n" +
            "  self        — the organizations table itself\n" +
            "  system_only — RLS on, NO policy; only the system principal can read it\n\n" +
            'AND add the matching policy in a migration. A registry entry without a policy is a ' +
            'promise, not a control. There is deliberately no default: the wrong default here ' +
            "leaks one tenant's books to another. See ADR-008 §9.",
    ).toEqual([]);
  });

  it('every registry entry names a table that exists', () => {
    const known = new Set(schemaTables().map((t) => t.name));
    const stale = Object.keys(RLS_REGISTRY).filter((t) => !known.has(t));
    expect(stale, `Registered but not in the schema: ${stale.join(', ')}`).toEqual([]);
  });

  it('every entry carries a usable reason', () => {
    const bad = Object.entries(RLS_REGISTRY)
      .filter(([, e]) => !e.reason || e.reason.trim().length < 10)
      .map(([t]) => t);
    expect(bad, `No usable reason: ${bad.join(', ')}`).toEqual([]);
  });

  it('every org_column table actually HAS an org_id column', () => {
    // A policy written against a column that does not exist fails at migration time; a
    // registry claiming a column that does not exist would mislead the next reader instead.
    const cols = new Map(schemaTables().map((t) => [t.name, new Set(t.columns)]));
    const problems = tablesWithScope('org_column').filter((t) => !cols.get(t)?.has('org_id'));
    expect(problems, `Declared org_column but has no org_id: ${problems.join(', ')}`).toEqual([]);
  });

  it('every derived table has NO org_id, and names how it is reached', () => {
    const cols = new Map(schemaTables().map((t) => [t.name, new Set(t.columns)]));
    for (const t of tablesWithScope('derived')) {
      expect(
        cols.get(t)?.has('org_id'),
        `${t} is declared derived but HAS an org_id — scope it directly, or the two can disagree`,
      ).toBe(false);
      expect(RLS_REGISTRY[t]!.via, `${t} is derived and must name its parent predicate`).toBeTruthy();
      expect(RLS_REGISTRY[t]!.via).toContain('app_current_org()');
    }
  });

  it('journal_lines is derived through its entry, never denormalised', () => {
    // The single most consequential scoping decision in the schema. A copied org_id could
    // drift from its parent, and a line whose org disagreed with its entry would be either
    // invisible or visible to the WRONG tenant.
    const e = RLS_REGISTRY['journal_lines'];
    expect(e?.scope).toBe('derived');
    expect(e?.via).toContain('journal_entries');
  });

  it('the ETL tables and audit_log are system_only — no tenant may read captured PII', () => {
    for (const t of ['etl_source_documents', 'etl_runs', 'etl_quarantine', 'etl_reconciliation', 'audit_log']) {
      expect(RLS_REGISTRY[t]?.scope, `${t} must be system_only`).toBe('system_only');
    }
  });
});
