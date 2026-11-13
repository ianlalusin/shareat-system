import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DEF-814 — an inline `url.replace(/:\/\/[^@]*@/, '://***@')` stops at the FIRST `@`, so a password
 * containing `@` leaks its tail into test output. Every test file must redact through the shared
 * `redactDbUrl` (tests/helpers/redact-db-url.ts) instead. This guard fails on any tracked .ts file
 * that still carries the broken regex.
 */

const repoRoot = path.resolve(__dirname, '../..');

/** The needle is assembled from two pieces so this file never contains it literally. */
const BROKEN = '[^@]' + '*@';

/** Files allowed to mention the pattern, each with its reason. */
const ALLOWED: Record<string, string> = {
  'tests/helpers/redact-db-url.ts': 'the helper itself; its doc comment quotes the old regex',
  'tests/unit/def814-redact-db-url.test.ts': 'shows the old regex on purpose, to prove the helper fixes it',
  'tests/unit/def814-no-inline-redact.test.ts': 'this guard',
  'tests/unit/t547-t512-guard.test.ts':
    'T-547 guard; its comment and assertion name the pattern so it can check t512 does not carry it',
};

/** Tracked files only, via `git ls-files`, never a directory walk (same technique as client-bundle-boundary.test.ts). */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f.endsWith('.ts'));
}

describe('DEF-814 — no inline DB-URL redaction that stops at the first @', () => {
  it('every .ts file uses redactDbUrl, not the first-@ regex', () => {
    const offenders = trackedFiles().filter((rel) => {
      if (rel in ALLOWED) return false;
      return readFileSync(path.join(repoRoot, rel), 'utf8').includes(BROKEN);
    });
    expect(offenders).toEqual([]);
  }, 60_000);
});
