# thirteenth-month

## Overview

13th-month pay at `/payroll/thirteenth-month`. Pay-run previews and posting, effective-dated statutory reference rates and final/13th-month pay.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/payroll/thirteenth-month`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `preview`, `runsFor`, `payoutsFor`, `peso`, `withOrgPrincipal`, `listStores`, `cashAccountsFor`, `payrollStoresFor`.
- [actions.ts](./actions.ts) — `post13thMonthRunAction`, `void13thMonthRunAction`.
- [page.tsx](./page.tsx) — `ThirteenthMonthPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `post13thMonthRunAction`, `void13thMonthRunAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `post13thMonthRun`, `void13thMonthRun`, `recordApproval`, `post13thMonthRunAction`, `void13thMonthRunAction`; persistence or external operations belong to those called services.
- Repository calls: `thirteenthMonthRepo.listThirteenthMonthRuns`, `thirteenthMonthRepo.getThirteenthMonthRun`, `thirteenthMonthRepo.listThirteenthMonthPayouts`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 14,844 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
