import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm run db:generate` is RETIRED — docs/decisions/ADR-012-hand-authored-migrations.md, DEF-242.
 *
 * Why this is a test and not a comment: DEF-073 (2026-08-27), DEF-121 (2026-09-01) and DEF-242
 * (2026-09-09) are the SAME discovery made three times, because nothing in the tree told the next
 * person. drizzle-kit generate cannot serve this repository's journal — it stamps `when` with the
 * wall clock while `migration-journal.test.ts` (DEF-039, DEF-091) keeps the head on a
 * one-day-per-index grid months ahead of it, so a generated entry would be silently skipped by
 * the migrator. If somebody "fixes" the script back to `drizzle-kit generate`, this fails and
 * points at the ADR rather than letting the trap reload quietly.
 *
 * Proven red-first: pointing the script back at `drizzle-kit generate` fails the first case.
 */
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const journalPath = join(root, 'migrations', 'meta', '_journal.json');

describe('db:generate is retired (ADR-012, DEF-242)', () => {
  it('the script never invokes drizzle-kit generate', () => {
    expect(pkg.scripts['db:generate']).toBeDefined();
    expect(pkg.scripts['db:generate']).not.toMatch(/drizzle-kit\s+generate/);
    expect(pkg.scripts['db:generate']).toMatch(/generate-retired\.ts/);
  });

  it('running it fails closed, writes nothing to the journal, and points at the ADR', () => {
    const journalBefore = readFileSync(journalPath, 'utf8');
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const r = spawnSync(process.execPath, [tsxCli, 'generate-retired.ts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ADR-012-hand-authored-migrations.md');
    expect(r.stderr).toContain('HAND-AUTHORED');
    expect(readFileSync(journalPath, 'utf8')).toBe(journalBefore);
  });
});
