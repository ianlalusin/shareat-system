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

  it('`idx` is contiguous from 0', () => {
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
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
