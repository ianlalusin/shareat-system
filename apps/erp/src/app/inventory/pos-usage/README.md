# pos-usage

## Overview

Daily POS usage pull at `/inventory/pos-usage`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/inventory/pos-usage`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `SalesDayOption`, `listSalesDaysForStore`, `listOperatingLocationsForStore`, `buildPlanForDay`, `PullLineView`, `PullView`, `pullView`, `findLivePull`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `buildPlanAction`, `finalizeSectionAction`, `requestMapFromPullAction`, `voidPullAction`.
- [page.tsx](./page.tsx) — `PosUsagePage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `finalizeSectionAction`, `requestMapFromPullAction`, `buildPlanAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `finalizeSections`, `voidPosUsagePull`, `recordApproval`, `finalizeSectionAction`, `voidPullAction`; persistence or external operations belong to those called services.
- Repository calls: `salesDaysRepo.listSalesDays`, `posMappingRepo.listDayIdsWithLivePull`, `stockUsageRepo.listOperatingLocations`, `posMappingRepo.getPull`, `posMappingRepo.listPullLines`, `posV1Repo.getFeedById`, `posMappingRepo.findLivePullForDay`, `salesDaysRepo.getById`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 27,139 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
