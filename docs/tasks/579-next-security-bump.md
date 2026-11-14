# T-579: next 16.4.6 and same-major security patches (DEF-847)

## Problem
`npm audit` reported 3 critical packages: `next` 16.3.2 (range 16.0.0 - 16.4.0: RCE via Image
Optimization/`next/og`/`use cache`, cache poisoning, SSRF, Server Actions DoS), `shell-quote` 1.10.0
(transitive via drizzle-kit > gel; `quote()` command injection) and `tar` 6.2.1 (via @capacitor/cli).

## Versions
| Package | Before | After | Note |
|---|---|---|---|
| next (apps/erp, apps/pos, apps/customer) | 16.3.2 (declared ^16.1.6) | 16.4.6 (declared ^16.4.6) | also `@next/env` and `@next/swc-*`, `sharp` 0.35.5 optional deps move with it |
| shell-quote (transitive) | 1.10.0 | 1.12.0 | same major, `npm update shell-quote`; advisory range ends at 1.10.0 |
| tar (transitive) | 6.2.1 | unchanged | DEFERRED |

No `eslint-config-next` or other `@next/*` package is declared in this repo.

## Deferred
- **tar** (advisory range `<=7.5.20`): no 6.x release is patched. The fix needs tar 7, reached only
  through `@capacitor/cli` 8.6.2 (npm marks it a semver-major fix; the repo has 6.2.2). A Capacitor
  major is out of scope here. Needs its own task. tar is a build-time CLI tool in apps/customer, not
  in the served app.
- **xlsx**: no fix exists. Untouched.
- drizzle-orm, zod, firebase majors: untouched.

## Next 16.4 notes
The docs shipped in `node_modules/next/dist/docs` (16.3.2) contain no 16.4 upgrade or deprecation
notes (only `version-16.md` for 15 to 16). 16.4.6 keeps the same peers (react ^19) and node >=20.9.
Nothing in this repo found affected.

## Checks (worktree wt-audit-t579; no `next build`, CI builds the PR)
- `npm audit` before: 1 low, 21 moderate, 12 high, 3 critical (37 total).
  After: 1 low, 21 moderate, 11 high, 1 critical (34 total); the remaining critical is `tar`.
- Root `npm run typecheck`: clean. `tsc --noEmit` in apps/pos and apps/customer: clean.
- apps/erp unit sample (action-link-sweep, flash, redirect-in-catch-sweep, button-icon-label): 4 files, 98 tests pass.
- Lockfile diff touches only next, @next/env, @next/swc-*, sharp and its @img platform packages, shell-quote.

DEF-847 stays open for xlsx (no fix) and any deferred majors (tar via @capacitor/cli).
