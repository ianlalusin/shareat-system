# deliveries

## Overview

Deliveries at `/inventory/deliveries`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/inventory/deliveries`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `DeliveryDocument`, `DeliveryListRow`, `DeliveryItemOption`, `DeliverySupplierOption`, `DeliveryLocationOption`, `DeliveryFormData`, `deliveryFormData`, `deliveryRegister`, `DeliveryDetail`, `deliveryDetail`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [NewDeliveryForm.tsx](./NewDeliveryForm.tsx) — `NewDeliveryForm`.
- [actions.ts](./actions.ts) — `createDeliveryAction`, `receiveDeliveryAction`.
- [page.tsx](./page.tsx) — `DeliveriesPage`.
- [[id]](./[id]/README.md) — Delivery at `/inventory/deliveries/[id]`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `createDeliveryAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `claimUpload`, `createDeliveryDocument`, `receiveDeliveryDocument`, `createDeliveryAction`; persistence or external operations belong to those called services.
- Repository calls: `stockLocationsRepo.listActiveLocations`, `itemsRepo.listItems`, `apRepo.listSuppliers`, `deliveriesRepo.listDeliveries`, `deliveriesRepo.getDeliveryDocument`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 30,589 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
