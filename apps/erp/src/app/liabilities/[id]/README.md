# [id]

## Overview

Liability at `/liabilities/[id]`. Liability charges, payments and ledger-derived unpaid obligations.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/liabilities/[id]`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `LiabilityPage`.

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `chargeAction`, `payAction`, `reverseAction`, `retireAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `chargeableAccounts`; persistence or external operations belong to those called services.
- Loads screen/report data through `getDetail`, `listStores`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 13,637 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
