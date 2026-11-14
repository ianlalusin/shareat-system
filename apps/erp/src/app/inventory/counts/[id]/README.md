# [id]

## Overview

Count sheet at `/inventory/counts/[id]`. FIFO stock views, receiving, room transfers, usage, counts and production workflows.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/inventory/counts/[id]`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `CountSessionPage`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `recordCountAction`, `advanceCountAction`, `commitCountAction`, `cancelCountAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `getCountSessionDetail`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 13,155 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
