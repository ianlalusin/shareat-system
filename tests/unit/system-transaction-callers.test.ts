import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-251a — `systemTransaction()`'s caller list is closed and named, not open-ended (bible §13
 * row 185). This is the mechanical guard Contract 2 asks for: a behavioural test cannot prove
 * this task worked, because on today's role it changes no observable behaviour at all.
 *
 * **The three files required to call it directly** — resolved per the orchestrator's brief,
 * following the FOUR-file reading of Contract 2 rather than padding the count to match Contract
 * 1's doc comment (which enumerates five call SITES — runJobForOrg, closeFailedRun,
 * listOrgsToRun, and bootstrapOrganization's two callers — across three files, not five):
 *
 *   - `packages/domain/src/scheduler/index.ts` (runJobForOrg's startRun/finishRun,
 *     closeFailedRun's failRun, and the module-level `listOrgsToRun` helper)
 *   - `scripts/bootstrap-org.ts` (wraps its `bootstrapOrganization` call)
 *   - `apps/erp/src/app/setup/actions.ts` (wraps its `bootstrapOrganization` call)
 *
 * **`packages/domain/src/organizations/index.ts` is deliberately EXCLUDED** — `bootstrapOrganization`
 * takes an already-open `Tx` from its caller and never opens a transaction itself, so asserting it
 * "calls systemTransaction" would be false. Padding the guard to name it as a fourth caller just to
 * match Contract 1's bullet-list shape would assert something the code does not do.
 */

const repoRoot = path.resolve(__dirname, '..', '..');

const REQUIRED_CALLERS = [
  'packages/domain/src/scheduler/index.ts',
  'scripts/bootstrap-org.ts',
  'apps/erp/src/app/setup/actions.ts',
] as const;

/** Every file `systemTransaction` must NOT be reachable from without being named a caller above. */
const SCAN_ROOTS = ['apps', 'packages/domain/src'] as const;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f.length > 0);
}

/**
 * Comments describe the mechanism; they do not commit it. `systemTransaction`'s own doc comment
 * in `client.ts` names every caller in prose — a scanner that counted that as a call would report
 * a file that never calls anything. Strips block comments then line comments, matching the
 * convention `DEF-221`'s guard established (`tests/unit/integration-glob-guard.test.ts`) and the
 * comment-stripping DEF-221's own note cites from `no-direct-transaction-in-erp.test.ts`.
 */
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

function callsSystemTransaction(code: string): boolean {
  return new RegExp(String.raw`(^|[^A-Za-z0-9_.'"\`])systemTransaction\s*\(`).test(code);
}

/**
 * Import-site AND re-export matched — mirroring T-231 contract 5's finding (b), that a re-export
 * is a hole straight through an import-only guard (`reports/lib.ts` reached a raw handle without
 * ever naming `@shareat/db`).
 */
function reachesSystemTransaction(content: string): string[] {
  const how: string[] = [];
  const code = codeOnly(content);

  const named = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gs;
  for (const m of code.matchAll(named)) {
    if (new RegExp(String.raw`(^|[,\s])systemTransaction(\s+as\s+\w+)?\s*(,|$)`).test(m[1]!)) {
      how.push('imports/re-exports systemTransaction (named, with `from`)');
    }
  }
  const bare = /\bexport\s*\{([^}]*)\}\s*;/g;
  for (const m of code.matchAll(bare)) {
    if (new RegExp(String.raw`(^|[,\s])systemTransaction\s*(,|$)`).test(m[1]!)) {
      how.push('re-exports systemTransaction (bare, no `from`)');
    }
  }
  if (callsSystemTransaction(code)) how.push('calls systemTransaction()');
  return [...new Set(how)];
}

describe('T-251a — systemTransaction() has a closed, named caller list (bible §13 row 185)', () => {
  it('every required caller is a real tracked file — a stale entry cannot grant cover', () => {
    const files = trackedFiles();
    for (const rel of REQUIRED_CALLERS) {
      expect(files.includes(rel), `required caller "${rel}" is not a tracked file`).toBe(true);
    }
  });

  it('each of the three required callers contains at least one systemTransaction( call', () => {
    for (const rel of REQUIRED_CALLERS) {
      expect(
        callsSystemTransaction(codeOnly(readRepoFile(rel))),
        `${rel} was expected to call systemTransaction( directly and does not`,
      ).toBe(true);
    }
  });

  it('organizations/index.ts does NOT itself call systemTransaction — bootstrapOrganization takes an already-open Tx', () => {
    const content = readRepoFile('packages/domain/src/organizations/index.ts');
    expect(
      callsSystemTransaction(codeOnly(content)),
      'organizations/index.ts should not call systemTransaction directly; its callers open the transaction',
    ).toBe(false);
  });

  it('⭐ the scanned set is non-empty — a scan of nothing passes whether the rule holds or the scan is broken', () => {
    // reference_sweep_needs_nonzero_control — this project has shipped a silently-scanning-nothing
    // sweep twice (bible §13 row 181). A positive control on the extraction itself first.
    const files = trackedFiles().filter(
      (f) =>
        SCAN_ROOTS.some((root) => f === root || f.startsWith(`${root}/`)) &&
        (f.endsWith('.ts') || f.endsWith('.tsx')) &&
        !f.includes('/tests/') &&
        !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(50);
  });

  it('no file outside the closed list calls, imports, or re-exports systemTransaction', () => {
    const scanned = trackedFiles().filter(
      (f) =>
        SCAN_ROOTS.some((root) => f === root || f.startsWith(`${root}/`)) &&
        (f.endsWith('.ts') || f.endsWith('.tsx')) &&
        !f.includes('/tests/') &&
        !f.endsWith('.test.ts') &&
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
      const how = reachesSystemTransaction(content);
      if (how.length > 0) offenders.push(`${rel} — ${how.join(' and ')}`);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Files reaching systemTransaction() outside its closed caller list (${offenders.length}):\n  ` +
            `${offenders.join('\n  ')}\n\n` +
            'systemTransaction is reserved for the enumerable set of operations that must act across ' +
            'every organisation (bible §13 row 185). Not a general escape hatch and not a precedent ' +
            'for a new caller — raise it as a design question rather than reaching for this by analogy. ' +
            'See packages/db/src/client.ts\'s doc comment and docs/tasks/251a-system-transaction.md.',
    ).toEqual([]);
  });
});
