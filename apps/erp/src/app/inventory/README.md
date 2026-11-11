# inventory

## Overview

Stock on hand at `/inventory`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/inventory`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `OnHandRow`, `StockSummary`, `stockSummary`, `listStores`, `StoreOption`.
- [page.tsx](./page.tsx) — `InventoryPage`.
- [counts](./counts/README.md) — Physical counts at `/inventory/counts`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [deliveries](./deliveries/README.md) — Deliveries at `/inventory/deliveries`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [locations](./locations/README.md) — Stock locations at `/inventory/locations`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [low-stock](./low-stock/README.md) — Low stock at `/inventory/low-stock`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [pos-map](./pos-map/README.md) — POS item mapping at `/inventory/pos-map`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [pos-usage](./pos-usage/README.md) — Daily POS usage pull at `/inventory/pos-usage`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [production](./production/README.md) — Production at `/inventory/production`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [returns](./returns/README.md) — Supplier returns at `/inventory/returns`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [transfers](./transfers/README.md) — Stock transfers at `/inventory/transfers`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.
- [usage](./usage/README.md) — Usage & wastage at `/inventory/usage`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Repository calls: `stockLedgerRepo.onHandByStore`, `stockLayersRepo.valuation`. These execute through the surrounding transaction context.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 12,462 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
