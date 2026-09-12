import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DEF-288, bible §13 row 194 — `authTransaction()`'s caller list is closed and named.
 *
 * ⛔ **Why a SECOND guard rather than a fourth entry in `system-transaction-callers.test.ts`.**
 * Both helpers open the same privileged connection, so merging them would cost nothing
 * mechanically and lose the only thing row 194 bought: that *"crosses organisations because it is
 * a scheduler"* and *"…because it is establishing who you are"* stay two separately-countable
 * permissions. Row 185 closed one list at five call sites and said it was not a precedent; a
 * single day of arming the tenancy lock produced four more subsystems. One list would have
 * absorbed them all and nobody would have had to look twice at any of them.
 *
 * **The one permitted caller** is `packages/auth/src/sessions.ts`, and the door is scoped to four
 * lookups inside it: `findActiveCredentialByLookupHash`, `findActiveCredentialByExternalId`,
 * `findLiveByTokenHash`, and `endSession`'s write. Everything downstream of a resolved session
 * knows the actor's organisation and goes back through `withOrgPrincipal`.
 *
 * ⚠️ This is deliberately the SAME shape as the systemTransaction guard, comment-stripping
 * included — a re-export is a hole straight through an import-only guard (T-231 contract 5).
 *
 * ⭐ **T-278/DEF-310 — `SCAN_ROOTS` widened from three to the sibling's ten.** It had drifted from
 * `system-transaction-callers.test.ts` since DEF-295 widened THAT guard and this one was never
 * touched, despite the doc comment above claiming they are "deliberately the SAME shape." Nothing
 * distinguishes which roots could reach `authTransaction` versus `systemTransaction` — both are
 * exported from the same `@shareat/db` barrel — so the same ten roots apply here unchanged.
 * Production's role split (2026-09-12: `DATABASE_URL` non-bypassing, `SYSTEM_DATABASE_URL` —
 * `authTransaction` resolves to it — still `doadmin`, still bypassing) is what raised this from a
 * tidiness gap to a live tenancy question, per DEF-310's own filing.
 */

const repoRoot = path.resolve(__dirname, '..', '..');

/** The closed list. Adding to it is Ian's decision (row 194), never a lane's. */
const REQUIRED_CALLERS = ['packages/auth/src/sessions.ts'] as const;

/**
 * ⭐ T-278/DEF-310 — the identical ten roots `system-transaction-callers.test.ts` scans, for the
 * identical reason (DEF-295): a closed list nothing can see is not closed. `packages/db/src` is
 * now SCANNED, not omitted — its two definer files are excluded BY NAME below
 * (`DEFINER_FILES`), which is what `system-transaction-callers.test.ts` already does and what this
 * guard did not. Omitting a whole root to dodge two files is how this defect class is born.
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
 * The two files that DEFINE and DELIBERATELY EXPORT `authTransaction`, exempt because scanning
 * them would make the guard report its own plumbing as an offender — same reasoning and same two
 * files as `system-transaction-callers.test.ts`'s `DEFINER_FILES`.
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

function readRepoFile(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Comments describe the mechanism; they do not commit it. `client.ts` names every caller in prose. */
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

function callsAuthTransaction(code: string): boolean {
  return new RegExp(String.raw`(^|[^A-Za-z0-9_.'"\`])authTransaction\s*\(`).test(code);
}

function reachesAuthTransaction(content: string): string[] {
  const how: string[] = [];
  const code = codeOnly(content);

  const named = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gs;
  for (const m of code.matchAll(named)) {
    if (new RegExp(String.raw`(^|[,\s])authTransaction(\s+as\s+\w+)?\s*(,|$)`).test(m[1]!)) {
      how.push('imports/re-exports authTransaction (named, with `from`)');
    }
  }
  const bare = /\bexport\s*\{([^}]*)\}\s*;/g;
  for (const m of code.matchAll(bare)) {
    if (new RegExp(String.raw`(^|[,\s])authTransaction\s*(,|$)`).test(m[1]!)) {
      how.push('re-exports authTransaction (bare, no `from`)');
    }
  }
  if (callsAuthTransaction(code)) how.push('calls authTransaction()');
  return [...new Set(how)];
}

function scannable(extraExclude: readonly string[] = []): string[] {
  return trackedFiles().filter(
    (f) =>
      SCAN_ROOTS.some((root) => f === root || f.startsWith(`${root}/`)) &&
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.includes('/tests/') &&
      !f.endsWith('.test.ts') &&
      !DEFINER_FILES.includes(f) &&
      !extraExclude.includes(f),
  );
}

describe('DEF-288 — authTransaction() has a closed, named caller list (bible §13 row 194)', () => {
  it('every required caller is a real tracked file — a stale entry cannot grant cover', () => {
    const files = trackedFiles();
    for (const rel of REQUIRED_CALLERS) {
      expect(files.includes(rel), `required caller "${rel}" is not a tracked file`).toBe(true);
    }
  });

  it('the required caller actually calls authTransaction( — a list naming a non-caller asserts nothing', () => {
    for (const rel of REQUIRED_CALLERS) {
      expect(
        callsAuthTransaction(codeOnly(readRepoFile(rel))),
        `${rel} was expected to call authTransaction( directly and does not`,
      ).toBe(true);
    }
  });

  it('⭐ the scanned set is non-empty — a scan of nothing passes whether the rule holds or the scan is broken', () => {
    // reference_sweep_needs_nonzero_control — this project has shipped a silently-scanning-nothing
    // sweep twice (bible §13 row 181). A positive control on the extraction itself first.
    expect(scannable().length).toBeGreaterThan(50);
  });

  it('no file outside the closed list calls, imports, or re-exports authTransaction', () => {
    const offenders: string[] = [];
    for (const rel of scannable(REQUIRED_CALLERS)) {
      let content: string;
      try {
        content = readRepoFile(rel);
      } catch {
        continue; // tracked but absent (sparse checkout)
      }
      const how = reachesAuthTransaction(content);
      if (how.length > 0) offenders.push(`${rel} — ${how.join(' and ')}`);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Files reaching authTransaction() outside its closed caller list (${offenders.length}):\n  ` +
            `${offenders.join('\n  ')}\n\n` +
            'authTransaction() bypasses tenancy entirely and exists ONLY for the four lookups that ' +
            'run before anyone knows which organisation is acting (DEF-288, bible §13 row 194). ' +
            'If new code needs it, that is a design question for Ian — adding a name to the list ' +
            'above is his decision, not a way to make this test pass.',
    ).toEqual([]);
  });
});
