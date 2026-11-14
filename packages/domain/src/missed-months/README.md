# Missed Months
## Overview
Catch-up booking of a missed month's depreciation or amortisation, once, in an open month (T-345). The catch-up entry is itself the record; `missed_month_adjustments` only lets a human see which month it counts as.

## Interface
- `index.ts`: `bookMissedMonth`, `subjectsOwingWithoutEntry`, `missedMonths`, types `OrgPeriodContext`, `BookMissedMonthInput`, `BookMissedMonthResult`, `MissedMonthRow`.

## Invariants
- `bookMissedMonth` posts through the ordinary `postEntry` with the same `sourceType`/`sourceId`/idempotency-key shape the scheduled run uses (`asset:{id}:depreciation:{P}`, `prepaid:{id}:amortisation:{P}`); only the booking date and memo differ. Existing "posted periods" queries and findings pick it up with no special case.
- Accounts used: `6700` depreciation expense, `1590` accumulated depreciation, `6750` amortisation expense, `1400` prepaid.
- The accounting effect never depends on the adjustments table existing.
- An org with no fiscal periods has nothing bookable (`earliestMonth` is `null`).
- `subjectsOwingWithoutEntry` is shared with the findings close check so the screen list and the close check cannot disagree.
- Authorizes `book_missed_month` (org scope).

## Side Effects
- Posts a journal entry via `postEntry` in the caller's `Tx` and locks the asset row (`fixedAssetsRepo.lockAssetRow`); records the adjustment row.
- Reads fiscal periods (`fiscalPeriodsRepo`), assets and prepaid items; no transaction is opened here.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
