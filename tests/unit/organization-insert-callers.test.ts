import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-335 — U1. `insertOrganization(` has exactly ONE non-test call site, in
 * `packages/domain/src/organizations/index.ts` (`createOrganization`). §3's whole argument for
 * "seed inside createOrganization, not a trigger" rests on there being exactly one writer of
 * `organizations` — this is the mechanical guard that keeps that true, the same shape
 * `tests/unit/system-transaction-callers.test.ts` uses for `systemTransaction(`.
 */

const repoRoot = path.resolve(__dirname, '..', '..');

const REQUIRED_CALLERS = ['packages/domain/src/organizations/index.ts'] as const;

/** The one file that DEFINES `insertOrganization` — exempt, or the guard would report its own
 *  declaration as a call. Same convention as `system-transaction-callers.test.ts`'s DEFINER_FILES. */
const DEFINER_FILES: readonly string[] = ['packages/db/src/repo/organizations.ts'];

/** Same nine roots as `system-transaction-callers.test.ts` (DEF-295 — a closed list nothing can
 *  see is not closed). */
const SCAN_ROOTS = [
  'apps',
  'scripts',
  'packages/auth/src',
  'packages/core/src',
  'packages/db/src',
  'packages/domain/src',
  'packages/etl/src',
  'packages/etl-firestore/src',
  'packages/storage-firebase/src',
  'packages/sync-firestore/src',
] as const;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f.length > 0);
}

/** Strips block then line comments — same shape as `system-transaction-callers.test.ts`'s
 *  `codeOnly`, so a comment mentioning `insertOrganization(` cannot be counted as a call. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function readRepoFile(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

// ⛔ Audit round 2 fix, BLOCKING: the boundary class used to exclude `.` from the allowed
// preceding characters, so `organizationsRepo.insertOrganization(` — the repo's ONLY real call
// style — never matched at all. `(?:\w+\.)?` explicitly allows one namespaced-call prefix
// (`someRepo.`) between the boundary and the identifier, so a bare call, an aliased-import call,
// and a namespaced call are all caught, while a longer identifier merely ENDING in the name
// (`reinsertOrganization(`) still is not.
const INSERT_ORGANIZATION_CALL_RE = String.raw`(^|[^A-Za-z0-9_'"\`])(?:\w+\.)?insertOrganization\s*\(`;

function callsInsertOrganization(code: string): boolean {
  return new RegExp(INSERT_ORGANIZATION_CALL_RE).test(code);
}

function countInsertOrganizationCalls(code: string): number {
  return (code.match(new RegExp(INSERT_ORGANIZATION_CALL_RE, 'g')) ?? []).length;
}

/** Import-site AND re-export matched — the same hole a bare import-only guard would miss
 *  (`system-transaction-callers.test.ts`'s own header cites the precedent). */
function reachesInsertOrganization(content: string): string[] {
  const how: string[] = [];
  const code = codeOnly(content);

  const named = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gs;
  for (const m of code.matchAll(named)) {
    if (new RegExp(String.raw`(^|[,\s])insertOrganization(\s+as\s+\w+)?\s*(,|$)`).test(m[1]!)) {
      how.push('imports/re-exports insertOrganization (named, with `from`)');
    }
  }
  const bare = /\bexport\s*\{([^}]*)\}\s*;/g;
  for (const m of code.matchAll(bare)) {
    if (new RegExp(String.raw`(^|[,\s])insertOrganization\s*(,|$)`).test(m[1]!)) {
      how.push('re-exports insertOrganization (bare, no `from`)');
    }
  }
  if (callsInsertOrganization(code)) how.push('calls insertOrganization()');
  return [...new Set(how)];
}

describe('T-335 U1 — insertOrganization() has a closed, named caller list of exactly one', () => {
  it('the required caller is a real tracked file', () => {
    const files = trackedFiles();
    for (const rel of REQUIRED_CALLERS) {
      expect(files.includes(rel), `required caller "${rel}" is not a tracked file`).toBe(true);
    }
  });

  it('the required caller contains at least one insertOrganization( call — not vacuously zero (T-334 slice 2b shape)', () => {
    // Same function as the offender scan below, not a second ad-hoc pattern — two regexes that are
    // meant to agree WILL drift (this file's own audit finding 1 is exactly that shape).
    for (const rel of REQUIRED_CALLERS) {
      const calls = countInsertOrganizationCalls(codeOnly(readRepoFile(rel)));
      expect(calls, `${rel} was expected to call insertOrganization( at least once`).toBeGreaterThanOrEqual(1);
    }
  });

  it('mutation check: a synthetic namespaced second caller ("someRepo.insertOrganization(") is detected', () => {
    const synthetic = "export async function rogue(tx) { return someRepo.insertOrganization(tx, {}); }";
    expect(callsInsertOrganization(synthetic)).toBe(true);
    expect(countInsertOrganizationCalls(synthetic)).toBe(1);
  });

  it('mutation check: the OLD (buggy) boundary class would have missed the very call style this repo uses — proves this was a real fix', () => {
    const oldBuggyRe = /(^|[^A-Za-z0-9_.'"`])insertOrganization\s*\(/;
    const namespacedCall = 'organizationsRepo.insertOrganization(tx, { code, name })';
    expect(oldBuggyRe.test(namespacedCall), 'the old regex should fail on the real call style — that was the bug').toBe(false);
    expect(callsInsertOrganization(namespacedCall)).toBe(true);
  });

  it('⭐ the scanned set is non-empty — a scan of nothing passes whether the rule holds or the scan is broken', () => {
    const files = trackedFiles().filter(
      (f) =>
        SCAN_ROOTS.some((root) => f === root || f.startsWith(`${root}/`)) &&
        (f.endsWith('.ts') || f.endsWith('.tsx')) &&
        !f.includes('/tests/') &&
        !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(50);
  });

  it('no file outside the closed list calls, imports, or re-exports insertOrganization', () => {
    const scanned = trackedFiles().filter(
      (f) =>
        SCAN_ROOTS.some((root) => f === root || f.startsWith(`${root}/`)) &&
        (f.endsWith('.ts') || f.endsWith('.tsx')) &&
        !f.includes('/tests/') &&
        !f.endsWith('.test.ts') &&
        !DEFINER_FILES.includes(f) &&
        !(REQUIRED_CALLERS as readonly string[]).includes(f),
    );

    const offenders: string[] = [];
    for (const rel of scanned) {
      let content: string;
      try {
        content = readRepoFile(rel);
      } catch {
        continue; // tracked but absent (sparse checkout)
      }
      const how = reachesInsertOrganization(content);
      if (how.length > 0) offenders.push(`${rel} — ${how.join(' and ')}`);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Files reaching insertOrganization() outside its closed caller list (${offenders.length}):\n  ` +
            `${offenders.join('\n  ')}\n\n` +
            'insertOrganization is the only writer of organizations — a second call site breaks §3\'s ' +
            'argument for seeding positions inside createOrganization (T-335). See ' +
            'docs/tasks/335-positions-seeded-at-org-creation.md §3.',
    ).toEqual([]);
  });
});
