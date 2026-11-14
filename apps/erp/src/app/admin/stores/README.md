# stores

## Overview

Stores at `/admin/stores`. Organization, store, user and position-default administration.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/admin/stores`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `StoreListRow`, `listStoresForAdmin`, `StoreDetail`, `storeDetail`, `withOrgPrincipal`, `StoreRow`, `ReadinessCheck`.
- [actions.ts](./actions.ts) — `createStoreAction`, `updateStoreAction`, `setStoreStockModelAction`, `setStoreOpeningDateAction`, `deactivateStoreAction`, `reactivateStoreAction`.
- [page.tsx](./page.tsx) — `StoresPage`.
- [typed-forms.ts](./typed-forms.ts) — `STORE_DETAILS`, `STORE_OPENING_DATE`, `STORE_STOCK_MODEL`.
- [[id]](./[id]/README.md) — Store at `/admin/stores/[id]`. Organization, store, user and position-default administration.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `createStoreAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createStore`, `setStoreOpeningDate`, `setStoreStockModel`, `updateStoreDetails`, `createStoreAction`; persistence or external operations belong to those called services.
- Repository calls: `storesRepo.listForOrg`, `stockLocationsRepo.listActiveLocations`, `storesRepo.isPreOpening`, `storesRepo.getById`, `storesRepo.isValidDateString`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 28,419 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
