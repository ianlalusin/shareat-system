# count

## Overview

Opening count at `/cutover/count`. Conversion checklist, counted opening stock and opening balance-sheet figures.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/cutover/count`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `CountPage`.
- [typed-forms.ts](./typed-forms.ts) — `CUTOVER_COUNT`.
- [sheet](./sheet/README.md) — Count sheet at `/cutover/count/sheet`. Conversion checklist, counted opening stock and opening balance-sheet figures.

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `recordCountAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `listStores`, `loadMergedLines`, `loadRoomCountSheet`, `loadRooms`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 12,161 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
