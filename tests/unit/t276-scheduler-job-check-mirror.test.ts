/**
 * T-276 / DEF-305 — `docs/tasks/276-def-305-fiscal-period-coverage.md` §3 T2.
 *
 * DEF-217's shape, generalised into a standing guard: the schema's `scheduler_runs_job_check` CHECK
 * sql and the LAST journal-order migration that widens the real constraint must both name exactly
 * `SCHEDULER_JOBS` — no more, no less, and never just "the two agree with each other" (they could
 * both drift the same way and this would still pass; comparing each independently against the
 * imported constant is what catches that).
 *
 * ✅ Green since T-276 widened `SCHEDULER_JOBS`, the schema CHECK sql and the migration together:
 * `SCHEDULER_JOBS` has 11 members, and both the schema and migration extraction return 11 names.
 * Stale RED header corrected 2026-09-25 (T-344/DEF-422, tester).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULER_JOBS } from '@shareat/db';

const repoRoot = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(repoRoot, 'packages', 'db', 'migrations');
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');

/** Every single-quoted identifier inside a `CHECK (... IN (...))`-shaped string. */
function extractNames(sql: string): string[] {
  return [...sql.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
}

/** The schema's own `scheduler_runs_job_check` CHECK sql — the tagged-template argument that
 *  follows the constraint's name string, up to its closing backtick.
 *
 *  ⭐ Audit follow-up (2026-09-25): takes `src` as a parameter, rather than closing over the real
 *  file path, so the NEGATIVE test below can point this SAME parsing logic at a fixture — proving
 *  the parser itself catches a dropped name, not just that `Array` methods work on a literal. */
function namesFromSchemaSrc(src: string): string[] {
  const nameIdx = src.indexOf("'scheduler_runs_job_check'");
  expect(nameIdx, 'scheduler_runs_job_check not found — scan is vacuous').toBeGreaterThan(-1);
  // ⛔ NOT the first backtick after the name — the doc comment between the constraint's name and
  // its `sql` template is full of markdown code-spans (`` `SCHEDULER_JOBS` `` etc.), each its own
  // backtick pair, and the first one of those looks identical to a template start until you check
  // WHAT precedes it. Anchor on the literal `sql\`` tag instead.
  const tagIdx = src.indexOf('sql`', nameIdx);
  expect(tagIdx, "no sql`...` tagged template found after the constraint name — scan is vacuous").toBeGreaterThan(-1);
  const backtickStart = tagIdx + 'sql'.length;
  const backtickEnd = src.indexOf('`', backtickStart + 1);
  return extractNames(src.slice(backtickStart, backtickEnd));
}

function namesFromSchema(): string[] {
  return namesFromSchemaSrc(readFileSync(path.join(repoRoot, 'packages/db/schema/scheduler.ts'), 'utf8'));
}

/** Tags in JOURNAL ORDER (the array's own order, which drizzle applies migrations in), filtered to
 *  those whose `.sql` file actually ADDS the real constraint, then the LAST (most recent) one — so
 *  this test automatically follows the constraint to wherever it was most recently widened, rather
 *  than a hardcoded migration number that would silently stop being "the last one" the next time
 *  someone widens it again. */
/** ⭐ Audit follow-up (2026-09-25): the actual CHECK-sql extraction is split out to `src`, same
 *  reason as `namesFromSchemaSrc` above — so the NEGATIVE test exercises this parser directly. */
function namesFromMigrationSrc(src: string): string[] {
  const addIdx = src.indexOf('ADD CONSTRAINT "scheduler_runs_job_check"');
  expect(addIdx, 'ADD CONSTRAINT "scheduler_runs_job_check" not found — scan is vacuous').toBeGreaterThan(-1);
  const checkIdx = src.indexOf('CHECK (', addIdx);
  const stmtEnd = src.indexOf(';', checkIdx);
  return extractNames(src.slice(checkIdx, stmtEnd));
}

function lastMigrationWideningJobCheck(): { tag: string; names: string[] } {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as { entries: { tag: string }[] };
  const candidates = journal.entries
    .map((e) => e.tag)
    .filter((tag) => {
      const file = path.join(MIGRATIONS_DIR, `${tag}.sql`);
      try {
        return readFileSync(file, 'utf8').includes('ADD CONSTRAINT "scheduler_runs_job_check"');
      } catch {
        return false;
      }
    });
  expect(candidates.length, 'no migration widens scheduler_runs_job_check — scan is vacuous').toBeGreaterThan(0);
  const tag = candidates.at(-1)!;
  const src = readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
  return { tag, names: namesFromMigrationSrc(src) };
}

describe('T2 — the schema CHECK sql and the last widening migration both mirror SCHEDULER_JOBS exactly', () => {
  it('⭐ finds SCHEDULER_JOBS, the schema file and the migrations dir at all (a scan of nothing must not pass)', () => {
    expect(SCHEDULER_JOBS.length).toBeGreaterThan(0);
    expect(readdirSync(MIGRATIONS_DIR).length).toBeGreaterThan(50);
  });

  it('the schema CHECK sql names exactly SCHEDULER_JOBS, sorted, and includes fiscal_period_seed', () => {
    const names = namesFromSchema();
    expect(names.length).toBeGreaterThanOrEqual(11);
    expect(names).toContain('fiscal_period_seed');
    expect([...names].sort()).toEqual([...SCHEDULER_JOBS].sort());
  });

  it('the LAST journal-order migration widening the constraint names exactly SCHEDULER_JOBS, sorted, and includes fiscal_period_seed', () => {
    const { names } = lastMigrationWideningJobCheck();
    expect(names.length).toBeGreaterThanOrEqual(11);
    expect(names).toContain('fiscal_period_seed');
    expect([...names].sort()).toEqual([...SCHEDULER_JOBS].sort());
  });

  it('NEGATIVE: the REAL parsers (not just Array.slice) catch a fixture with one name dropped', () => {
    // ⭐ Audit follow-up (2026-09-25): runs namesFromSchemaSrc/namesFromMigrationSrc themselves
    // against fixture source text with one job name removed — the original version of this test
    // only proved `[...x].slice(1)` differs from `x`, which says nothing about whether the actual
    // schema/migration parsers would notice a real drift.
    const fullSchemaSrc = [
      "check(",
      "  'scheduler_runs_job_check',",
      "  sql`${t.job} in ('a', 'b', 'c')`,",
      "),",
    ].join('\n');
    const droppedSchemaSrc = fullSchemaSrc.replace("'a', 'b', 'c'", "'a', 'b'");
    expect(namesFromSchemaSrc(fullSchemaSrc)).toEqual(['a', 'b', 'c']);
    expect(namesFromSchemaSrc(droppedSchemaSrc)).not.toEqual(namesFromSchemaSrc(fullSchemaSrc));
    expect(namesFromSchemaSrc(droppedSchemaSrc).sort()).not.toEqual([...SCHEDULER_JOBS].sort());

    const fullMigrationSrc =
      'ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"\n' +
      "\tCHECK (\"job\" IN ('a', 'b', 'c'));";
    const droppedMigrationSrc = fullMigrationSrc.replace("'a', 'b', 'c'", "'a', 'b'");
    expect(namesFromMigrationSrc(fullMigrationSrc)).toEqual(['a', 'b', 'c']);
    expect(namesFromMigrationSrc(droppedMigrationSrc)).not.toEqual(namesFromMigrationSrc(fullMigrationSrc));
    expect(namesFromMigrationSrc(droppedMigrationSrc).sort()).not.toEqual([...SCHEDULER_JOBS].sort());
  });
});
