# [customerId]

## Overview

Customer at `/customers/[customerId]`. Customer credit, receivables, collections and wholesale price lists.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/customers/[customerId]`; dynamic route segments are supplied through App Router params.
- [AutoAllocateCollectionForm.tsx](./AutoAllocateCollectionForm.tsx) — `ReceivableItem`, `Wallet`, `AutoAllocateCollectionForm`.
- [page.tsx](./page.tsx) — `CustomerDetailPage`.

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `recordCollectionAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `openItemsFor`; persistence or external operations belong to those called services.
- Loads screen/report data through `getCustomer`, `getPosition`, `listCharges`, `listCollections`.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 27,187 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
