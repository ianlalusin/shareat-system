# [id]

## Overview

Prepaid item at `/prepaid/[id]`. Prepaid cost register, term confirmation, amortisation and write-off.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/prepaid/[id]`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `PrepaidItemPage`.

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `confirmTermAction`, `amortiseAction`, `reverseMonthAction`, `writeOffAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `getDetail`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 14,713 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
