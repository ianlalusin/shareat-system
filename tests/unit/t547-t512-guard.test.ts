/**
 * T-547 (DEF-816, DEF-817) — the duplicate-item-lines integration test must use the SHARED test-database
 * guard and the SHARED redaction helper.
 *
 * Its own copy used to (a) accept only a database literally named `shareat_test`, which fails on every
 * lane database (`shareat_t528_test`, …), and (b) redact with `/:\/\/[^@]*@/`, which stops at the FIRST
 * `@` — a local password containing `@` printed everything after it. `tests/integration/setup.ts` and
 * `tests/helpers/redact-db-url.ts` already hold the correct pair, so this guard pins that the file uses
 * them and keeps no copy of its own.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(
  here, '..', '..',
  'packages', 'domain', 'tests', 'integration', 't512-duplicate-item-lines.test.ts',
);
const source = readFileSync(target, 'utf8');

describe('T-547 — t512 uses the shared test-database guard', () => {
  it('accepts any _test database, not only "shareat_test"', () => {
    expect(source).toContain('isTestDatabaseUrl(url)');
    expect(source).not.toContain(String.raw`_test(\?|$)`);
  });

  it('imports the shared redactDbUrl helper and uses it in the refusal', () => {
    expect(source).toContain("from '../../../../tests/helpers/redact-db-url'");
    expect(source).toContain('redactDbUrl(url)');
  });

  it('keeps no inline redaction that stops at the first @', () => {
    expect(source).not.toContain('[^@]*@');
    expect(source).not.toContain("'://***@'");
  });
});
