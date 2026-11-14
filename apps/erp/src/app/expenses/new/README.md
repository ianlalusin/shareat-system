# new

## Overview

New expense at `/expenses/new`. Expense drafts, posting, recurring templates and staff reimbursement payouts.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/expenses/new`; dynamic route segments are supplied through App Router params.
- [BudgetHint.tsx](./BudgetHint.tsx) — `BudgetCap`, `BudgetHint`.
- [page.tsx](./page.tsx) — `NewExpensePage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `createExpenseAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Repository calls: `budgetsRepo.listForStorePeriod`. These execute through the surrounding transaction context.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 12,890 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
