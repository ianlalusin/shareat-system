# [id]

## Overview

Branch order at `/commissary/orders/[id]`. Commissary catalogue, branch-order conversations and transit discrepancy resolution.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/commissary/orders/[id]`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `postMessageAction`, `addLineAction`, `updateLineAction`, `removeLineAction`, `submitOrderAction`, `decideLineAction`, `withdrawOrderAction`, `receiveOrderAction`, `acceptOrderAction`, `rejectOrderAction`.
- [page.tsx](./page.tsx) — `BranchOrderPage`.
- [typed-forms.ts](./typed-forms.ts) — `COMMISSARY_LINE_UPDATE`, `COMMISSARY_LINE_FULFIL`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `submitOrderAction`, `acceptOrderAction`, `markReadyAction`, `dispatchOrderAction`, `receiveOrderAction`, `addLineAction`, `proposeLineAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `addBranchOrderLine`, `postOrderMessage`, `receiveTradeOrder`, `removeBranchOrderLine`, `submitOrder`, `updateBranchOrderLine`, `voidTradeOrder`, `recordApproval`, `addLineAction`, `postMessageAction`, `receiveOrderAction`, `rejectOrderAction`, `removeLineAction`, `submitOrderAction`, `updateLineAction`, `withdrawOrderAction`; persistence or external operations belong to those called services.
- Repository calls: `lowStockRepo.orderParties`, `tradeRepo.getOrderById`. These execute through the surrounding transaction context.
- `revalidatePath` refreshes affected route caches after an action.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 29,806 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
