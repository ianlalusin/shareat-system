# Budgets
## Overview
Expense budgets (T-215): setting a per-store, per-category, per-period cap and the period-key helpers used to roll it forward. A budget is an intention, not a ledger fact.

## Interface
- `index.ts`: `setExpenseBudget`, `removeExpenseBudget`, `periodKeyOf`, `nextPeriodKey`, `resetWindowDays`, type `SetBudgetInput`.

## Invariants
- Nothing here posts: no `postEntry` call and no journal entry id on the budgets table.
- A cap never refuses an expense: a finding nags whoever can act; warning is the control, blocking is the failure.
- Zero is a legitimate cap ("spend nothing here") and is different from no row ("no cap").
- Amounts are parsed after `authorize()` into the column's `numeric(14,2)` brand.
- `periodKey` is `YYYYMM`.

## Side Effects
- `setExpenseBudget`/`removeExpenseBudget` write `expense_budgets` rows; they open a transaction via `transaction(...)`. Both authorize `manage_expense_budgets` at the store.
- `periodKeyOf`, `nextPeriodKey`, `resetWindowDays`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
