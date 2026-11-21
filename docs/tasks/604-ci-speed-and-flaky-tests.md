# T-604 — CI speed, flaky tests, one census command, builder test recipe

Status: SPEC (Opus), 2026-11-18. Source: `docs/reviews/2026-11-18-test-and-ci-health.md` (claims re-checked below).
Risk: **medium** (CI and tests only; no product code except the S1d candidate fix, no migration, no bible change).
Builder: Sonnet, one slice per commit/PR. Line numbers are main bc30e0b. Repo is PUBLIC; `main` protection requires
exactly one status check, `typecheck, test, build` (GitHub Actions app 15368), `strict: false` (read with `gh api`).

## Review claims that are wrong or stale (do not build from them)
| Claim | Fact |
|---|---|
| t565 and t525 flake: "back-date the fixtures, remove the sleeps" | **Impossible and already fixed.** Offers refuse a back-dated `effective_from` (trigger, `0196_t401_menu_catalog.sql:581,596`); daypart versions are stamped by trigger at `date_trunc('ms', now())` (`0253:126`). Both failures (runs 43546785993, 43616319169 attempt 1; 43579854161 attempt 1) predate the fixes `b442010` (#263, t525) and `140d31a` (#268, t565). Zero recurrences in the 23 red runs and 0 re-runs since 15 Nov. The remaining `pg_sleep` is a wait bounded by the DB's own clock, not a guess. **No change.** |
| t394 3.b: only the decoy outliving `end()` | Also a **second race**: the test counts every backend (`t394…:121`) but `checkLiveness` counts only `backend_type = 'client backend'` (`scripts/lib/rehearsal/checks.ts:23`). An autovacuum worker on the fresh clone gives the same "expected true to be false". |
| "Set `DATABASE_POOL_MAX=10` for 4 workers" | 10 is already the default (`packages/core/src/env.ts:53`). T-400 §4 says `'4'`. |
| Docs-only: "unit holds the doc tests, skip typecheck only" | Right, and a grep-selected unit subset is NOT safe: `tests/unit/toc-freshness.test.ts` matches no docs pattern. Keep the full unit job. |
| Recipe table names `tests/invariants/journal.test.ts` | Does not exist. `tests/invariants/` holds only `accounting-equation.test.ts`. |
| Review never mentions | `tests/unit/ci-app-jobs.test.ts:39-52` pins the `verify` job by SHA-256, `:82-84` pins `deploy.yml`, and `tests/unit/ci-env-contract.test.ts:66` reads the env block of job `verify`. Every S2/S6 edit must update these in the same commit. |

## S1 — Flaky tests (first: each one costs a ~27 min re-run and trust)
**S1a `tests/integration/t394-s1-rehearsal.test.ts:119-125`** (3.b). Replace the body with:
```ts
  it('3.b with the decoy gone the verdict equals "no other session exists" (own pid excluded)', async () => {
    // 3.a's decoy backend can outlive decoy.end() by a few ms: wait (DB condition, max 5 s) for it to leave.
    for (let i = 0; i < 100; i++) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = current_database() and application_name = 't394-decoy-app'`;
      if (n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Same filter as checkLiveness: autovacuum and other background workers are not "sessions".
    const n = (await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`)[0]!.n;
```
(the two `expect` lines stay). Mutant: drop the `backend_type` filter, open a second `postgres(cloneUrl)` client with
another name before the count → red. Proof: S1e loop on this file, 200/200 green.

**S1b t565 / t525:** no change (table above). Close as "fixed by #263/#268"; S1e may loop them once (200/200) for the record.

**S1c `vitest.config.mts`, unit project (lines 108-138):** add `testTimeout: 15_000,` after `setupFiles` (line 136).
Covers `deferral-staleness` (reads all 499 task files + register), `toc-freshness`, `t589-pages-ledger` on a cold disk.
Do not touch integration (30 s stays). Proof: three cold local runs of `deferral-staleness` pass; CI unit time unchanged.

**S1d `apps/erp/tests/integration/t527b-line-order.test.ts:35`.** Likely cause: the re-made package line copies the
replaced line's `addedAt` as a millisecond JS Date (`packages/domain/src/pos/order.ts:398-418` `place.addedAt`, called
at 433) while its siblings got microsecond `clock_timestamp()` (`packages/db/src/repo/pos-v2.ts:304`); the bill orders by
(addedAtDevice, addedAt, id) (`pos-v2.ts:88`, via `loadLiveLines`, `shared.ts:162`). **Unproven, and it has a gap:**
all three lines go in one multi-row insert (`order.ts:254`), so if truncation were the whole story the test would fail
almost every run; it failed once in ~200. Prove first (S1e, 200 runs, with the diagnostic below), then fix.
- Diagnostic (loop branch only): on failure, print `select id, kind, added_at::text, added_at_device::text from table_session_lines where session_id = …`.
- Candidate product fix (only if the dump shows a truncated `added_at`): `NewSessionLine` gains `addedAtOf?: string`
  (a line id); `insertLines` maps it to `` sql`(select added_at from table_session_lines where id = ${r.addedAtOf})` ``;
  `followHeads` passes `addedAtOf: perHead.id` instead of `addedAt`. SQL stays in the repo (RULES). No test change.
- Done: 200/200 green after the fix, and a red run when the fix is reverted (if the loop could reproduce it).

**S1e — CI-only reproduction loop.** New `.github/workflows/flake-loop.yml`, `workflow_dispatch` only (never on PRs):
inputs `file` (string) and `runs` (default 200). Matrix `part: [1,2,3,4]`, `fail-fast: false`, `timeout-minutes: 60`.
Same `services.postgres`, env and DB-prep steps as the S2 `integration` job (role, migrate, PG18 client; no worker
DBs, one worker). Step: `fails=0; for i in $(seq $((RUNS/4))); do npx vitest run --project integration "$FILE" || fails=$((fails+1)); done; echo "::notice::$fails failures in $((RUNS/4)) runs"; [ $fails -eq 0 ]`.
Run with `gh workflow run flake-loop.yml -f file=<path>`; read with `gh run view`. Record "N/200" in the commit message.

## S2 — Split the one `verify` job into parallel jobs (biggest wall-time win)
Measured baseline (run 44227949014): one job, 33 min 21 s: containers 22 s, install 10 s, typecheck 72 s, unit 307 s,
migrate 3 s, integration 1499 s (2 workers), customer integration 7 s, build 63 s.

`.github/workflows/ci.yml`: lines 1-133 (`on`, `concurrency`, `changes`) and 256-275 (app jobs) unchanged. Replace
lines 134-254 with the jobs below. Unchanged step bodies are referenced, not repeated: copy them byte for byte.
```yaml
  typecheck:
    name: typecheck
    needs: changes
    if: needs.changes.outputs.docs_only != 'true'
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: npm }
      - run: npm ci --no-audit --no-fund
      # DEF-631 comment (current line 182) moves here unchanged
      - name: Typecheck
        run: npm run typecheck
        env:
          NODE_OPTIONS: --max-old-space-size=4096

  unit:
    name: unit
    needs: changes          # runs on docs-only too: the doc guards live here (S3)
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    env: &ci_env
      # the 13 env lines of current 152-165, unchanged (comment line included)
    steps:
      # checkout with fetch-depth: 0 + its DEF-432 comment (current 168-172), setup-node, Install (current 174-180)
      - name: Unit tests
        run: npm run test

  integration:
    name: integration ${{ matrix.shard }}
    needs: changes
    if: needs.changes.outputs.docs_only != 'true'
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2]
    services:
      # postgres block of current 139-150, unchanged
    env: *ci_env
    steps:
      # checkout (fetch-depth: 0), setup-node, Install as in unit
      # "Provision restricted test role", "Apply migrations": current 191-210 with their comments, minus the docs_only `if:` lines
      # T-604: hosted runner (4 vCPU, 16 GB on a public repo); each shard has its own Postgres, so 4 workers x pool 4 stays far under 100 connections.
      - name: Create integration worker DBs (T-400)
        run: node scripts/make-integration-worker-dbs.mjs 4
      # "PostgreSQL 18 client (T-393)": current 219-234, minus the `if:` line
      - name: Integration tests (real Postgres)
        env:
          INTEGRATION_WORKERS: '4'
          DATABASE_POOL_MAX: '4'
        run: npm run test:integration -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}
      # >>> Customer lobby
      # T-455 comment lines (current 243-244) unchanged
      - name: Customer server integration tests (real Postgres)
        if: matrix.shard == 1
        run: npm run test:integration -w @shareat/customer
      # <<< Customer lobby

  build:
    name: build
    needs: changes
    if: needs.changes.outputs.docs_only != 'true'
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    env: *ci_env
    steps:
      # checkout, setup-node, Install as in typecheck
      - uses: actions/cache@v4
        with:
          path: apps/erp/.next/cache
          key: next-erp-${{ hashFiles('package-lock.json') }}-${{ github.sha }}
          restore-keys: next-erp-${{ hashFiles('package-lock.json') }}-
      # PROJECT_BIBLE.md §2 rule 10 comment (current 250-251) unchanged
      - name: Build
        run: npm run build

  # T-604: the ONE required check. Branch protection requires the name "typecheck, test, build", so this gate keeps it
  # while the work runs in parallel. `if: always()` is load-bearing: a gate skipped after a failed job reports SUCCESS.
  verify:
    name: typecheck, test, build
    needs: [changes, typecheck, unit, integration, build]
    if: always()
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    steps:
      - name: Every job passed (a skip counts only on a docs-only change)
        env:
          NEEDS: ${{ toJSON(needs) }}
          DOCS_ONLY: ${{ needs.changes.outputs.docs_only }}
        run: |
          echo "$NEEDS" | jq -e --arg docs "$DOCS_ONLY" '
            .changes.result == "success" and .unit.result == "success" and
            ([.typecheck, .integration, .build] | all(.result == "success" or (.result == "skipped" and $docs == "true")))'
```
YAML anchors (`&ci_env` / `*ci_env`) are supported by GitHub Actions; if the first run rejects them, paste the env block
literally into the three jobs. Cache keys: npm via `setup-node cache: npm` (keyed on `package-lock.json`, as today);
`.next/cache` as above. `needs.integration.result` is `failure` if either shard fails.

Tests to update in the same commit:
- `tests/unit/ci-env-contract.test.ts:66`: `extractJobEnvBlock(workflow, 'verify')` → `'unit'` (and the describe title).
- `tests/unit/ci-app-jobs.test.ts:39-52`: replace the 9c1704b hash case with (1) a new SHA pin of the `verify` gate block
  (take the value from the failure message), (2) the gate's `name:` is exactly `typecheck, test, build`, (3) it has
  `if: always()` and `needs:` lists all five jobs, (4) `unit` has no `if:`. Mutants: drop `if: always()`; drop `build`
  from `needs` → red. The docs-only step pin (`:54-66`) must stay green untouched.

Risks: a failed job hidden by a skipped gate (closed by `if: always()` + the jq check + the test); build without Postgres
(today it ran with the server up; if `next build` reaches the DB it fails loudly: then add the service to `build`);
unit without Postgres (it runs before migrations today, so no test may need tables; same loud failure); more than 4
connections in one worker (`too many clients` is loud; T-400 §4 names `t390-s1-opening-counts-per-room.test.ts:486`);
shard imbalance (vitest splits by file, not time: check both shard durations).

Expected (EST, measure with `gh run view <id> --json jobs` on 5 PR runs before and after): wall 33.5 → **10-12 min**
(integration shard ≈ 1499/2/1.6 s + 1.5 min setup ≈ 9 min; unit ≈ 6.5 min). Billed minutes about the same (~33/run).

**Repo visibility (owner may change it).** Public (today): standard runner 4 vCPU / 16 GB, minutes free; use the YAML
above. **Private:** standard runner 2 vCPU / ~7 GB and 2,000 free minutes a month (Free; 3,000 Pro/Team). Change to
`shard: [1, 2, 3]`, `make-integration-worker-dbs.mjs 2`, `INTEGRATION_WORKERS: '2'` (wall EST 11-13 min). The bill is
the real problem: ~22 runs/day (200 runs in 9 days) × ~35-45 min ≈ 25,000-30,000 min/month, 10x the free allowance
(paid Linux minutes roughly $0.006-0.008; check the billing page). And **on GitHub Free, branch protection does not
exist on private repos**, so the required check would silently stop guarding `main`. Going private needs a paid plan
plus the main-push decision (Q1) plus docs-only skips, or a self-hosted runner on an SSD.

## S3 — Docs-only PRs (falls out of S2; small saving)
Keep the existing `changes` classification (`ci.yml:93-102`, SHA-pinned, untouched): docs-only = every changed path is
`*.md` anywhere or under `docs/`, EXCEPT `docs/ops/**` (provision script, systemd units) and
`docs/production-caller-baseline.txt` (a test baseline). Any uncertainty fails open to "not docs-only".
On docs-only: `typecheck`, `integration`, `build` are skipped (S2 `if:`), `unit` runs in full, the gate accepts the
skips. The full unit project carries the doc guards: `register-row-shape`, `toc-freshness` (bible and POSTING-PATTERNS
TOC), `apps/erp/tests/t589-pages-ledger` (PAGES.md), `deferral-staleness`, `posting-patterns-doc`, `production-caller-ratchet`.
Rejected: a grep-selected unit subset (misses `toc-freshness`, proven by grep). Saving: docs PR ~7 min → ~6.5 min wall
(typecheck no longer runs; unit was already the long pole). Risk: none new; push to `main` follows the same rule as today.

## S4 — One census command: `npm run census:write`
About 17 of 33 red runs were these pins. New `scripts/census-write.mjs` (+ `"census:write"` in root `package.json`):
refuses to run when `process.env.CI` is set; sets `CENSUS_WRITE=1`; runs, one at a time, `npm run toc`, then
`npx vitest run --project unit --maxWorkers=1 <the unit census files below>`; prints every `NEEDS APPROVAL` line at the end.
Each census test gains one branch: when `CENSUS_WRITE=1`, write the measured value to its file, then assert as usual.
**Ratchets only tighten in write mode**: a lower count is written; a higher count or a new entry is NOT written, it
prints `NEEDS APPROVAL: <file> <key> <old> -> <new>` and the test stays red (a raise is a human decision, as today).

| Pin (test) | Measured by today | Writes (after T-604) |
|---|---|---|
| Touch targets: `apps/erp/tests/action-link-sweep.test.ts` (`toBe(1686)` :568 and the FAIL/UNRESOLVED totals) | `runCensus()` (`touch-target-geometry.ts`) inside the test; totals hand-edited | `touch-target-baseline.json`: per-file multisets (shrink only) + new `"_totals"` object (moved out of the test source; written freely). Delete the per-change comment diary around the totals; git log holds it |
| Form width / grid: `t384-s2-full-width.test.ts` | the test; failure message | `form-width-baseline.json`, `form-grid-baseline.json` (down only) |
| Editable record / submit label: `t384-s3-lock-and-save-guard.test.ts:431-458` | the test's `ratchet()`; failure message | `editable-record-baseline.json`, `submit-label-baseline.json` (down only; stale entries removed) |
| Live check / typed: `t389-keep-typing-guard`, `t440-s2-live-check-guard` | failure message | `live-check-baseline.json`, `typed-baseline.json` (down only) |
| Throw ratchet: `tests/unit/t343-throw-ratchet.test.ts` (`CEILINGS` :66, `measure()` :212) | `measure()` in the test | new `tests/unit/t343-throw-ceilings.json` (CEILINGS moved out); lowered to actual; a new directory is added only at 0 |
| Production callers: `production-caller-ratchet` | `node scripts/production-caller-census.mjs --names` (prints) | `docs/production-caller-baseline.txt`: removals only |
| Pages ledger: `apps/erp/tests/t589-pages-ledger.test.ts` | none (hand-added rows) | `docs/ui-review/PAGES.md`: appends a row per missing `page.tsx` with status `not reviewed` (a known status, :13), same column count as existing rows; never deletes |
| Bible / POSTING-PATTERNS TOC: `toc-freshness` | `npm run toc` | the two docs (already) |
| Same-org census: `packages/db/tests/integration/t398-s1…`, `t398-s4…` | integration, needs a DB | **not automated**: each new FK/jsonb/trigger needs a guard-or-exempt decision; the failure names it |
| Register rows: `register-row-shape` | none | not automated (a `|` in prose needs a human fix) |

Proof: on a branch, delete one baseline entry and add one page; `npm run census:write` restores both and the census set is green;
add one raw `throw new Error(` in a domain directory → write mode prints NEEDS APPROVAL and stays red. Measure: count census-only red
runs in the 30 days after vs the 17/33 before (`gh run view --log-failed`, FAIL lines).
Risk: write mode used to bury a regression. Closed by down-only writes, the CI refusal, and the JSON diff in review.

## S5 — Builder test recipe: save the block below verbatim as `docs/BUILDER-TEST-RECIPE.md`
````markdown
# Builder test recipe (memory-limited laptop)

This laptop has 15.6 GB. Never go above 90%: keep 1.6 GB free. CI runs the full suite; you run only what you touched.

## Before any test or typecheck
- Free memory, in PowerShell: `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB` (GB free).
  Need 3 GB free before `tsc`, 2.5 GB before `vitest`. Less? Close the browser and stop `next dev` first.
- One heavy process at a time: never `tsc` and `vitest` together, never beside `next dev` or `next build`.
- After each run, check for leftovers: `Get-Process node -ErrorAction SilentlyContinue | Measure-Object WorkingSet -Sum`.
- Cap every Node run: `$env:NODE_OPTIONS='--max-old-space-size=3072'` (a runaway then fails instead of eating the reserve).

## Order of work
1. After each edit: `npx vitest related <edited files> --run --project unit --maxWorkers=1`
2. Census set, if you touched a page, form, domain directory, doc or table: `npm run census:write`, then commit the files it changed.
   It never raises a ceiling; a `NEEDS APPROVAL` line goes in your PR description.
3. Typecheck only the app you touched (EST memory): `npx tsc -p apps/erp/tsconfig.json --noEmit` (2-2.8 GB; covers ERP
   plus the packages it imports, not `tests/` or `scripts/`), `apps/pos/...` or `apps/customer/...` (1-1.5 GB).
   Root `npm run typecheck` takes 3.4 GB: leave it to CI.
4. Integration, your own database whose name contains `_test`, one worker (leave `INTEGRATION_WORKERS` unset):
   `npx vitest run --project integration <file1> <file2>` (the files from the table below).
5. Push. CI runs root typecheck, full unit, full integration (2 shards), build. A red test listed in
   `docs/tasks/604-ci-speed-and-flaky-tests.md` S1 is a known flake: say so in the PR, do not just re-run.

## If you changed X, run these (unit first, then integration)
| You changed | Unit (no database) | Integration (`_test` database) |
|---|---|---|
| Money (`packages/core/src/money.ts`, `packages/domain/src/shared/money-*`) | `packages/core/tests/money-exact.test.ts`, `tests/unit/money.test.ts`, `packages/domain/src/shared/money-input.test.ts` | `tests/integration/posting-patterns.test.ts`, `tests/invariants/accounting-equation.test.ts`, `packages/domain/tests/integration/post-entry.test.ts` |
| Posting / journal | `tests/unit/posting-patterns-doc.test.ts`, `tests/unit/cutover-classification.test.ts` | the money three, plus `packages/domain/tests/integration/period-override.test.ts` |
| Sales days | `packages/domain/tests/sales-day-routing.test.ts` | `packages/domain/tests/integration/sales-days.test.ts` |
| Settlements | `packages/auth/tests/t511-s2-settlement-capabilities.test.ts` | `packages/domain/tests/integration/channel-settlements.test.ts` |
| Payroll | none | `packages/domain/tests/integration/payroll.test.ts` |
| Stock | `tests/unit/t390-s2-plan-opening-stock.test.ts` | `packages/domain/tests/integration/stock-layers.test.ts`, `stock-transfers.test.ts` |
| An ERP page | `npm run census:write`, `apps/erp/tests/action-link-sweep.test.ts` | that page's `apps/erp/tests/integration/*<page>*.test.ts` |
| A table or migration | `tests/unit/cutover-classification.test.ts`, `tests/unit/rls-registry.test.ts` | `packages/db/tests/integration/rls.test.ts`, `t354-trigger-registry.test.ts`, `t398-s1-same-org-fk-census.test.ts`; then the FULL suite in CI |
| A capability | `tests/unit/capability-matrix.test.ts`, `tests/unit/route-capability-coverage.test.ts` | `packages/db/tests/integration/position-access-backfill.test.ts` |
`vitest related` follows imports only; tests that read source files by path (the census set) need step 2.

## Run alone, never in a batch
`npx vitest run --project unit --maxWorkers=1 tests/unit/t402-s1a-action-coverage.test.ts`: it reads the whole git
history with a 1 GB buffer. In a shallow clone it skips itself silently; CI has full history.

## Leave to CI
Full unit project, full integration suite, root typecheck, `npm run build`, POS/customer app builds, `unit-isolated`
(hostile xlsx files), any run that needs more than one worker, and the full suite a migration needs.
````
Proof: a builder follows it on one task and stays under 90% (Task Manager peak noted in the PR).

## S6 — Deploy reuses the CI build: NOT small; named follow-up
Reasons: `NEXT_PUBLIC_FIREBASE_*` are inlined at build time and CI builds with `ci` placeholders (`ci.yml:161-165`);
PR runs cannot hold real secrets; Deploy also builds POS and customer web (`deploy.yml:102-116`) and writes the
revision before building (`:81-84`); `deploy.yml` is SHA-pinned (`ci-app-jobs.test.ts:82-84`). Follow-up **T-605**
(deploy reuses the CI build): on `push` to `main` only, the `build` job builds with the real secrets plus POS/customer, uploads the packaged
tarball with `actions/upload-artifact`; Deploy downloads it by `workflow_run.id` instead of `npm ci` + 3 builds. Saves
~3 min per deploy. Still "never build on a droplet".

## Build order
1. S1a + S1c (one commit, unit + one integration file). 2. S1e loop workflow; run it on t394 and t527b. 3. S2 (+S3 falls
out) with the two test updates; first PR run is the measurement. 4. S1d fix once the loop shows the cause. 5. S4.
6. S5 doc (after S4, it names `census:write`). S6 later, as T-605.

## Rulings (BOSS, 18 Nov)
R1 (Q1). Keep the full re-run on every push to `main` (`strict: false`: the main run is the only check of the merged tree).
R2 (Q3). `census:write` may lower baselines automatically; a raise or new entry prints `NEEDS APPROVAL` and the command
exits non-zero (`scripts/census-write.mjs` sets a failing exit code whenever it printed a NEEDS APPROVAL line).
R3. The S6 follow-up is **T-605** (deploy reuses the CI build).

## Open question (owner)
- Q2. Public or private repo: the owner's call, still open; both plans stay in S2. Recommendation: stay public while
  builders lean on CI; private needs a paid plan for branch protection and roughly 10x the free minutes.
