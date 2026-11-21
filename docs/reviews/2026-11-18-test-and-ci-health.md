# Test and CI health review, 2026-11-18

Read-only review of `wt-plans` (main). No Node was run. Everything marked MEASURED comes from GitHub run logs
(`gh run view`, 200 CI runs, 9 Nov to 18 Nov) or from the files. Everything marked EST is my estimate: re-measure before relying on it.

## 0. The numbers

| Fact | Value | Source |
|---|---|---|
| CI runs sampled | 200: 135 green, 33 red, 32 cancelled (superseded push) | MEASURED |
| Typical job (run 44227949014) | typecheck 72 s, unit 307 s, integration 1499 s, build 63 s, containers 22 s = 33.5 min, one job in series | MEASURED |
| Integration suite | 822 files, 14,827 tests, 1617 s wall; summed time: import 605 s, tests 2534 s, setup 18 s, transform 33 s | MEASURED |
| Integration spread across runs | 1259 s to 2069 s (1.6x) for the same suite | MEASURED |
| Migrations | applied ONCE per CI run: `db:migrate` 3 s; worker DBs cloned with `CREATE DATABASE ... TEMPLATE`: 0 s | MEASURED |
| Per merged change | PR run ~34 min, again on the push to main ~34 min, then Deploy ~7 min | MEASURED |
| Repo visibility | public (`gh repo view`): GitHub-hosted minutes are free | MEASURED |
| Red runs that were census/ratchet/pin/source-shape tests | about 17 of 33; 1 typecheck; the rest behaviour tests | MEASURED (read from FAIL lines) |
| Commits since 18 Oct touching the touch-target sweep or its baseline | 72 | MEASURED (`git log`) |
| Commits since 18 Oct touching bible, register, PAGES.md, caller baseline or editable baseline | 227 | MEASURED |

## 1. Flaky tests (red, then green on re-run, no code change)

Five re-runs went green: runs 44159075302, 44070565982, 43616319169, 43597000003, 43579854161. Each cost a full ~25 min integration re-run.

| Test | Failed in | Cause (read from the test) | Fix |
|---|---|---|---|
| `tests/integration/t394-s1-rehearsal.test.ts` 3.b (line ~123) | 44159075302 | Race. Test 3.a opens a decoy connection then `decoy.end()`; the server-side backend can outlive the client call by a few ms. 3.b then counts `pg_stat_activity` (n) and calls `checkLiveness` separately. If the decoy exits between the two reads, n=1 and `r.ok` is true: "expected true to be false". Also breaks if ANY other client touches that clone DB. | In 3.b poll until the other-session count is 0 (max 5 s) before asserting, or assert only "no session named `t394-decoy-app`". |
| `apps/erp/tests/integration/t527b-line-order.test.ts` line 35 | 44070565982 | Cause NOT proven. The sort key is (addedAtDevice, addedAt, id). The re-made head line copies a millisecond JS Date for `addedAt` (`order.ts` `mk`/`sameSpotId`) while siblings get microsecond `clock_timestamp()` (`pos-v2.ts:304`). The test uses the real clock in `makeIdGenerator(() => Date.now())`, so the result depends on which millisecond the ids and rows land in. | Prove it first: run the file in a 200x loop. Test fix: fixed clock for the id generator plus one advancing-clock case, and pass `addedAt` explicitly. Product fix: round both sides to one precision. |
| `packages/domain/tests/integration/t565-daypart-versions.test.ts` (lines 210 and the "taken exactly when the edit took effect" case) | 43616319169, 43546785993 (a main push, two different cases) | Clock granularity. `dbNow()` is `select now()` cut to a millisecond JS Date (`menu.ts:66`); versions and offers are stored at microseconds. `afterOffers()` waits for offers only, not for daypart `valid_from`. | Make the wait cover the latest `valid_from` of daypart versions too, or build fixtures with `valid_from` an hour in the past instead of sleeping. |
| `packages/domain/tests/integration/t525-pos-inbox.test.ts` line 1128 (ETag) | 43579854161 | Same family: a `pg_sleep` of "offer time + 2 ms" is a timing guess, not a guarantee. | Back-date the offers (older one at -1 h, newer at -30 min) and delete the sleep. |
| `packages/domain/tests/integration/t576-line-action-pin.test.ts` | 43597000003 | Tampered token changed the last base64 character, which carries padding bits, so 1 run in 16 left the bytes unchanged. | Already fixed on main (DEF-866 comment, first character is changed now). Verified in the file. |
| `tests/unit/deferral-staleness.test.ts` (5 s local timeout) | local only | The unit project has vitest's default 5 s test timeout; this test reads every `docs/tasks/*.md` synchronously, slow on a cold hard disk. `testTimeout: 30_000` exists only on the integration project. | `it(..., { timeout: 30_000 })`, or `testTimeout: 15_000` on `unit`. Same risk for `toc-freshness`, `t589-pages-ledger`. |

Family rule for builders: never decide "has this instant passed yet" by comparing a millisecond JS Date with a microsecond DB timestamp, and never fix it with a sleep.
Not flaky, but look flaky: `t546-pos-terminals`, `t380-s4-money`, `t440-s5-stock-refusals` each failed on 2 consecutive pushes. They were real regressions fixed by a later commit.

## 2. Speed

How the integration suite sets up its database (`vitest.config.mts`, `tests/integration/setup.ts`, `scripts/make-integration-worker-dbs.mjs`):
- Migrations once per run, not per file. Worker DBs are TEMPLATE clones. This is already good; do not spend effort here.
- Per file: a `beforeEach` truncate (144 files) and each file builds its own org/store/persons. `T-285` measured that one `TRUNCATE ... CASCADE` reaches 124 of 128 tables. Average is 0.17 s per test (2534 s / 14,827), so the truncate-and-seed cost, not Postgres query time, dominates.
- Import is 605 s of the summed time (19%): every file loads the large domain package.
- CI runs `INTEGRATION_WORKERS=2` and the comment says that number came from the old self-hosted 6 GB WSL box. The runner is GitHub-hosted again (desktop runner dropped 25 Oct), so the reason is stale.

Changes, in value order (details and savings in section 7):
1. Workers 2 to 4 on the hosted runner (documented spec for public repos: 4 vCPU, 16 GB; confirm with an `nproc` step first). Re-run `make-integration-worker-dbs.mjs 4`. Watch connections: the config comment budgets ~22 per worker, so 4 workers is ~88 of `max_connections=100`; set `DATABASE_POOL_MAX=10` for that step.
2. Split `verify` into parallel jobs: typecheck | unit | integration | build. Wall time becomes the longest job, not the sum.
3. Shard integration (`vitest run --project integration --shard=1/2`, then `2/2`), each shard its own Postgres service. Free on a public repo.
4. Local targeted runs (section 3 and the table below) so builders never start the 822.
5. Trial only: `isolate: false` for integration files that use no `vi.mock`, to cut import time. Risk: module state leaks between files. Do not adopt without a before/after run.

### If you changed X, run these (all paths from repo root; run unit first, integration second)

| You changed | Run first (no database) | Then (needs your own `_test` DB) |
|---|---|---|
| Money domain (`packages/core/src/money.ts`, `packages/domain/src/shared/money-*`) | `packages/core/tests/money-exact.test.ts`, `tests/unit/money.test.ts`, `packages/domain/src/shared/money-input.test.ts` | `tests/integration/posting-patterns.test.ts`, `tests/invariants/accounting-equation.test.ts`, `packages/domain/tests/integration/post-entry.test.ts` |
| Posting / journal (`postEntry`, accounts) | `tests/unit/posting-patterns-doc.test.ts`, `tests/unit/cutover-classification.test.ts` | the three above, plus `tests/invariants/journal.test.ts`, `packages/domain/tests/integration/period-override.test.ts` |
| Sales days | `packages/domain/tests/sales-day-routing.test.ts`, `apps/erp/tests/t339-sales-day-new-store-picker.test.ts` | `packages/domain/tests/integration/sales-days.test.ts`, `t369-s3-sales-day-edit-void.test.ts`, `t487-close-gate-sales-days.test.ts`, `apps/erp/tests/integration/t369-s3-sales-day-web.test.ts`, `t389-s3-sales-day-web.test.ts` |
| Settlements | `packages/auth/tests/t511-s2-settlement-capabilities.test.ts` | `packages/domain/tests/integration/channel-settlements.test.ts`, `t369-s9-settle-between-stores.test.ts`, `t415-settle-lock.test.ts`, `t511-s2-settlement-upload.test.ts`, `t511-s6a-fixes-settlement.test.ts` |
| Payroll | (none specific) | `packages/domain/tests/integration/payroll.test.ts`, `t436-leave-payroll.test.ts`, `t486-payroll-money-party.test.ts`, `apps/erp/tests/integration/t435-s1-payroll.test.ts`, `t486-payroll-picker.test.ts` |
| Stock | `tests/unit/t390-s2-plan-opening-stock.test.ts` | `packages/domain/tests/integration/stock-layers.test.ts`, `stock-movements-period-override.test.ts`, `stock-transfers.test.ts`, `low-stock.test.ts` |
| An ERP page (`apps/erp/src/app/**`) | the census set in section 4, plus `apps/erp/tests/action-link-sweep.test.ts` | that page's own `apps/erp/tests/integration/*<page>*.test.ts` (find with Glob) |
| A migration or a table | `tests/unit/cutover-classification.test.ts`, `tests/unit/rls-registry.test.ts` | `packages/db/tests/integration/rls.test.ts`, `t398-s1-same-org-fk-census.test.ts`, `t398-s4-derived-same-org.test.ts`, `t354-trigger-registry.test.ts`, then the FULL suite in CI (memory rule: full-suite-for-migrations) |
| A capability or permission | `tests/unit/capability-matrix.test.ts`, `tests/unit/route-capability-coverage.test.ts` | `packages/db/tests/integration/position-access-backfill.test.ts` |

Faster than a table: `npx vitest related <the files you edited> --run --project unit` and `--project integration` (vitest follows the import graph). Use it after the table, not instead of it, because the source-text census tests read files by path and `related` cannot see that link.

## 3. Low-memory local running (owner rule: never above 90% memory, keep 1.6 GB free of 15.6 GB)

Whole-repo `tsc --noEmit` measured 3.4 GB today (owner). Packages have NO tsconfig of their own: there are exactly four, root (includes apps/erp, packages, tests, scripts; excludes pos and customer), `apps/erp`, `apps/pos`, `apps/customer`.

Typecheck options, smallest first (memory figures except 3.4 GB are EST):
| Command | Covers | Memory |
|---|---|---|
| `npx tsc -p apps/pos/tsconfig.json --noEmit` | POS app (+ what it imports) | EST 1 to 1.5 GB |
| `npx tsc -p apps/customer/tsconfig.json --noEmit` | customer app | EST 1 to 1.5 GB |
| `npx tsc -p apps/erp/tsconfig.json --noEmit` | ERP app plus the domain/db/auth/core it imports; NOT `tests/`, `scripts/` | EST 2 to 2.8 GB |
| `npm run typecheck` (root) | everything | 3.4 GB MEASURED |
Guard every run with `NODE_OPTIONS=--max-old-space-size=3072` (PowerShell: `$env:NODE_OPTIONS='--max-old-space-size=3072'`): a runaway fails loudly instead of eating the last 1.6 GB. The root run needs 4096 and is the CI job's (`ci.yml` already sets it): leave it to CI unless you changed `packages/core`, `packages/db/schema` or a domain export used by tests/scripts. Suggested follow-up: add `tsconfig.packages.json` (include only `packages/**`) so a domain-only change has a 2 GB option.

Vitest (v4.1.8; default pool is `forks`, one Node process per worker; keep it, `threads` shares heap and leaks mocks between files):
| Run | Flags | EST memory |
|---|---|---|
| A few unit files | `npx vitest run --project unit --maxWorkers=1 <files>` | 0.6 to 0.9 GB |
| Whole unit project | `npx vitest run --project unit --maxWorkers=2` (never more) | 1.2 to 1.8 GB, 855 files, ~5 min on CI hardware, much longer on this disk |
| A few integration files | `npx vitest run --project integration <files>` (leave `INTEGRATION_WORKERS` unset = one worker, serial) | 0.9 to 1.3 GB plus the local Postgres (EST 0.3 to 0.6 GB) |
| Isolated hostile-xlsx file | `unit-isolated` is capped at 512 MB heap already | leave to CI |
Rules: one heavy process at a time (never tsc and vitest together; never `next dev` or `next build` alongside); check free memory before and between runs (`(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB` gives free GB; stop below 3 GB before a tsc run, below 2.5 GB before a vitest run, EST thresholds = 1.6 GB reserve + run cost); close the browser first; look for leftover `node` processes after every run (`Get-Process node | Measure-Object WorkingSet -Sum`). `tests/unit/t402-s1a-action-coverage.test.ts` runs `git log -p` over history with a 1 GB buffer: it is the one unit test that can spike memory by itself, so run it alone and never in a batch.
Leave to CI: the full integration suite, root typecheck, `npm run build`, POS/customer Capacitor builds, the full unit project, anything that needs 4 workers, the migration-gated full suite. One-off: measure the real worker cost once (Task Manager peak while a 2-worker unit run is going) and replace the EST column.

## 4. Census and pin tests (cause most merge conflicts)

There is NO single re-measure script. Most baselines are hand-edited JSON/number literals, "orchestrator-owned". The only real generators are `npm run toc` and `scripts/production-caller-census.mjs --names`.

| Test | What it pins | Re-measure | Touched by |
|---|---|---|---|
| `apps/erp/tests/action-link-sweep.test.ts` (645 lines, mostly a comment diary) + `touch-target-baseline.json` | total control count (`expect(results.length).toBe(1686)`, line 568), FAIL and UNRESOLVED buckets, per-file multiset | `runCensus()` from `touch-target-geometry.ts`, run through the test itself, then hand-edit | any page/component that adds, removes or restyles a link, button or input. 72 commits in 31 days |
| `apps/erp/tests/t384-s2-full-width.test.ts` + `form-width-baseline.json`, `form-grid-baseline.json` | fixed-width controls outside `<td>`, forms without FormGrid; ratchet down only | the test's failure message prints the count | form markup; failed CI 3 times on 16 Nov |
| `t384-s3-lock-and-save-guard.test.ts` + `editable-record-baseline.json`, `submit-label-baseline.json` | raw record forms not in `EditableRecord`, odd submit labels | failure message | any form on a record page; failed 2x |
| `t389-keep-typing-guard.test.ts`, `t440-s2-live-check-guard.test.ts` + `live-check-baseline.json`, `typed-baseline.json` | EditableRecord lacking typed/keepTyping; unconverted ruled controls | failure message | form conversion work; failed 4x |
| `t440-s3/s5-*rules*.test.ts` ("table covers exactly the rules that exist") | one fixture row per field rule | add a row | adding a field rule in `packages/domain/src/field-rules` |
| `apps/erp/tests/t589-pages-ledger.test.ts` + `docs/ui-review/PAGES.md` | one row per `page.tsx` | add the row by hand | any new, moved or deleted page |
| `tests/unit/t343-throw-ratchet.test.ts`, `t343-s5-throw-census.test.ts` | raw `throw new Error(` count per `packages/domain/src` directory | failure message gives the count | adding a directory (needs a CEILINGS entry) or a throw |
| `tests/unit/production-caller-ratchet.test.ts` + `docs/production-caller-baseline.txt` | set of exports with no production caller | `node scripts/production-caller-census.mjs --names` | adding an export nothing calls yet |
| `tests/unit/domain-actions-have-callers.test.ts` | every action-shaped domain export reachable from a screen or exempted | add an EXEMPT line | new domain action before its screen exists |
| `packages/db/tests/integration/t398-s1-same-org-fk-census.test.ts`, `t398-s4-derived-same-org.test.ts` | every cross-org FK and jsonb column declared; trigger registry size "55 entries" | edit `same-org-fk-exemptions.ts`, `triggers/registry.ts` and the pinned value | any migration adding an FK, jsonb column or trigger |
| `tests/unit/register-row-shape.test.ts` | column count of every `DEF-NNN` row | count pipes in the row | any edit of `docs/DEFECTS-REGISTER.md` (a `|` inside prose breaks it) |
| `tests/unit/toc-freshness.test.ts` | line-range TOC of the bible and POSTING-PATTERNS | `npm run toc` | any edit of `PROJECT_BIBLE.md` or `docs/POSTING-PATTERNS.md` |
| `tests/unit/cutover-classification.test.ts`, `rls-registry.test.ts` | every new table classified | edit the two registry files | any new table |

Reduce conflicts: (a) move the totals out of the test source into one `census-totals.json` plus an `npm run census:write` that re-measures and rewrites it (the sweep test then has no number to merge); (b) delete the per-change comment diary (git log holds it); (c) make each builder list in the task spec which census files it will touch, and give one owner the merge order; (d) run the whole census set as a separate first CI job (about 20 s) so a red census does not wait behind 5 minutes of unit tests.

## 5. Tests that prove little

- Source-text tests guarding behaviour: 96 non-integration and 87 integration test files call `readFileSync`; not all read source (some read fixtures or migrations), but names like `t511-s2b-source-shape` ("adds no second EditableRecord"), `t540-page-header-sweep`, `t348-page-description-sweep`, `t452-card-form-spacing`, `t384-s2-full-width` assert a spelling of the source, not what a user sees. They went red in about 17 of 33 failed runs, almost always from legitimate edits. Keep the real invariants (`no-committed-secrets`, `no-client-supplied-actor`, `app-boundaries`, `no-direct-transaction-in-erp`). Move the layout/spelling ones to the fast census job, where a failure is cheap, and prefer a rendered test.
- No test file without an assertion keyword was found (coarse grep for expect/assert/toThrow).
- Skipped or todo: two `it.todo` (`packages/domain/tests/integration/t442-backfill-file-links.test.ts:654`, `t531-posting.test.ts:144`); two silent conditional skips in `tests/unit/t402-s1a-action-coverage.test.ts:132,141` (skips when the clone is shallow or git fails: CI uses `fetch-depth: 0`, local shallow clones silently skip). No `.only(` / `.skip(` calls found.
- Pinned to one database: none requires a lane DB. `setup.ts` only requires `_test` in the name (a guard, correct). Comments in `remittance.test.ts:1183` and `rls.test.ts:530` describe lane-DB runs; I did not review the other 7 files my pattern flagged line by line.

## 6. CI workflow (`.github/workflows/ci.yml`, `app-build.yml`, `deploy.yml`)

- Cache: `setup-node` with `cache: npm` is on (install 10 s). Nothing caches `.next/cache`, so the 63 s CI build and the Deploy build both start cold. Minor (about 20 s each).
- Duplicate work: (1) the push to `main` re-runs the full 34 min suite already green on the PR; Deploy waits for it. (2) Deploy runs `npm ci` and rebuilds ERP, POS and customer after CI built ERP: the repo rule is "build once, deploy many". (3) POS and customer have their own typecheck and build jobs (about 3 min, parallel, fine).
- Serial steps that could be parallel jobs: typecheck (72 s), unit (307 s), integration (1499 s), build (63 s) all run in ONE job one after another. Four jobs would make wall time equal to the longest. Customer integration is 7 s: fine.
- Docs-only PRs: integration and build are already skipped. The remaining ~7 min (measured 03:34:43 to 03:41:49) is typecheck 72 s plus unit 297 s. Markdown cannot break `tsc`, so typecheck can be skipped when `docs_only=true`; unit must stay (it holds the TOC, register-shape, glossary and bible tests). Saves about 1.5 min only: low priority.
- `concurrency` with cancel-in-progress is correct (32 cancelled runs were superseded pushes).
- Minutes: about 75 billed minutes per merged change (PR 34 + main 34 + Deploy 7), free because the repo is public. Wall time is what hurts: a builder waits about 34 min for a PR.

## 7. Ranked improvements (wall-clock saving per PR; EST unless stated)

| # | Change | Saving | Effort and risk |
|---|---|---|---|
| 1 | Split `verify` into parallel jobs (typecheck, unit, integration, build) | 33.5 to ~25 min (-8 min: unit 5 + typecheck 1.2 + build 1) | 1 hour; each job repeats install (10 s) and container start (22 s) |
| 2 | Integration workers 2 to 4 (hosted runner) | 25 to ~14 min (EST, DB-bound work may give less) | one line plus pool cap; confirm `nproc` and connection budget first |
| 3 | Shard integration 2 jobs x 4 workers | to ~8 to 10 min total with 1 and 2 | each shard needs migrations (3 s) and its own DB clones; free on public repo |
| 4 | Fix the 5 flakes (section 1) | removes about 5 re-runs per month x ~27 min = ~135 min of waiting, plus trust | 1 to 2 hours; t527b needs a reproduction loop first |
| 5 | Census totals into one generated JSON, delete the comment diary, census as a 20 s first job | fewer red runs (about half of 33) and fewer merge conflicts; red in 20 s not 5 min | half a day; touches the 6 census tests |
| 6 | Local: `related`/targeted runs, `testTimeout` 15 s on `unit`, tsc per app with a heap cap | a builder runs about 5 files (minutes) not 822; avoids the 5 s timeout flake | trivial |
| 7 | Deploy reuses CI's build artifact instead of rebuilding | about 3 min per deploy | medium; must keep "never build on a droplet" |
| 8 | Skip typecheck on docs-only | about 1.5 min on docs PRs | trivial |
| 9 | Main-push run: skip heavy steps when the PR head tree equals the merge tree | up to 34 min of deploy lag | needs a decision from Ian (merge-queue, up-to-date requirement): do not do silently |

## 8. Builder test recipe (one page)

Before you start: `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB` must show at least 3 GB free. Stop `next dev`. Close the browser. One heavy process at a time.

1. After each edit: `npx vitest related <edited src files> --run --project unit --maxWorkers=1`
2. Census set for any page/form/domain-directory/doc/table change: `npx vitest run --project unit --maxWorkers=1 apps/erp/tests/action-link-sweep.test.ts apps/erp/tests/t384-s2-full-width.test.ts apps/erp/tests/t384-s3-lock-and-save-guard.test.ts apps/erp/tests/t589-pages-ledger.test.ts tests/unit/t343-throw-ratchet.test.ts tests/unit/register-row-shape.test.ts tests/unit/toc-freshness.test.ts tests/unit/cutover-classification.test.ts`
3. Typecheck the app you touched with a cap: `$env:NODE_OPTIONS='--max-old-space-size=3072'; npx tsc -p apps/erp/tsconfig.json --noEmit` (or apps/pos, apps/customer). Never root unless asked.
4. Integration, your own `_test` database, one worker, only the files from the "changed X" table: `npx vitest run --project integration <file1> <file2>`
5. Hand to CI: root typecheck, full unit, full integration, build, migrations. If a red CI test is in sections 1 or 4, say so in the PR; do not just re-run.
