/**
 * T-355 / DEF-489 — `docs/tasks/355-def-489-default-privileges-read-insert.md`, leg G1. Reads the
 * migration files only; no database.
 *
 * R5's re-widening guard: no migration numbered 0169 or later may re-widen the default privileges
 * (via `ALTER DEFAULT PRIVILEGES ... GRANT UPDATE|DELETE|ALL ... ON TABLES`) — this is the STATIC
 * half of the three-layer defence (D3 is the live half, 0169's own DO-block post-assertion is the
 * third).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = resolve(__dirname, '../migrations');

const WIDENING_RE = /ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bGRANT\b[^;]*\b(UPDATE|DELETE|ALL)\b[^;]*\bON\s+TABLES\b/i;

/**
 * Strips SQL `--` line comments and `/* *\/` block comments. A real tokenizer (code/single-quoted
 * string/line-comment/block-comment), not a `--`-onward regex eraser, so a token living only in a
 * comment is excluded and one inside a string literal (with `''`-escaped quotes) is kept — same
 * shape of idiom as `apps/erp/tests/t348-page-description.test.ts`'s `stripComments`, adapted for
 * SQL's `--`/`'...'` syntax instead of JS's `//`/`'...'`/`"..."`/`` `...` ``.
 */
function stripSqlComments(source: string): string {
  let result = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' = 'code';
  while (i < source.length) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    if (mode === 'line') {
      if (c === '\n') {
        result += c;
        mode = 'code';
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (two === '*/') {
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'single') {
      result += c;
      if (c === "'" && source[i + 1] === "'") {
        result += source[i + 1];
        i += 2;
        continue;
      }
      if (c === "'") mode = 'code';
      i += 1;
      continue;
    }
    if (two === '--') {
      mode = 'line';
      i += 2;
      continue;
    }
    if (two === '/*') {
      mode = 'block';
      i += 2;
      continue;
    }
    if (c === "'") {
      mode = 'single';
      result += c;
      i += 1;
      continue;
    }
    result += c;
    i += 1;
  }
  return result;
}

function migrationNumber(filename: string): number | null {
  const m = filename.match(/^(\d{4})_/);
  return m ? Number(m[1]) : null;
}

describe('G1 — no migration numbered ≥ 0169 re-widens the default privileges (static, no DB)', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const qualifying = files.filter((f) => {
    const n = migrationNumber(f);
    return n !== null && n >= 169;
  });

  it('at least one migration numbered ≥ 0169 exists — red today: 0169 has not been written yet', () => {
    expect(qualifying, `all .sql files seen: ${JSON.stringify(files)}`).not.toHaveLength(0);
  });

  it.each(qualifying)(
    '%s does not re-widen the default (no ALTER DEFAULT PRIVILEGES ... GRANT UPDATE|DELETE|ALL ... ON TABLES)',
    (file) => {
      const raw = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      const stripped = stripSqlComments(raw);
      expect(WIDENING_RE.test(stripped), `${file} matched the widening pattern`).toBe(false);
    },
  );

  it("positive control: the SAME regex matches 0011_row_level_security.sql's original default grant — proves the matcher can fail, not a tautology that would pass regardless", () => {
    const raw = readFileSync(resolve(MIGRATIONS_DIR, '0011_row_level_security.sql'), 'utf8');
    const stripped = stripSqlComments(raw);
    expect(WIDENING_RE.test(stripped), '0011 was expected to match — it IS the original widening grant this task narrows').toBe(true);
  });

  it('positive control: a token living only in a SQL comment is correctly NOT matched (the exact trap a naive scan would fall into)', () => {
    const fakeSql = "-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT UPDATE ON TABLES TO shareat_app;\nselect 1;";
    const stripped = stripSqlComments(fakeSql);
    expect(WIDENING_RE.test(stripped)).toBe(false);
  });
});
