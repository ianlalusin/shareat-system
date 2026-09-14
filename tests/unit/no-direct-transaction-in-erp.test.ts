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
 * A principal needs an org, and `resolveActor` is the function that produces the actor everything
 * else derives its principal from. Requiring a principal there is a chicken-and-egg, not an
 * oversight.
 *
 * ⭐ **T-302 — the PIN lookup is no longer an example of this and must not be cited as one.** This
 * paragraph used to open with `sessionsRepo.findActiveCredentialByLookupHash` "searches
 * `person_credentials` by a store-scoped hash before any organisation is known". Both halves are
 * now false: the hash is org-scoped, and T-304's layer 1 resolves the org from the terminal's own
 * credential before a PIN is typed, so `signInWithPin` runs its lookup under `withOrgPrincipal`.
 *
 * ⚠️ Adding an entry means claiming some other path also cannot know its org. Almost nothing
 * qualifies. The test below refuses a stale entry, because an exemption that no longer matches a
 * real file makes the rule look narrower than it is, and the next person widens it by adding a
 * neighbour.
 */
// ⭐ T-304 — down to ONE entry, not the two DEF-333's own spec anticipated. `sign-in/page.tsx`'s
// store list is deleted outright (the fix this whole task exists for — no pre-auth read replaces
// it). `sign-in/actions.ts` loses its exemption too, one step further than the spec's Q4 table
// expected: its `transaction` import was already dead (DEF-288 had already routed every real
// read through the auth door) and the T-304 rewrite removed the import itself, so DEF-296's own
// rule applies — an exemption that no longer reaches a raw handle is removed, not kept, because
// keeping it "makes the rule look narrower than it is." Verified with `grep -n "transaction("
// apps/erp/src/app/sign-in/actions.ts` before removing: zero calls, comments only.
const PRE_AUTH_PATHS: readonly string[] = [
  'apps/erp/src/lib/session.ts', // resolveActor — it is what produces the actor
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

  /**
   * ⛔ **DEF-296.** The assertion above only checks the exemption names a file that still EXISTS.
   * It never checked that the file still NEEDS the exemption — and files get fixed far more often
   * than they get deleted, so that is the likelier staleness by a wide margin.
   *
   * ⚠️ **It found THREE dead entries, not the two T-267 created.** `setup/actions.ts` had been
 * exempt with no raw handle since it was converted to `systemTransaction()` — stale long before
 * today, and invisible for exactly as long. That is the entry this assertion exists for.
 *
 * ⭐ Proven by T-267: routing `setup/lib.ts` and `sign-in/lib.ts` through `systemTransaction()`
   * removed their only raw-handle use, and this guard stayed green with both exemptions standing.
   * `systemTransaction(` does not match the `transaction(` pattern — the preceding `m` fails the
   * boundary class — so nothing fired. Both entries are now removed, and this test is what keeps
   * the next pair from lingering.
   *
   * ⚠️ The list's own comment warns that a stale exemption *"makes the rule look narrower than
   * it is, and the next person widens it by adding a neighbour."* This is that warning, enforced.
   */
  it('⭐ every pre-auth exemption is still NEEDED — a file that no longer reaches a raw handle loses it (DEF-296)', () => {
    const kept: string[] = [];
    for (const path of PRE_AUTH_PATHS) {
      let content: string;
      try {
        content = readFileSync(join(repoRoot, path), 'utf8');
      } catch {
        continue; // the assertion above already owns "file is missing"
      }
      if (reachesRawHandle(content).length === 0) kept.push(path);
    }
    expect(
      kept,
      kept.length === 0
        ? ''
        : `These files are exempted from the raw-handle rule but no longer reach one (${kept.length}): ${kept.join(', ')}.\n\n An exemption that is no longer needed is removed, not kept - it makes the rule look narrower than it is and invites the next neighbour to be added beside it. Delete the entry from PRE_AUTH_PATHS. See DEF-296.`,
    ).toEqual([]);
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
