# [id]

## Overview

Owner at `/owners/[id]`. Owner contributions, drawings, receivable settlement and monthly close.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/owners/[id]`; dynamic route segments are supplied through App Router params.
- [SettleForm.tsx](./SettleForm.tsx) — `SettleAccount`, `SettleForm`.
- [page.tsx](./page.tsx) — `OwnerPage`.

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `settleAction`, `contributionAction`, `drawingAction`, `closeMonthAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `getDetail`, `listActivePersons`, `listStores`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 17,331 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
