# Scheduler
## Overview
The scheduled-job runners (T-140, the live half of DEF-044): month-end depreciation and amortisation, the attendance sweep, Firestore mirror publish and inbox relay, order-wastage backstop, finding observation, budget reissue, orphan-file sweep, fiscal-period seed and usage auto-post. Each runner is a thin loop over orgs that records itself in `scheduler_runs`, so "ran with nothing to do" is distinguishable from "never ran".

## Interface
- `runJobForOrg(org, job, period, trigger, work, startedAt?)`: the single seam every job uses; never throws, returns a `JobOutcome`.
- `runMonthEnd(options)`, `lastCompletedPeriod`, `listOrgsToRun`, types `MonthEndOptions`, `JobOutcome`, `MonthEndResult`.
- `runAttendanceSweep`, type `SweepResult`.
- `runFirestoreRelay`, type `RelayResult`.
- `runOrderWastageBackstopSweep`, type `OrderWastageBackstopResult`.
- `runFindingObservation`.
- `runBudgetReissue`.
- `runOrphanFileSweep`, type `OrphanFileSweepResult`.
- `runFiscalPeriodSeed`.
- `usageAutoPostSweep`, types `UsageAutoPostOutcome`, `UsageAutoPostSweepResult`.

## Invariants
- Every run writes a `scheduler_runs` row even when it posts nothing: a failed month and a run that never happened leave no other trace.
- `runJobForOrg` never throws, so a failing org or record never stops the next org; it guards three failure points (`startRun` refused, `work()` threw, `finishRun` threw after commit).
- `hadFailures` is true on any failure so the CLI exits non-zero and the host cron/systemd notices.
- `inbox_relay` adjudication failures are reported separately from `failed` (the punch itself landed).
- The system principal is applied inside each per-item transaction (`withSystemOrgPrincipal`/`systemTransaction`), not once around a loop.
- `trigger` (`'cron' | 'manual'`) is recorded to tell a dead cron from someone clicking the button.
- The business period for daily jobs is the Manila month (clock shifted by 8 hours).
- Runners are idempotent and safe to re-run.

## Side Effects
- Writes `scheduler_runs` via `schedulerRepo`; each job posts depreciation/amortisation entries, publishes/ingests Firestore data through injected drivers, writes findings observations, budgets, files and fiscal periods.
- Reads the clock (`new Date()`, `Date.now()`, injectable `nowMs`/`now`).
- Uses `systemTransaction` and `withSystemOrgPrincipal`; there is no per-user `authorize()` here.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
