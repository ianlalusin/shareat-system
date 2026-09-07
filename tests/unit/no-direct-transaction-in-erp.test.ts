import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **T-231 slice 2 / DEF-209 — no request path opens a transaction without a principal.**
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
 * with a name attached, not a config knob — and all three are the same confession: **the org is
 * not known yet, and cannot be.**
 *
 * A principal needs an org. Sign-in RESOLVES the org: `sessionsRepo.findActiveCredentialByLookupHash`
 * searches `person_credentials` by a store-scoped hash before any organisation is known, and
 * `resolveActor` is the function that produces the actor everything else derives its principal
 * from. Requiring a principal here is a chicken-and-egg, not an oversight.
 *
 * ⚠️ Adding a fourth entry means claiming some other path also cannot know its org. Almost nothing
 * qualifies. The test below refuses a stale entry, because an exemption that no longer matches a
 * real file makes the rule look narrower than it is, and the next person widens it by adding a
 * neighbour.
 */
const PRE_AUTH_PATHS: readonly string[] = [
  'apps/erp/src/app/sign-in/actions.ts', // signInWithPin / signOut — the org is the OUTPUT
  'apps/erp/src/app/sign-in/page.tsx', // the store picker, rendered to a visitor with no session
  'apps/erp/src/lib/session.ts', // resolveActor — it is what produces the actor
];

function trackedErpFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'apps/erp/src'], {
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

/**
 * Does this file pull in the raw `transaction` helper, by import or by re-export?
 *
 * Deliberately module-agnostic: the defect is reaching the unprincipalled helper at all, and
 * `reports/lib.ts` proved it can be reached without naming `@shareat/db`.
 */
function reachesRawTransaction(content: string): string[] {
  const how: string[] = [];
  const named = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gs;
  for (const m of content.matchAll(named)) {
    if (/(^|[,\s])transaction(\s+as\s+\w+)?\s*(,|$)/.test(m[1]!)) how.push('imports it');
  }
  // `export { transaction };` — a local re-export, no `from` clause.
  const bare = /\bexport\s*\{([^}]*)\}\s*;/g;
  for (const m of content.matchAll(bare)) {
    if (/(^|[,\s])transaction\s*(,|$)/.test(m[1]!)) how.push('re-exports it');
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

  it('no file reaches the raw transaction helper outside the pre-auth allowlist', () => {
    const offenders: string[] = [];

    for (const rel of trackedErpFiles()) {
      if (PRE_AUTH_PATHS.includes(rel)) continue;
      let content: string;
      try {
        content = readFileSync(join(repoRoot, rel), 'utf8');
      } catch {
        continue; // tracked but absent (sparse checkout)
      }
      const how = reachesRawTransaction(content);
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
