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
