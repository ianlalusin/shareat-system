import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **T-231 — no apps/erp request path reaches the database without an RLS principal.**
 *
 * Slice 2 (DEF-209) closed the `transaction()` door; slice 3 (DEF-215) closed `getDb()`, the
 * second one, which `listOrgs()` had been reading every organisation through (DEF-214).
 *
 * ## What this is actually protecting
 *
 * Org isolation is enforced by PostgreSQL row-level security, not by remembering to write
 * `WHERE org_id = …` (bible §13 row 112, migration `0011_row_level_security.sql`). But a policy
 * only applies to a connection that has announced who it is: `withOrgPrincipal` sets the role and
 * the org GUC for the length of one transaction. A plain `transaction()` connects as the OWNER,
 * for which RLS does not apply at all — every policy in the database is switched off for that
 * query, silently, and the page still renders.
 *
 * `docs/discovery/29-rls-enforcement-assessment.md` measured it: 310 request paths carried a
 * principal and **34 did not**. Nothing distinguished them but which file you happened to open.
 *
 * ## Why a repo-wide scan rather than review
 *
 * Because the 34 were not a decision. They accumulated one file at a time over months, each one
 * locally reasonable, and **not one of them looks wrong on its own line**. A reviewer sees
 * `await transaction((tx) => repo.list(tx, orgId))` and reads a correctly-scoped query — which it
 * is, at the application layer, with the database's own guarantee quietly not applied. The only
 * assertion that means anything here is one that reads every file.
 *
 * ⚠️ **It matches re-exports, not only imports.** `apps/erp/src/app/reports/lib.ts` re-exported
 * `transaction`, so a page could reach it without ever naming `@shareat/db` — and this codebase
 * re-exports through per-directory `lib.ts` files as a matter of habit (89 files reach
 * `withOrgPrincipal` that way). A guard keyed on the package name alone would have passed while
 * the hole stayed open.
 *
 * ## The failure direction, so a break is read correctly
 *
 * Missing a principal does NOT leak. `app_current_org()` is NULL, every policy compares against
 * NULL, and the query returns **zero rows** — loud, not dangerous (`0011` lines 20-24). So if a
 * screen goes blank after this task, that is a query which had been relying on the owner bypass.
 * It is a caught bug, not a cosmetic regression: report it, do not paper over it.
 */

const repoRoot = join(import.meta.dirname, '..', '..');

/**
 * ⛔ **Every entry is a path that reads on the unrestricted owner connection.** It is a confession
 * with a name attached, not a config knob — and every one is the same confession: **the org is
 * not known yet, and cannot be.** ⚠️ This said "all three" while listing five; corrected
 * 2026-09-11 rather than left to imply the list is smaller than it is.
 *
 * A principal needs an org. Sign-in RESOLVES the org: `sessionsRepo.findActiveCredentialByLookupHash`
 * searches `person_credentials` by a store-scoped hash before any organisation is known, and
 * `resolveActor` is the function that produces the actor everything else derives its principal
 * from. Requiring a principal here is a chicken-and-egg, not an oversight.
 *
 * ⚠️ Adding an entry means claiming some other path also cannot know its org. Almost nothing
 * qualifies. The test below refuses a stale entry, because an exemption that no longer matches a
 * real file makes the rule look narrower than it is, and the next person widens it by adding a
 * neighbour.
 */
const PRE_AUTH_PATHS: readonly string[] = [
  'apps/erp/src/app/sign-in/actions.ts', // signInWithPin / signOut — the org is the OUTPUT
  'apps/erp/src/app/sign-in/page.tsx', // the store picker, rendered to a visitor with no session
  'apps/erp/src/lib/session.ts', // resolveActor — it is what produces the actor
  'apps/erp/src/app/setup/actions.ts', // first-run setup (T-232): the org is not known yet, and cannot be — it is what this action CREATES; bible row 185 names the exception
  'apps/erp/src/app/setup/lib.ts', // the zero-organisation read the first-run page renders from; no org exists to be the principal
  'apps/erp/src/app/sign-in/lib.ts', // resolveVerifiedSignIn's SECOND half — the identical zero-organisation read as setup/lib.ts above, asked of an unauthenticated visitor. Its FIRST half (signInWithFirebase) now passes null and opens authTransaction instead (DEF-288, bible row 194); this line covers only the org-existence question, which is a bootstrap question and not one of row 194's four auth lookups
];

function trackedErpFiles(): string[] {
  // ⚠️ `--cached --others --exclude-standard`: tracked AND untracked-but-not-ignored, the same
  // enumeration nav-route-reachability uses. Tracked-only meant a lane's new pre-auth file made the
  // exemption check cry wolf until it was staged, and a new offender was invisible until then too.
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'apps/erp/src'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter((f) => f.length > 0)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => !f.includes('/tests/'));
}

/** Comments describe the hazard; they do not commit it. `reports/lib.ts` names `getDb()` twice in
 *  prose explaining why reports stopped using it, and a scanner that counted those would report a
 *  file that is already fixed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
}

/**
 * Does this file reach a raw, unprincipalled database handle — by import, re-export, or call?
 *
 * ⭐ **Two doors, not one.** `transaction()` opens one as the owner; `getDb()` hands back the same
 * connection with no transaction at all. T-231 slice 2 closed the first and left the second, and
 * `listOrgs()` was sitting behind it reading every organisation in the system (DEF-214, DEF-215).
 * A guard that watched only `transaction` would have gone green over that.
 *
 * Deliberately module-agnostic: the defect is reaching either helper, and `reports/lib.ts` proved
 * one can be reached without ever naming `@shareat/db`.
 */
const RAW_HANDLES = ['transaction', 'getDb'] as const;

function reachesRawHandle(content: string): string[] {
  const how: string[] = [];
  const code = stripComments(content);

  const named = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gs;
  for (const m of code.matchAll(named)) {
    for (const h of RAW_HANDLES) {
      if (new RegExp(String.raw`(^|[,\s])${h}(\s+as\s+\w+)?\s*(,|$)`).test(m[1]!)) {
        how.push(`imports ${h}`);
      }
    }
  }
  // `export { transaction };` — a local re-export, no `from` clause.
  const bare = /\bexport\s*\{([^}]*)\}\s*;/g;
  for (const m of code.matchAll(bare)) {
    for (const h of RAW_HANDLES) {
      if (new RegExp(String.raw`(^|[,\s])${h}\s*(,|$)`).test(m[1]!)) how.push(`re-exports ${h}`);
    }
  }
  // A call needs no import when the handle is re-exported through a neighbouring lib.
  for (const h of RAW_HANDLES) {
    if (new RegExp(String.raw`(^|[^A-Za-z0-9_.'"\`])${h}\s*\(`).test(code)) how.push(`calls ${h}()`);
  }
  return [...new Set(how)];
}

describe('T-231 — no apps/erp request path opens a transaction without an RLS principal', () => {
  it('the scanned set is non-empty — a vacuous pass would prove nothing', () => {
    // ⭐ Standing lane policy after two silent sweep failures in one afternoon while writing
    // discovery 29: a scan that reports a total must first report a known non-zero control.
    // Neither of those bugs was visible in its own output.
    expect(trackedErpFiles().length).toBeGreaterThan(50);
  });

  it('every pre-auth exemption still matches a real file — a stale entry cannot grant cover', () => {
    const files = trackedErpFiles();
    for (const path of PRE_AUTH_PATHS) {
      expect(files.includes(path), `exemption "${path}" matches no tracked file`).toBe(true);
    }
  });

  it('no file reaches a raw database handle outside the pre-auth allowlist', () => {
    const offenders: string[] = [];

    for (const rel of trackedErpFiles()) {
      if (PRE_AUTH_PATHS.includes(rel)) continue;
      let content: string;
      try {
        content = readFileSync(join(repoRoot, rel), 'utf8');
      } catch {
        continue; // tracked but absent (sparse checkout)
      }
      const how = reachesRawHandle(content);
      if (how.length > 0) offenders.push(`${rel} — ${how.join(' and ')}`);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `apps/erp paths reaching the unprincipalled transaction() (${offenders.length}):\n  ` +
            `${offenders.join('\n  ')}\n\n` +
            'Use withOrgPrincipal(actor.orgId, (tx) => …) from @shareat/db. A plain transaction()\n' +
            'connects as the table owner, for which RLS does not apply — every policy in the\n' +
            'database is switched off for that query, and the page renders as if nothing happened.\n\n' +
            'See docs/discovery/29-rls-enforcement-assessment.md and DEF-209.',
    ).toEqual([]);
  });
});
