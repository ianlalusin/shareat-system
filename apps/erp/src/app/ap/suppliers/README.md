# suppliers

## Overview

Suppliers at `/ap/suppliers`. Supplier register, supplier invoice verification and accounts-payable payments.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/ap/suppliers`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `SuppliersPage`.
- [[id]](./[id]/README.md) — Supplier at `/ap/suppliers/[id]`. Supplier register, supplier invoice verification and accounts-payable payments.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `createSupplierAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `listSuppliersWithPosition`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 8,471 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
