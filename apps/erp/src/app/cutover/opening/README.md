# opening

## Overview

Opening balances at `/cutover/opening`. Conversion checklist, counted opening stock and opening balance-sheet figures.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/cutover/opening`; dynamic route segments are supplied through App Router params.
- [page.tsx](./page.tsx) — `OpeningPage`.

## Invariants

- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `addOpeningFigureAction`, `valueOpeningStockAction`, `valueOpeningAssetAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Loads screen/report data through `listStores`, `loadGaps`, `loadOpeningDrafts`, `loadPartyOptions`, `loadPendingShells`, `loadPostableAccounts`, `loadProgress`, `loadTieOut`.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 14,042 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
