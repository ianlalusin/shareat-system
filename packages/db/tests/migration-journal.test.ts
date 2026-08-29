import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drizzle's migrator applies a migration only when
 *   lastAppliedMigration.created_at < thisMigration.when
 * where `when` comes from `meta/_journal.json`. If a new migration is generated with a
 * `when` LOWER than an already-applied one, the migrator **silently skips it** — no error,
 * no warning, exit code 0. The schema is simply missing and nothing says so.
 *
 * That happened on 2026-08-23: migrations 0005 and 0006 were hand-given round, future-looking
 * `when` values, and `drizzle-kit generate` then stamped 0007 with a real timestamp that was
 * NUMERICALLY SMALLER. 0007 was skipped on both databases. It surfaced only because unrelated
 * tests failed with "column does not exist".
 *
 * A migration that silently does not apply is the purest form of the silent failure this
 * project exists to eliminate — so it is now a test, not a memory. Bible §12.
 */

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const journalPath = join(root, 'migrations', 'meta', '_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe('migration journal', () => {
  it('has entries', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it('`when` is strictly ascending — a lower value is SILENTLY SKIPPED by the migrator', () => {
    const offenders: string[] = [];
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const cur = journal.entries[i]!;
      if (cur.when <= prev.when) {
        offenders.push(
          `${cur.tag} (when=${cur.when}) is not after ${prev.tag} (when=${prev.when}) — it will NEVER be applied`,
        );
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /**
   * ⭐ Relaxed from "contiguous from 0" to "strictly increasing and unique" — T-154, 2026-08-29.
   *
   * Parallel lanes RESERVE migration number blocks so two sessions never collide on one number or
   * on `meta/_journal.json` (bible §3.4: *"Disjoint files are not enough — check shared STATE
   * too"*). Phase 4's lane owns 0070-0089 while the accounting lane holds 0060-0069, so a gap in
   * `idx` is produced BY the scheme, on purpose, and contiguity cannot hold while both lanes are
   * in flight. It closes again when they merge.
   *
   * ⚠️ **Nothing is lost by dropping the no-gaps clause.** What contiguity actually protected was
   * "a migration went missing", and that is covered completely — and better — by the next test,
   * which compares journalled tags against the `.sql` files on disk in BOTH directions. A gap with
   * no missing file is a reservation; a missing file is caught either way.
   *
   * What is KEPT is the ordering property, because it is the one Drizzle cares about: `idx` must
   * still march strictly forward, so a duplicated or out-of-order row still fails here.
   *
   * Verified rather than assumed: migration 0070 applied cleanly to a freshly created empty
   * database with `idx` jumping 59 -> 70. Drizzle's migrator reads `entries` in array order and
   * gates on `when`, not on `idx` being dense.
   */
  it('`idx` is strictly increasing and unique — a reserved-block gap is legitimate', () => {
    const offenders: string[] = [];
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const cur = journal.entries[i]!;
      if (cur.idx <= prev.idx) {
        offenders.push(`${cur.tag} (idx=${cur.idx}) does not come after ${prev.tag} (idx=${prev.idx})`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
    expect(journal.entries[0]!.idx).toBe(0);
  });

  it('every journalled tag has a matching .sql file, and vice versa', () => {
    const onDisk = readdirSync(join(root, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    const journalled = journal.entries.map((e) => e.tag).sort();
    expect(journalled).toEqual(onDisk);
  });
});
