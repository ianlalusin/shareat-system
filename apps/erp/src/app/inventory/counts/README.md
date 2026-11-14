# counts

## Overview

Physical counts at `/inventory/counts`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/inventory/counts`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `RegisterLocation`, `RegisterSessionRow`, `CountsRegister`, `countsRegister`, `SheetLine`, `CountSessionDetail`, `countLineId`, `getCountSessionDetail`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `openCountSessionAction`, `recordCountAction`, `advanceCountAction`, `commitCountAction`, `cancelCountAction`.
- [page.tsx](./page.tsx) — `CountsPage`.
- [typed-forms.ts](./typed-forms.ts) — `COUNT_LINE`.
- [[id]](./[id]/README.md) — Count sheet at `/inventory/counts/[id]`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `openCountSessionAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `advanceCountSession`, `cancelCountSession`, `commitCount`, `openCountSession`, `recordCount`, `openCountSessionAction`; persistence or external operations belong to those called services.
- Repository calls: `countSessionsRepo.listActiveLocationsLike`, `countSessionsRepo.listCountSessions`, `countSessionsRepo.freezingSessionsFor`, `countSessionsRepo.personNamesById`, `countSessionsRepo.lineIdFor`, `countSessionsRepo.getCountSession`, `countSessionsRepo.expectedItemsAt`, `countSessionsRepo.listCountLines`, `countSessionsRepo.storeName`, `itemsRepo.listItems`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 24,389 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
