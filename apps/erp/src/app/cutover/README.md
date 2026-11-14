# cutover

## Overview

The conversion at `/cutover`. Conversion checklist, counted opening stock and opening balance-sheet figures.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/cutover`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `CONVERSION_DATE`, `loadProgress`, `loadGaps`, `countedValueFor`, `PHASE_TITLE`, `kindLabel`, `loadOpeningDrafts`, `PostableAccount`, `loadPostableAccounts`, `RoomOption`, `loadRooms`, `RoomCountRow`, `loadRoomCountSheet`, `MergedLine`, `loadMergedLines`, `SheetItem`, `loadSheetItems`, `PartyOption`, `loadPartyOptions`, `loadPendingShells`, `loadTieOut`, `peso`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `attestStepAction`, `recordCountAction`, `addOpeningFigureAction`, `removeOpeningFigureAction`, `postOpeningBalancesAction`, `valueOpeningStockAction`, `valueOpeningAssetAction`.
- [page.tsx](./page.tsx) — `CutoverPage`.
- [count](./count/README.md) — Opening count at `/cutover/count`. Conversion checklist, counted opening stock and opening balance-sheet figures.
- [opening](./opening/README.md) — Opening balances at `/cutover/opening`. Conversion checklist, counted opening stock and opening balance-sheet figures.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `attestStepAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `addQuantity`, `addOpeningFigure`, `postOpeningBalances`, `recordOpeningCount`, `removeOpeningFigure`, `recordingRefusalsFor`, `recordApproval`; persistence or external operations belong to those called services.
- Repository calls: `cutoverRepo.openingDrafts`, `cutoverRepo.postableOpeningAccounts`, `cutoverRepo.activeRoomsOf`, `itemsRepo.listItems`, `cutoverRepo.countsForRoom`, `cutoverRepo.countsForStore`, `cutoverRepo.itemsMovedInRoom`, `cutoverRepo.partyOptions`, `cutoverRepo.pendingAssetShells`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 28,418 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
