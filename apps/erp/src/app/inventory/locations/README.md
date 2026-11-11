# locations

## Overview

Stock locations at `/inventory/locations`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/inventory/locations`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `LocationsPageData`, `locationsPageData`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `setupRoomsAction`, `createLocationAction`, `updateLocationAction`, `setDefaultAction`, `deactivateLocationAction`, `reactivateLocationAction`.
- [page.tsx](./page.tsx) — `StockLocationsPage`.
- [typed-forms.ts](./typed-forms.ts) — `LOCATION_EDIT`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `setupRoomsAction`, `createLocationAction`, `updateLocationAction`, `setDefaultAction`, `deactivateLocationAction`, `reactivateLocationAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createLocation`, `setDefaultLocation`, `updateLocation`, `createLocationAction`, `setDefaultAction`, `updateLocationAction`; persistence or external operations belong to those called services.
- Repository calls: `stockLocationsRepo.getStoreStockModel`, `stockLocationsRepo.listLocations`, `stockLocationsRepo.listLocationTypes`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 23,549 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
