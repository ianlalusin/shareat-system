# Reports
## Overview
Read-side service layer for financial statements and operational reports. Each function turns rows from `reportsRepo` (views over posted/reversed journal entries) or another owning repo into named, `Money`-typed figures. Services stay thin: the view decides what counts and how it is signed, and one query defines each figure (never a second definition of the same number).

## Interface
- `trial-balance.ts`: `getTrialBalance`, `TrialBalanceInput`/`Line`/`Basis`/`Result`
- `balance-sheet.ts`: `getBalanceSheet`, `BalanceSheetInput`/`Line`/`Basis`/`Result`
- `income-statement.ts`: `getIncomeStatement`, `IncomeStatementInput`/`Line`/`Basis`/`Result`
- `cash-flow.ts`: `getCashFlow`, `CashFlowInput`/`Line`/`Basis`/`Result`
- `store-comparison.ts`: `getStorePLComparison`, `StorePLComparisonInput`/`Row`/`Basis`/`Result`
- `sales-rollup.ts`: `getSalesRollup`, `SalesRollupInput`, `SalesPeriodLine`, `SalesChannelLine`, `SalesModeLine`, `SalesRollupBasis`, `SalesChannelDayBlock`, `SalesChannelDay`, `SalesRollupResult`
- `ap-aging.ts`: `getApAgingReport`, `ApAgingInput`/`Row`/`Totals`/`Basis`/`Result`
- `ar-aging.ts`: `getArAgingReport`, `ArAgingInput`/`Row`/`Totals`/`Basis`/`Result`
- `pos-day-reconciliation.ts`: `getPosDayReconciliation`, `PosSide`, `LedgerSide`, `PosDayReconciliationBasis`, `PosDayReconciliationResult`
- `unpaid-liabilities.ts`: `getUnpaidLiabilities`, `UnpaidKindId`, `UnpaidLine`, `UnmatchedLeftover`, `UnpaidKind`, `UnpaidLiabilities`

## Invariants
- Reports never write. Statements take an `Executor` (they only read views); `getApAgingReport`, `getArAgingReport`, `getPosDayReconciliation`, `getUnpaidLiabilities` take `Tx` because they call repos directly.
- Each result carries a `basis` (the requested filter, unchanged) so a screen can show what it was computed over.
- `getBalanceSheet` folds the current unclosed net income into equity as a derived line (via `getIncomeStatement` for the same range), so `ties` (Assets = Liabilities + Equity) holds on any date, not only after a year-close.
- `getCashFlow` is indirect: balance-sheet-account deltas between two snapshots, classified by account code, not by `source_type`.
- `getStorePLComparison` calls `getIncomeStatement` once per store; it derives no figure of its own.
- `getSalesRollup` asserts that the day, month and store groupings of recognised revenue agree to the centavo.
- `getPosDayReconciliation` fetches nothing at render: both sides are stored feeds, so it works with POS down.
- `getUnpaidLiabilities` stores nothing, never runs the recurring runner or freezes a day, and writes no audit row (it uses `can()`, the non-logging probe). It always returns six kinds in fixed order; leftovers that no line explains are shown (`UnmatchedLeftover`), never dropped. Wages (kind 5) and account 2300 need `run_payroll` at that store; a viewer without it gets no amount and no name.
- Amounts are `Money` (bible section 6); repo `numeric(14,2)` strings are converted here.

## Side Effects
- DB reads only (repo/view queries). No ledger posting, no transactions opened, no writes.
- `unpaid-liabilities.ts`: calls `authorize()`/`can()` (a refusal is audit-logged by `authorize`), calls `previewPayRun` from `../payroll`, and logs through `@shareat/core/logger`.
- No clock or env reads; dates come from the inputs.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
