# orders

## Overview

Branch orders at `/commissary/orders`. Commissary catalogue, branch-order conversations and transit discrepancy resolution.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/commissary/orders`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `today`, `errorMessageOf`, `actorStoreIds`, `CommissaryChoice`, `newOrderPanelData`, `LineView`, `OrderView`, `orderView`, `peso`, `listStores`, `withOrgPrincipal`, `BRANCH_ORDER_STAGE_LABEL`, `branchOrderStage`, `StoreOption`, `BranchOrderStage`, `CatalogueLine`.
- [actions.ts](./actions.ts) — `createOrderAction`.
- [page.tsx](./page.tsx) — `BranchOrdersPage`.
- [[id]](./[id]/README.md) — Branch order at `/commissary/orders/[id]`. Commissary catalogue, branch-order conversations and transit discrepancy resolution.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `createOrderAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `saveBranchOrderDraft`, `createOrderAction`; persistence or external operations belong to those called services.
- Repository calls: `commissaryRepo.listCommissariesFor`, `tradeRepo.getOrderById`, `tradeRepo.linesFor`, `stockLocationsRepo.listActiveLocations`, `itemsRepo.getItemById`, `lowStockRepo.listMessages`, `itemsRepo.listItems`, `lowStockRepo.branchOrders`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 21,019 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
