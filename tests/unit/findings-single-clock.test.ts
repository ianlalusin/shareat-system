/**
 * T-218 — the standing guard behind DEF-172, and the reason it cannot come back.
 *
 * ⭐ **This test outlives the fix.** DEF-172 was filed as "four detectors use bare `current_date`";
 * the real count was **ten sites across four files** — seven in `findings.ts` in three distinct
 * mechanisms, plus `channel-settlements.ts`, `owners.ts` and `deliveries.ts`. The reason it drifted
 * that far is that there was nowhere to put the definition, so every query spelled the date for
 * itself. A one-time cleanup fixes the ten; this fixes the eleventh, which is not written yet.
 *
 * Two rules, both about the same thing — **an ageing detector must have exactly one clock**:
 *
 * 1. ⛔ **No bare `current_date`.** It follows the SESSION timezone, so on a UTC production server
 *    it reads *yesterday* through Manila's 00:00–08:00 — migration `0112`'s own comment states this
 *    as standing bible discipline for every business-date comparison.
 * 2. ⛔ **No `Date.now()`.** A detector that gates in SQL and then recomputes its displayed age in
 *    JavaScript is reading two clocks, and they disagree exactly when it matters.
 *    `cashRequestFloatAgeing` did both: its gate said "released over 30 days ago" in Postgres time
 *    while its badge said "31 days" in JS UTC time, with nothing making them agree.
 *
 * ⚠️ The same two-clock mistake was filed the same day as **DEF-178** against
 * `lane-health.test.ts`. Two independent sightings in one day is why this is a guard and not a
 * comment.
 *
 * Grep-shaped guards have precedent here: `tests/unit/no-client-supplied-actor.test.ts` and
 * `packages/db/tests/migration-journal.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_DIR = fileURLToPath(new URL('../../packages/db/src/repo/', import.meta.url));

/**
 * ⭐ **The whole repo layer, not just `findings.ts` — and that widening IS the finding.** DEF-172
 * was filed as "four detectors in one file"; it was **ten sites across four files**
 * (`findings.ts`, `channel-settlements.ts`, `owners.ts`, `deliveries.ts`). A guard scoped to the
 * file the defect was noticed in would have declared the defect closed while three instances of it
 * were still live — one of them driving an amber badge a person acts on at 14 days.
 *
 * ⛔ `sql-time.ts` is the one file allowed to say it: it is where `MANILA_TODAY` is defined.
 */
const OWNER_OF_THE_DEFINITION = 'sql-time.ts';

/**
 * Strips comments so the guard judges CODE, not the prose explaining it — this file's own
 * explanatory notes name `current_date` repeatedly and must not trip it.
 *
 * Handles the three comment forms that appear in these files: block comments, `//` line comments,
 * and `--` SQL line comments inside the template literals. ⚠️ Deliberately naive about `//` inside
 * a string literal — no repo file contains a URL, and a guard that is easy to read is worth more
 * here than one that is exactly right about a case that does not occur.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  // ⛔ **Normalise CRLF FIRST, and this is not a tidiness step — it is the whole correctness of the
  // two regexes below.** This repo checks out CRLF on Windows (git says so on every commit:
  // *"LF will be replaced by CRLF"*), and in JavaScript `.` does **not** match `\r` — it is a line
  // terminator, like `\n`. So on a CRLF line, `/--.*$/` can never reach end-of-string and the
  // match silently fails: `.*` stops before the `\r`, and `$` is not there yet.
  //
  // ⚠️ The failure mode is the dangerous one — the stripper returns the line UNCHANGED and the
  // guard reports a comment as if it were code. Caught 2026-09-05 by this guard flagging its own
  // explanatory comment; the block-comment path above uses `indexOf` and was never affected, which
  // is exactly why it looked like it worked.
  for (const rawLine of source.replace(/\r\n/g, '\n').split('\n')) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      // ⚠️ Blank the line, never drop it. A dropped line shifts every number after it, and the
      // whole value of this guard is the `<file>:NNN` it prints — a failure that sends you to
      // the wrong line is worse than one that prints none.
      if (end === -1) {
        out.push('');
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf('/*');
      if (start === -1) break;
      const end = line.indexOf('*/', start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    line = line.replace(/\/\/.*$/, '').replace(/--.*$/, '');
    out.push(line);
  }
  return out.join('\n');
}

function hits(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const file of readdirSync(REPO_DIR).filter((f) => f.endsWith('.ts')).sort()) {
    if (file === OWNER_OF_THE_DEFINITION) continue;
    const code = stripComments(readFileSync(join(REPO_DIR, file), 'utf8'));
    code.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (pattern.test(trimmed)) out.push(`${file}:${i + 1}  ${trimmed}`);
    });
  }
  return out;
}

describe('T-218 — every repo query reads ONE clock, and it is Manila', () => {
  it('⛔ no bare `current_date` — it follows the session timezone, not Manila (DEF-172)', () => {
    // `\b` on both sides so `(now() at time zone 'Asia/Manila')::date` and any identifier that
    // merely ends in `_current_date` are not false positives.
    expect(hits(/\bcurrent_date\b/)).toEqual([]);
  });

  it('⛔ no `Date.now()` — a SQL gate and a JS age are two clocks that will disagree', () => {
    expect(hits(/\bDate\.now\(\)/)).toEqual([]);
  });

  it('⭐ the Manila form is actually present — the fix is a conversion, not a deletion', () => {
    const code = readFileSync(join(REPO_DIR, OWNER_OF_THE_DEFINITION), 'utf8');
    expect(code).toContain("now() at time zone 'Asia/Manila'");
  });

  it('⭐ the scanned set is non-empty — a vacuous pass would prove nothing', () => {
    const scanned = readdirSync(REPO_DIR).filter((f) => f.endsWith('.ts'));
    expect(scanned.length).toBeGreaterThan(20);
    expect(scanned).toContain('findings.ts');
    expect(scanned).toContain('channel-settlements.ts');
  });
});
