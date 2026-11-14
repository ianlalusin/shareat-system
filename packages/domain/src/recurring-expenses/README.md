# Recurring Expenses
## Overview
Manages recurring-expense templates (create, edit, pause/resume, remove) and the nightly job that DRAFTS a pending supplier invoice plus a draft expense for each due template (T-216, T-430). The job never pays and never posts: a person must read the bill, attach it, verify the invoice and approve the expense before anything reaches the ledger. `recurrence.ts` holds the pure due-date arithmetic. (The header comment in `index.ts` still says the job is absent; `job.ts` exists and is re-exported.)

## Interface
- `index.ts`: `createRecurringTemplate`, `updateRecurringTemplate`, `setRecurringTemplateStatus`, `deleteRecurringTemplate`, `CreateRecurringTemplateInput`, `UpdateRecurringTemplateInput`; re-exports `./recurrence` and `./job`
- `recurrence.ts` (pure): `RECURRENCE_INTERVALS`, `RecurrenceInterval`, `isWeeklyFamily`, `isAnchorValid`, `clampToMonth`, `nextDueDate`, `firstDueDate`
- `job.ts`: `runRecurringExpenses`, `paymentForAccount`, `CATCH_UP_CAP` (12), `RecurringExpenseRunResult`

## Invariants
- Templates carry no journal entry and no money; nothing in `index.ts` posts.
- The job DRAFTS, never pays (Ian, Sep 2026). It records a pending supplier invoice first, then a draft expense, because `expenses.supplier_id` and `supplier_invoice_id` are required.
- The job acts AS THE TEMPLATE'S CREATOR through `recordInvoice` and `createExpense` and their real gates, not as a system principal, so automation cannot do what its creator could not. A creator since descoped produces a loud per-template failure.
- Template writes authorize `manage_recurring_expenses` at the template's store. A template requires a `supplierId`. Naming a cashier account as default requires `tillIsDeliberate`.
- One draft per missed due date, up to `CATCH_UP_CAP` per template per night, one transaction per due date; the rest are reported as `capped`. The unique (template, due date) key guards every date.
- A due date inside a closed or locked fiscal period is drafted on the first open day instead (the real due date is kept in the draft row and notes); if every period up to today is shut, nothing is drafted and the template retries next night.
- `paymentForAccount`: no account yields `credit`; a cash instrument yields `cash`; otherwise `online` with the account.
- Recurrence uses UTC arithmetic and no `toLocale*`. A 31st anchor clamps to the month's last day (28/29 in February), never refused.
- Job transactions use `withOrgPrincipal`, never a bare `transaction`.

## Side Effects
- DB writes via `recurringExpensesRepo` (and, through `createExpense`/`recordInvoice`, expense and supplier-invoice rows) in transactions; reads `fiscalPeriodsRepo` and `moneyAccountsRepo`.
- No ledger posting.
- Clock: the job and template creation derive today in Manila (+8 hours) from `Date.now()` (or an injected `nowMs`). The job runs per org via `runJobForOrg`/`listOrgsToRun` from `../scheduler`.
- `authorize()` in the four template writers; `recurrence.ts` is pure.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
