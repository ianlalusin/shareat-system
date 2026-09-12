import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-289 §C11 — `reconcilePositionGrants` is deliberately unreachable from any screen: it is
 * exported only to the five call sites in `people/index.ts` and `position-defaults.ts` itself.
 * `docs/tasks/289-position-access-defaults-spine.md` §C11.
 *
 * Same technique as `tests/unit/domain-actions-have-callers.test.ts`: `git ls-files`, never a
 * directory walk (`apps/erp/.next` holds turbopack copies of the domain barrel and would make
 * every symbol look imported — `.next` is gitignored, so a git-based enumeration cannot see it).
 * Comments stripped, CRLF normalised first (DEF-179 — this repo checks out CRLF and `.` does not
 * match `\r`, so a line-oriented scan can match nothing and pass).
 */

const repoRoot = path.resolve(__dirname, '../..');

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * The closed set — the primitive's own definition, its production caller (moments 3, 4, 5 live
 * in the same file, `people/index.ts`), its integration test, this guard (which necessarily
 * names the identifier too), and ONE more than §C11's literal text names: `domain-actions-have-
 * callers.test.ts`'s own T-227 guard requires an `EXEMPT` entry KEYED on this exact identifier
 * (§C12 — `reconcilePositionGrants: 'INTERNAL — …'`), and an object key is as much a textual
 * mention as this file's own regex literal is — the same reasoning §C11 gives for counting THIS
 * file ("this file names it"). Measured, not assumed: reported as a (harmless) spec-defect in
 * the task report rather than narrowed past what the codebase actually contains.
 */
const EXPECTED = [
  'packages/domain/src/people/position-defaults.ts',
  'packages/domain/src/people/index.ts',
  'packages/domain/tests/integration/position-defaults.test.ts',
  'tests/unit/domain-actions-have-callers.test.ts',
  'tests/unit/position-defaults-callers.test.ts',
].sort();

function filesMentioningReconcile(): string[] {
  const pattern = /\breconcilePositionGrants\b/;
  const found: string[] = [];
  for (const file of trackedFiles()) {
    if (!/\.tsx?$/.test(file)) continue;
    const src = codeOnly(readFileSync(path.join(repoRoot, file), 'utf8'));
    if (pattern.test(src)) found.push(file);
  }
  return found.sort();
}

describe('T-289 §C11 — reconcilePositionGrants has a closed importer list', () => {
  it('is defined or imported by exactly its definition, its callers file, its integration test, and this guard', () => {
    expect(filesMentioningReconcile()).toEqual(EXPECTED);
  });

  it('⭐ the floor holds — a scan that matches nothing must not pass silently (DEF-179)', () => {
    expect(filesMentioningReconcile().length).toBeGreaterThan(2);
  });
});
