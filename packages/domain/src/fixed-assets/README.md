# Fixed Assets
## Overview
Owns the fixed-asset register and its depreciation: adding an asset (by hand or automatically from an approved CAPEX expense), posting straight-line depreciation, correcting the in-service date, editing terms, and disposal (write-off). The ledger is the source of truth: accumulated depreciation and disposal loss are derived from the journal, never stored on the asset (docs/tasks/124-fixed-assets-and-depreciation.md).

## Interface
- `schedule.ts` (pure): `buildSchedule`, `periodDue`, `periodsThrough`, `expectedAccumulated`, `DEPRECIATION_INTERVALS`, `DepreciationInterval`, `ScheduleInput`, `SchedulePeriod`
- `policy.ts`: `readPolicyOrRefuse`, `resolveUsefulLifeMonths`, `PolicyUnreadableError`, `CAPITALISATION_DEFAULTS`, `DEFAULT_USEFUL_LIFE_MONTHS`, `CapitalisationPolicy`
- `capitalize.ts`: `createAsset`, `capitalizeFromExpense`, `capitalizeApprovedExpense`, `retireAssetFromVoidedExpense`, `MAX_USEFUL_LIFE_MONTHS`, `CreateAssetInput`, `CapitaliseFromExpenseResult`, `RetireAssetFromVoidedExpenseResult`
- `depreciate.ts`: `depreciateAsset`, `runDepreciation`, `runDepreciationAsSystem`, `depreciationDrift`, `scheduleInputFor`, `DepreciationPosting`, `RunDepreciationInput`, `RunDepreciationResult`
- `dispose.ts`: `disposeAsset`, `DisposeAssetInput`, `DisposeAssetResult`
- `in-service.ts`: `setAssetInService`, `planInServiceReversal`, `executeReversals`, `planToken`, `requireConfirmedPlan`, `describeReversal`, `describeStoreReversal`, `CONFIRM_NAMED_ASSETS`, `SetAssetInServiceInput`/`Result`
- `terms.ts`: `updateAssetTerms`, `UpdateAssetTermsInput`
- `index.ts` re-exports schedule, policy, capitalize, depreciate, dispose, in-service, terms.

## Invariants
- Depreciation is idempotent by construction: re-running posts missing periods and no-ops posted ones; there is no separate catch-up path. `postEntry` checks the idempotency key before resolving the period, so re-running a closed month is a safe no-op, while a truly missed month in a closed period still refuses.
- Nothing writes an accumulated-depreciation column; it is read from the journal (`fixedAssetsRepo.accumulatedFromLedger`). Disposal loss is `cost - accumulated`, derived at disposal, so the three legs always balance.
- Depreciation: Dr 6700 / Cr 1590 (contra-asset; cost in 1510 stays visible at cost). Disposal: Dr 1590, Dr 7400 (loss), Cr 1510; zero proceeds only (no sale/gain path).
- The schedule starts at `acquiredOn`, so a period before acquisition is never charged.
- `capitalizeFromExpense`/`createAsset` post NO journal entry: the CAPEX expense already booked Dr 1510 (T-122). Posting again would double the asset.
- The capitalisation policy distinguishes ABSENT (use defaults) from UNREADABLE (`PolicyUnreadableError`, the posting stops). Do not collapse it into a try/catch returning defaults. Default life is 24 months.
- Terms are fixed once depreciation is posted (a DB trigger is the backstop; `updateAssetTerms` holds the rule and runs `authorize` before parsing).
- Correcting in-service date is reverse, never rewrite: wrong months are reversed in an open month through `reverseEntry`, behind a confirmed plan token. Closed books are never touched.
- `depreciate.ts` imports no bare `transaction` on purpose (DEF-287): every transaction names who it acts as (`withOrgPrincipal` / `withSystemOrgPrincipal`).

## Side Effects
- DB writes via `fixedAssetsRepo`, `expensesRepo`, `journalRepo`, `storesRepo`.
- Ledger: `depreciateAsset` and `disposeAsset` call `postEntry`; `in-service.ts` (`executeReversals`) and `retireAssetFromVoidedExpense` call `reverseEntry`. Capitalization itself posts nothing.
- `authorize()` in capitalize, depreciate, dispose, in-service and terms; `transaction()` opened in `capitalize.ts` and `dispose.ts` when none is passed.
- `schedule.ts` is pure (no DB, clock or env).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
