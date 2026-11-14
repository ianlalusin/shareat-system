# recurring

## Overview

Recurring expenses at `/expenses/recurring`. Expense drafts, posting, recurring templates and staff reimbursement payouts.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/expenses/recurring`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `listTemplates`, `accountsFor`, `suppliersFor`, `categories`, `today`, `INTERVAL_LABEL`, `WEEKDAYS`, `anchorLabel`, `periodsBehind`, `peso`, `listStores`, `listCategoriesGrouped`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `createTemplateAction`, `updateTemplateAction`, `setTemplateStatusAction`, `deleteTemplateAction`.
- [page.tsx](./page.tsx) — `RecurringExpensesPage`.
- [typed-forms.ts](./typed-forms.ts) — `RECURRING_TEMPLATE_EDIT`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `setTemplateStatusAction`, `deleteTemplateAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createRecurringTemplate`, `deleteRecurringTemplate`, `setRecurringTemplateStatus`, `updateRecurringTemplate`, `createTemplateAction`, `deleteTemplateAction`, `setTemplateStatusAction`, `updateTemplateAction`; persistence or external operations belong to those called services.
- Repository calls: `recurringExpensesRepo.listForOrg`, `moneyAccountsRepo.listMoneyAccounts`, `apRepo.listSuppliers`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 23,452 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
