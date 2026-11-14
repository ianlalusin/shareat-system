# Expenses
## Overview
Owns the expense document lifecycle: capture a draft, edit or delete it while a draft, approve it (approval IS the posting, via `postEntry`), void it (reversal), and pay back reimbursable expenses. Also administers expense categories and their account mapping. `routeExpense` is the pure, DB-free core that turns a category and payment splits into balanced journal lines (docs/tasks/122-expenses.md).

## Interface
- `routing.ts`: `routeExpense`, `RoutingInput`, `RoutingResult`, `RoutingLine`, `RoutingLineSide`, `RoutingPayment`, `PersonalExpenseOwner`, `ExpensePaymentMethod`, `ExpenseGroup`, `EXPENSE_GROUPS`, `EXPENSE_FUNDING_ACCOUNTS`, `OWNER_DRAWINGS_CODE`, `DUE_FROM_OWNER_CODE`, `retiredPaymentMethodSentence`, `assertLivePaymentMethod`
- `create.ts`: `createExpense`, `parsePaymentAmount`, `CreateExpenseInput`, `CreateExpensePaymentInput`, `CreateExpenseResult`
- `edit.ts`: `editExpense`, `EditExpenseInput`, `EDIT_WINDOW_MS`
- `approve.ts`: `approveExpense`, `ApproveExpenseResult`
- `void.ts`: `voidExpense`, `VoidExpenseResult`
- `delete.ts`: `deleteExpenseDraft`
- `reimbursement.ts`: `payReimbursement`, `PayReimbursementInput`, `PayReimbursementResult`
- `categories.ts`: `setCategoryAccount`, `createCategory`, `renameCategory`, `setCategoryActive`, `SetCategoryAccountInput`, `CreateCategoryInput`, `ExpenseCategoryGroup`
- `index.ts` re-exports all of the above files.

## Invariants
- Drafts are pure document capture: no ledger writes and no routing validation. An unmapped category or payment-method account may sit in a draft; only approval is blocked.
- Approve is the post, with idempotency key `expense:{id}:post`; re-approving a posted expense is a safe no-op (`created: false`). It short-circuits before loading category/payments.
- A posted expense is never edited or deleted. The only correction is `voidExpense`, which reverses through `reverseEntry`. Only a DRAFT can be deleted (`deleteExpenseDraft`).
- Live payment methods are `cash`, `online`, `credit`, `reimbursable`; `other` and `ar_collection` are retired and refused at create/edit (`assertLivePaymentMethod`) and again at approval (`routeExpense`).
- `routing.ts` funding accounts deliberately COPY `packages/etl` leg-mapping values (no import, to avoid a dependency cycle); `tests/unit/expense-routing-mirror.test.ts` guards drift. Cash with `accountId === 'office'` routes to 1130, not 1110.
- Edit access is by capability: the creator within 48 hours (`EDIT_WINDOW_MS`) uses `edit_own_expense`.
- A CASHIER-account overdraft is allowed with a `warnings` entry the caller must surface (bible row 154).
- `payReimbursement` posts DR 2130 (party = employee) / CR the money account; the outstanding balance is derived, not stored.
- Refusals use `refuse`/`gone`/`internalFault` from `../shared/refusal`.

## Side Effects
- DB writes via `expensesRepo`, `apRepo`, `cashRequestsRepo`, `journalRepo`, `moneyAccountsRepo`, `auditLogRepo` inside a transaction; functions taking `tx: Tx | null` open their own when `null`.
- Ledger: `approveExpense` and `payReimbursement` call `postEntry`; `voidExpense` calls `reverseEntry`. A CAPEX approval may capitalize a fixed asset (`capitalizeApprovedExpense`); void retires it (`retireAssetFromVoidedExpense`).
- `authorize()` in every writer; clock reads (`new Date`) in approve, edit, delete, reimbursement.
- `routing.ts` is pure (no DB, clock or env).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
