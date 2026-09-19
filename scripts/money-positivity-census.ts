/**
 * T-325/DEF-376 — a real, non-test caller for `scanMoneyPositivitySites`.
 *
 * `packages/domain/src/shared/money-positivity-census.ts` is a source module whose only other
 * references are test files (`money-positivity-census.test.ts`, `money-positivity-guard.test.ts`),
 * which makes `scanMoneyPositivitySites` itself a `test-only` export under `callers.mjs` — the
 * DEF-129/135/136/137/147 shape, five tasks once marked done with zero production callers. This
 * script exists to close that gap, and nothing else: it scans, it prints, and it fails loudly on a
 * structural break. It does NOT reproduce `CLASSIFIED` — that table is deliberately test-file-only
 * (Contract §2), a script under `scripts/` cannot import a `.test.ts`, and a second copy of the
 * table here would be a second source of truth that drifts from the one T7 already checks on every
 * commit (the same argument RULES.md §6 makes against re-implementing a database CHECK constraint
 * in TypeScript). So this CLI has no notion of "unclassified" and no `--check` flag.
 *
 *     npx tsx scripts/money-positivity-census.ts
 */
import { join } from 'node:path';
import { scanMoneyPositivitySites } from '@shareat/domain/shared/money-positivity-census';

const rootDir = join(process.cwd(), 'packages/domain/src');
const sites = scanMoneyPositivitySites(rootDir);

// DEF-179 — a scan of nothing passes silently unless something says so. `packages/domain/src`
// legitimately holding zero guarded money-positivity comparisons is not a real outcome today; it
// means the walk landed on the wrong directory or the matching regexes stopped matching anything.
// Spelled `=== 0`, never `!(sites.length > 0)` — the negated-paren spelling is itself a
// NEG_PAREN_GT-shaped site and would put this file in its own census.
if (sites.length === 0) {
  console.error(`money-positivity-census: found 0 sites under ${rootDir} — that is a scanner or path failure, not a clean tree.`);
  process.exit(1);
}

for (const site of sites) {
  console.log(`${site.file}:${site.line}  ${site.raw}`);
}
console.log(`\n${sites.length} money-positivity comparison(s) found under ${rootDir}`);
