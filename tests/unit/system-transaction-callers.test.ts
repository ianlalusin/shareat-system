import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-251a — `systemTransaction()`'s caller list is closed and named, not open-ended (bible §13
 * row 185). This is the mechanical guard Contract 2 asks for: a behavioural test cannot prove
 * this task worked, because on today's role it changes no observable behaviour at all.
 *
 * **The files required to call it directly.** ⚠️ This was THREE until T-267 (2026-09-12) admitted
 * three more on two named rulings — see `REQUIRED_CALLERS` below, where each carries its own
 * authority. It was resolved per the orchestrator's brief,
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
  // T-267, Ian's ruling of 2026-09-12 (bible §13 row 195): the bootstrap question
  // "has this system been set up at all?" goes through the same door bootstrap's WRITE
  // already uses. Not a fifth caller admitted by analogy — a named ruling, recorded.
  'apps/erp/src/app/setup/lib.ts',
  'apps/erp/src/app/sign-in/lib.ts',
  // T-268, bible §13 row 194 subsystem 3 (DEF-289): the ETL tables carry FORCE RLS
  // with ZERO policies — deny-all by design (migration 0011:142-160), because they hold
  // captured production PII. No principal can EVER satisfy them, so this is not the
  // natural fix here, it is the only one. ⛔ Never add a policy to make the app role work.
  'packages/etl/src/run.ts',
  'packages/db/src/repo/etl.ts',
  // T-304 — a one-shot admin script, run by a person, never by a request: the same shape and the
  // same reason as `scripts/bootstrap-org.ts` above, which this file is explicitly instructed to
  // mirror (docs/tasks/304-two-layer-terminal-sign-in.md §"SCOPE CORRECTION"). It creates a
  // terminal's persons/credential rows before any organisation-scoped session could exist to run
  // it, exactly bootstrap-org.ts's own justification for the same connection.
  'scripts/provision-terminal.ts',
  // T-335, audit finding #3 — the backfill enumerates every org needing the six, the same
  // "must act across every organisation" shape row 185 already covers. One transaction per org,
  // same door as bootstrap-org.ts.
  'scripts/backfill-canonical-positions.ts',
  // DEF-742 — enumerates every org; lists via listOrgsToRun on a bare transaction(), must move to systemTransaction.
  'scripts/backfill-file-links.ts',
  // DEF-742 — enumerates every org; lists via listOrgsToRun on a bare transaction(), must move to systemTransaction.
  'scripts/backfill-fiscal-periods.ts',
  // DEF-742 — enumerates every org; lists via listOrgsToRun on a bare transaction(), must move to systemTransaction.
  'scripts/backfill-store-attendance-config.ts',
] as const;

/**
 * ⛔ **DEF-295 — this list used to be `['apps', 'packages/domain/src']`, and the assertion below
 * has always been titled *"no file outside the closed list"*.** It was not: seven of the repo's nine
 * source roots were unscanned, including `scripts/` — which the guard REQUIRES a caller from
 * (`scripts/bootstrap-org.ts`) while not policing it — and `packages/etl/src`, the package DEF-289
 * was about to add six call sites to. A closed list nothing can see is not closed.
 *
 * ⚠️ The positive control below (`files.length > 50`) guards bible §13 row 181's *"sweep that
 * scanned nothing"*. It cannot catch this, because a control on the SIZE of the scanned set says
 * nothing about whether it is the RIGHT set. That is the whole lesson of DEF-295.
 *
 * ⭐ Every source root is now scanned. `DEFINER_FILES` below is the only exemption and it is
 * structural, not a judgement call.
 */
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

/**
 * The two files that DEFINE and DELIBERATELY EXPORT `systemTransaction`, exempt because scanning
 * them would make the guard report its own plumbing as an offender.
 *
 * ⚠️ `index.ts` re-exports it on purpose and says why in its own comment: exporting
 * `systemTransaction` alone, never alongside `getSystemSql`/`getSystemDb`, because a raw accessor
 * would reach the same authority through a hole this guard's `systemTransaction(` pattern cannot
 * match. Do not "tidy" either file into the scan.
 */
const DEFINER_FILES: readonly string[] = ['packages/db/src/client.ts', 'packages/db/src/index.ts'];

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
