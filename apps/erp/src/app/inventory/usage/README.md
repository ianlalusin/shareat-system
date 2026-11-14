# usage

## Overview

Usage & wastage at `/inventory/usage`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/inventory/usage`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `UsageItemOption`, `UsageFormData`, `usageScreenData`, `UsageLineView`, `UsageRecordDetail`, `usageRecordDetail`, `UsageQueueView`, `usageQueueData`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [NewUsageForm.tsx](./NewUsageForm.tsx) — `NewUsageForm`.
- [actions.ts](./actions.ts) — `saveUsageDraftAction`, `postUsageAction`, `deleteUsageDraftAction`, `voidUsageAction`.
- [page.tsx](./page.tsx) — `UsagePage`.
- [[id]](./[id]/README.md) — Usage record at `/inventory/usage/[id]`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `saveUsageDraftAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `deleteUsageDraft`, `postUsage`, `saveUsageDraft`, `voidUsage`, `recordApproval`, `addDays`, `saveUsageDraftAction`; persistence or external operations belong to those called services.
- Repository calls: `stockUsageRepo.listOperatingLocations`, `stockUsageRepo.listDepartments`, `itemsRepo.listUsableItems`, `stockUsageRepo.listUsageRecords`, `stockUsageRepo.getUsageRecord`, `stockUsageRepo.listUsageLines`, `stockUsageRepo.locationName`, `stockLedgerRepo.onHand`, `posMappingRepo.livePullForUsageRecord`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 36,398 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
