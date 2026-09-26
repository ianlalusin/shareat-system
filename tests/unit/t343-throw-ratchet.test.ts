/**
 * T-343 S5.0 — R1.2: the raw `throw new Error(` ratchet becomes PER-DIRECTORY.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5, "Ratchet rule (every group)", Amendment
 * R1 item 2, Amendment R2 fold.
 *
 * Was: one `CEILING` over `packages/domain/src` + `packages/auth/src` + `packages/db/src/repo`
 * combined (S1's R8). Now: one entry per top-level directory under `packages/domain/src`, plus
 * `packages/auth/src` and `packages/db/src/repo` — so a group converting `expenses/` can lower
 * `expenses`'s own ceiling without needing every OTHER directory's count to also be exactly right
 * that day, and so a brand-new directory with no entry fails closed instead of silently joining
 * whichever bucket happened to still have slack (Invariant 15).
 *
 * ⛔ **Measured against the COMMITTED tree, never an in-flight working tree** (orchestrator ruling,
 * R2, 2026-09-26). First measured at HEAD `78350ce` (T-346 S2, S3 still uncommitted) and confirmed
 * byte-identical to S3's own eventual diff — `git diff` on every file S3 touched added zero raw
 * `throw new Error(` sites. T-346 landed in full as `22475b1` (S3, "DEF-428 closed") before this
 * file's own commit, so the counts below are re-measured at THAT HEAD (unchanged from the S2
 * measurement, confirming the prediction) and `ALLOWANCE_UNTIL_T346` is removed below rather than
 * carried forward — R1.2's own rule ("the first commit after T-346 lands removes it, re-measuring
 * those four"), applied by the first commit that actually is after T-346, which is this one.
 *
 * ⛔ Pure `fs` traversal, not a shelled-out `grep` or `git` command — same reason as the original R8
 * test: this repo runs on Windows (PowerShell primary) and a CI runner may not share a shell.
 *
 * ⛔ **`/code-review` (2026-09-26): a loose `.ts` file at a covered root escaped both the ceiling and
 * the "new directory" fail-closed check** — `currentTargetDirs()` only ever enumerated SUBdirectories,
 * so neither `packages/domain/src/index.ts` nor anything at `packages/db/src` outside `repo/` (a
 * sibling like `refusal.ts`, or an untracked subdirectory like `cutover/`) was ever counted at all.
 * Two synthetic keys (`packages/domain/src/*`, `packages/db/src/*`) now cover exactly what the
 * per-subdirectory entries leave out — see `measure()` and the `CEILINGS` comment.
 *
 * ⛔ **`/code-review` round 2 (2026-09-26): `packages/db/src/*` counted a whole SUBTREE (everything
 * outside `repo/`, recursively), which coupled T-343's ceiling to T-347's unrelated, in-flight work
 * in `packages/db/src/cutover/purge.ts` — the tree read 3 instead of 1 purely because another lane
 * was mid-edit on a directory this key had no business watching.** `DB_SRC_OUTSIDE_REPO` now counts
 * ONLY the loose files directly at `packages/db/src` (same rule as `DOMAIN_ROOT_LOOSE`); every real
 * subdirectory besides `repo/` gets its OWN key instead. `rls/` gets one here (0, uncontested).
 * `cutover/` did NOT at the time this was written — T-347 was still in flight, and the rule was that
 * T-347's OWN tester adds that key at T-347's commit, measured against ITS OWN HEAD, not guessed at
 * from a moving tree. **It has since done so** (`'packages/db/src/cutover': 2` below) — kept, not
 * re-measured here. `currentTargetDirs()` also enumerates `packages/db/src`'s subdirectories now
 * (except `repo/`, which keeps its own key regardless), so the NEXT new one fails closed the same
 * way a new `packages/domain/src` subdirectory already does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const DOMAIN_SRC = resolve(repoRoot, 'packages', 'domain', 'src');
const DB_SRC = resolve(repoRoot, 'packages', 'db', 'src');

/** Synthetic keys for a covered root's own loose contents — see the CEILINGS comment below. */
const DOMAIN_ROOT_LOOSE = 'packages/domain/src/*';
const DB_SRC_OUTSIDE_REPO = 'packages/db/src/*';

/**
 * Per-directory raw `throw new Error(` counts, measured at HEAD `22475b1` (2026-09-26, T-346 S3 —
 * T-346 landed in full; see header). One entry per top-level directory under `packages/domain/src`,
 * plus the two non-domain trees the original R8 ratchet also covered. Never raised; each S5 group
 * lowers only its OWN directories' entries here, recording the before/after count in its commit
 * message (R1.2).
 */
const CEILINGS: Record<string, number> = {
  'packages/domain/src/ap': 0, // T-343 S5.2: 39 -> 0, all converted to refuse/gone/internalFault
  'packages/domain/src/ar': 35,
  'packages/domain/src/attendance': 1,
  'packages/domain/src/budgets': 4,
  'packages/domain/src/cash-requests': 21,
  'packages/domain/src/channel-settlements': 12,
  'packages/domain/src/commissary': 48, // T-343 S5.3: 64 -> 48, catalogue.ts converted to refuse/gone/internalFault
  'packages/domain/src/customers': 0, // T-343 S5.2: 11 -> 0, all converted to refuse/gone/internalFault
  'packages/domain/src/cutover': 4, // T-343 S5.3: 13 -> 4, opening.ts converted to refuse/gone/internalFault
  'packages/domain/src/deliveries': 1, // T-343 S5.3: 11 -> 1, documents.ts converted to refuse/gone/internalFault
  'packages/domain/src/expenses': 0, // T-343 S5.1: 40 -> 0, all converted to refuse/gone/internalFault
  'packages/domain/src/files': 9,
  'packages/domain/src/findings': 1,
  'packages/domain/src/fiscal-periods': 15,
  'packages/domain/src/fixed-assets': 17,
  'packages/domain/src/items': 34,
  'packages/domain/src/ledger': 10,
  'packages/domain/src/liabilities': 16,
  'packages/domain/src/loans': 13,
  'packages/domain/src/missed-months': 13,
  'packages/domain/src/money-accounts': 10,
  'packages/domain/src/money-transfers': 11,
  'packages/domain/src/organizations': 12,
  'packages/domain/src/owners': 29,
  'packages/domain/src/payroll': 34,
  'packages/domain/src/people': 0,
  'packages/domain/src/pos': 7,
  'packages/domain/src/prepaid': 20,
  'packages/domain/src/production': 7,
  'packages/domain/src/recurring-expenses': 13,
  'packages/domain/src/remittance': 17,
  'packages/domain/src/reports': 0,
  'packages/domain/src/sales-channels': 10,
  'packages/domain/src/sales-days': 0, // T-343 S5.1: 16 -> 0, all converted to refuse/gone/internalFault
  'packages/domain/src/scheduler': 0,
  'packages/domain/src/service-charge': 6,
  'packages/domain/src/shared': 9,
  'packages/domain/src/statutory-discounts': 3,
  'packages/domain/src/stock': 8,
  'packages/domain/src/stock-locations': 16,
  'packages/domain/src/stores': 12,
  'packages/domain/src/sync': 0,
  'packages/domain/src/till': 18,
  'packages/domain/src/trade': 53,
  'packages/domain/src/wastage': 11,
  'packages/auth/src': 0, // T-343 S5a: 7 -> 0, all converted to refuse/gone/AuthorizationError(...,userMessage)
  'packages/db/src/repo': 17, // T-343 S5.2: 20 -> 17, the 3 ap.ts sites converted to refuse(...)
  'packages/db/src/rls': 0,
  // T-347 (DEF-437), own commit — measured independently against `packages/db/src/cutover/purge.ts`
  // (`classification.ts` has none): `derivePurgeOrder`'s cycle guard (:161) and `applyPurge`'s
  // post-condition failure (:380). Both are test/operator-only diagnostics inside a script/engine
  // that only ever runs by hand against a single pre-cutover database, never a user-facing path —
  // the header's own rule: T-347's tester adds this key at T-347's commit, measured at ITS OWN HEAD.
  'packages/db/src/cutover': 2,
  // /code-review, S5.0 (2026-09-26): the two covered roots' own LOOSE contents — everything the
  // per-subdirectory entries above do not reach. Without these, a raw throw added directly at
  // `packages/domain/src/index.ts` escaped both the ceiling and the "new directory" fail-closed
  // check below — `currentTargetDirs()` only ever walked SUBDIRECTORIES.
  [DOMAIN_ROOT_LOOSE]: 0,
  // Loose files ONLY (round 2 above) — client.ts (0), index.ts (0), refusal.ts (1, its own
  // empty-sentence guard at :42). `cutover/` is deliberately absent; see the header.
  [DB_SRC_OUTSIDE_REPO]: 1,
};

/**
 * T-346 (S1 `1ac1bca`, S2 `78350ce`, S3 `22475b1`) landed in full before this file's own commit —
 * `ALLOWANCE_UNTIL_T346` (a `+10` slack on `missed-months`/`fixed-assets`/`stores`/`ledger`) is
 * therefore NOT carried forward here at all, per R1.2's own rule that the first commit after T-346
 * lands removes it and re-measures those four to their real count. Re-measuring found their counts
 * unchanged from the S2 baseline (13/17/12/10) — T-346 never added a raw throw to any of the four —
 * so there is nothing to lower either; the allowance is simply gone, not replaced by a smaller one.
 */
function ceilingFor(dir: string): number {
  const base = CEILINGS[dir];
  if (base === undefined) {
    // Unreachable once the "every directory has an entry" test below passes — a bare `throw` here
    // (not `refuse`/`gone`) is correct: this IS test infrastructure catching its own precondition,
    // not a user-facing refusal.
    throw new Error(`no CEILINGS entry for ${dir}`);
  }
  return base;
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function countRawThrowNewError(absDir: string): number {
  let total = 0;
  for (const file of collectTsFiles(absDir)) {
    const matches = readFileSync(file, 'utf8').match(/throw new Error\(/g);
    if (matches) total += matches.length;
  }
  return total;
}

/** Only the `.ts` FILES directly inside `absDir` — no recursion. For a root whose every
 *  subdirectory already has its own CEILINGS entry (`packages/domain/src`), this is exactly the
 *  content those per-subdirectory counts do not reach. */
function countLooseFilesRaw(absDir: string): number {
  let total = 0;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const matches = readFileSync(join(absDir, entry.name), 'utf8').match(/throw new Error\(/g);
    if (matches) total += matches.length;
  }
  return total;
}

/** Dispatches each CEILINGS key to the counting rule it actually needs — a per-subdirectory entry
 *  counts its own subtree; the two synthetic "loose contents" keys count only the loose files at
 *  that root (see the CEILINGS comment — round 2's fix for the T-347 coupling). */
function measure(dir: string): number {
  if (dir === DOMAIN_ROOT_LOOSE) return countLooseFilesRaw(DOMAIN_SRC);
  if (dir === DB_SRC_OUTSIDE_REPO) return countLooseFilesRaw(resolve(repoRoot, 'packages', 'db', 'src'));
  return countRawThrowNewError(resolve(repoRoot, dir));
}

/** Every CURRENT top-level directory under `packages/domain/src`, every current subdirectory of
 *  `packages/db/src` except `repo/` (which keeps its own fixed key regardless), plus the fixed
 *  non-domain trees and the two "loose contents" synthetic keys — recomputed live so a directory
 *  added after this file was written is caught by the next test, not silently skipped. */
function currentTargetDirs(): string[] {
  const domainDirs = readdirSync(DOMAIN_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `packages/domain/src/${e.name}`)
    .sort();
  const dbDirs = readdirSync(DB_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'repo')
    .map((e) => `packages/db/src/${e.name}`)
    .sort();
  return [...domainDirs, DOMAIN_ROOT_LOOSE, 'packages/auth/src', 'packages/db/src/repo', ...dbDirs, DB_SRC_OUTSIDE_REPO];
}

describe('T-343 R1.2 — the raw throw-new-Error ratchet, per directory, never rises', () => {
  it('every current directory has a CEILINGS entry — a new directory with none fails closed (Invariant 15)', () => {
    const missing = currentTargetDirs().filter((dir) => CEILINGS[dir] === undefined);
    expect(missing).toEqual([]);
  });

  it.each(Object.keys(CEILINGS))('%s stays at or under its ceiling', (dir) => {
    const count = measure(dir);
    const ceiling = ceilingFor(dir);
    // Printed so the group that next lowers this directory's ceiling has the real number, not a
    // guess — same convention the original single-CEILING test used.
    // eslint-disable-next-line no-console
    console.log(`T-343 ratchet: ${dir} = ${count} raw 'throw new Error(' sites (ceiling ${ceiling})`);
    expect(count).toBeLessThanOrEqual(ceiling);
  });
});
