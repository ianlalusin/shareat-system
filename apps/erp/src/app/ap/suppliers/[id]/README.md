# [id]

## Overview

Supplier at `/ap/suppliers/[id]`. Supplier register, supplier invoice verification and accounts-payable payments.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/ap/suppliers/[id]`; dynamic route segments are supplied through App Router params.
- [AutoAllocatePaymentForm.tsx](./AutoAllocatePaymentForm.tsx) — `PayableItem`, `Wallet`, `PayableFloat`, `AutoAllocatePaymentForm`.
- [page.tsx](./page.tsx) — `SupplierDetailPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `recordPaymentAction`, `editSupplierAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `getSupplier`, `getPosition`, `listOpenItems`, `listInvoices`.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 31,451 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
