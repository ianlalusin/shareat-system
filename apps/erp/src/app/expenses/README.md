# expenses

## Overview

Expenses at `/expenses`. Expense drafts, posting, recurring templates and staff reimbursement payouts.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/expenses`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `StoreOption`, `PersonOption`, `CategoryOption`, `listStores`, `listActingPersons`, `listActivePersons`, `listCategoriesGrouped`, `listActiveCategoriesGrouped`, `categoryLabel`, `withOrgPrincipal`, `recordingRefusalsFor`, `journalRepo`.
- [actions.ts](./actions.ts) — `createExpenseAction`, `recordExpenseForInvoiceAction`.
- [page.tsx](./page.tsx) — `ExpensesListPage`.
- [typed-forms.ts](./typed-forms.ts) — `EXPENSE_DRAFT_EDIT`.
- [[id]](./[id]/README.md) — Expense at `/expenses/[id]`. Expense drafts, posting, recurring templates and staff reimbursement payouts.
- [new](./new/README.md) — New expense at `/expenses/new`. Expense drafts, posting, recurring templates and staff reimbursement payouts.
- [recurring](./recurring/README.md) — Recurring expenses at `/expenses/recurring`. Expense drafts, posting, recurring templates and staff reimbursement payouts.
- [reimbursements](./reimbursements/README.md) — Reimbursements at `/expenses/reimbursements`. Expense drafts, posting, recurring templates and staff reimbursement payouts.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Invokes `recordIfUnmappedConstraint`, `createExpense`; persistence or external operations belong to those called services.
- Repository calls: `expensesRepo.listCategories`, `apRepo.getSupplierInvoiceById`, `apRepo.getSupplierById`, `expensesRepo.listExpenses`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 29,996 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
