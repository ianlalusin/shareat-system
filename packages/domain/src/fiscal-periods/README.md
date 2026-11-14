# Fiscal Periods
## Overview
Owns closing the books: `closePeriod` raises the period-lock wall (migration 0003's trigger) for any month, `closeYear` posts the single year-end entry that zeroes income and expense into 3300 Retained earnings and locks the year's periods, and `holes.ts` classifies and fills missing fiscal periods. Every gate is enforced inside these functions, never trusted from the caller (ADR-006).
## Interface
- `index.ts`: `closePeriod`, `closeBlockers`, `refuseOnMissingEarlierPeriod`, types `ClosePeriodInput`/`ClosePeriodResult`/`CloseBlockersInput`/`CloseBlockers`; re-exports `closeYear`, `CloseYearInput`, `CloseYearResult` and the `holes.ts` symbols below.
- `close-year.ts`: `closeYear`, types `CloseYearInput` (`orgId`, `year`), `CloseYearResult` (`entryId`, `created`, `periodsLocked`).
- `holes.ts`: `classifyHoles`, `createMissingClosedPeriod`, types `HolePieceClass` ('A' | 'B' | 'C' | 'D'), `ClassifiedHolePiece`, `ClassifyHolesResult`, `CreateMissingClosedPeriodInput`, `CreateMissingClosedPeriodResult`.
## Invariants
- `closePeriod` gate order: `close_period` capability; no unposted draft expenses/deliveries in the period; usage settled (`usageCloseRefusal`); no hard findings (`closeReadiness`); no earlier period still open; no missing month earlier in the history. Then one write setting `status`/`closed_at`/`closed_by` together.
- Periods close in order: `refuseOnMissingEarlierPeriod` is the shared gate for `closePeriod` and `closeYear`; it names the admin fill action for hole classes B/C and the monthly seed job for A/D.
- `closeBlockers` is shared by `closePeriod` and `createMissingClosedPeriod` so the two cannot drift; it is deliberately free of the missing-earlier-month check.
- `closeYear` posts ONE balanced entry via `postEntry`, dated 1 January of `year + 1`, per-account NET with one side per line (never raw debit/credit totals swapped), with the 3300 plug computed from the same rows; it reads totals with `includeYearClose: false` (load-bearing) and refuses when there is no activity.
- `closeYear` is idempotent (`created: false` on replay) and requires an open `tx` (no `tx: null` form). Locking a year removes the admin period override for its months.
- `classifyHoles` is the one classifier shared by the monthly seed job, the findings screen and `createMissingClosedPeriod`. Class A = open books fillable; B = whole month missing in closed books; C = part month in closed books; D = part month in open books (never filled).
- `createMissingClosedPeriod` fills one month at a time, requires a non-blank reason, refuses an overlapping existing period, and runs in one transaction (any refusal writes nothing).
## Side Effects
- Writes through `fiscalPeriodsRepo` (close, lock, create periods) on the caller's `Tx`; `closeYear` posts a ledger entry via `postEntry`.
- Reads `reportsRepo.getIncomeStatementLines`, findings readiness and stock usage-check reports. No clock/env/network/disk access.
## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
