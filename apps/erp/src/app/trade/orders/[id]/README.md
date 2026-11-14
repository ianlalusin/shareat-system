# [id]

## Overview

Trade order at `/trade/orders/[id]`. Wholesale order fulfilment, delivery receipt printing and customer returns.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/trade/orders/[id]`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `TradeOrderPage`.
- [print](./print/README.md) — Delivery receipt at `/trade/orders/[id]/print`. Wholesale order fulfilment, delivery receipt printing and customer returns.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `dispatchOrderAction`, `receiveOrderAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `orderDetail`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 16,060 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
