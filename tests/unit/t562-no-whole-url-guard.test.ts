/**
 * T-562 section 6 (DEF-818 / GT-001) - no tracked source file may carry the old whole-URL test-database regex again.
 * A database is a test database only by its NAME: call isTestDatabaseUrl from scripts/lib/test-db-name.mjs instead.
 * Pure text scan over `git ls-files`; this file never connects to a database.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

// The old whole-URL regex body. Joined so this file does not contain it verbatim.
const OLD_REGEX_SOURCE = ['shareat_test', '|_test(\\?|$)'].join('');

const CODE_FILE = /\.(ts|tsx|mjs|js)$/;

// Files that quote the old regex on purpose, with the reason each is allowed.
const ALLOW_LIST: Record<string, string> = {
  'tests/helpers/redact-db-url.ts': 'doc comment quotes the old regex',
  'tests/unit/def814-redact-db-url.test.ts': 'shows the old regex on purpose',
  'tests/unit/t562-no-whole-url-guard.test.ts': 'this guard names the regex',
};

describe('T-562 no whole-URL test-database guard', () => {
  it('no tracked source file uses the whole-URL regex to decide test-ness', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    const files = tracked.filter((f) => CODE_FILE.test(f) && !(f in ALLOW_LIST));
    const offenders = files.filter((f) => readFileSync(path.join(ROOT, f), 'utf8').includes(OLD_REGEX_SOURCE));
    expect(
      offenders,
      'A database is a test database only by its NAME. Use isTestDatabaseUrl from scripts/lib/test-db-name.mjs (DEF-818 / GT-001), not a regex on the whole URL.',
    ).toEqual([]);
  });
});
