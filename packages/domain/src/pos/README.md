# POS Integration (v1 feed and usage pull)
## Overview
Bridge between the live POS v1 system and the ERP: store and terminal links, tenders, fetching and deriving a day's sales from the POS feed, rechecking imported days for drift, the 06:00 Manila day-import job, and the daily POS usage pull that turns sold items into stock-usage drafts. Linking a store is its go-live switch: linked stores import sales from POS instead of typing them.
## Interface
- `store-link.ts`: `linkStoreToPos`, `unlinkStoreFromPos`, types `LinkStoreToPosInput`, `UnlinkStoreFromPosInput`.
- `terminal-link.ts`: `provisionPosTerminalLink`, `revokePosTerminalLink`, type `ProvisionPosTerminalLinkInput`.
- `tenders.ts`: `createTender`, `updateTender`, `setTenderActive`, types `CreateTenderInput`, `UpdateTenderInput`.
- `v1-feed.ts`: `PosNotConfiguredError`, `PosUnreachableError`, `fetchPosV1Day`, `fetchPosV1PaymentMethods`, `fetchPosV1Stores`, types `FetchPosV1Day`, `FetchPosV1DayInput`, `PosV1DayFetcher`, `PosV1StoreOption`.
- `v1-derive.ts` (pure): `deriveSalesDay`, `packageCapExcess`, `POS_V1_VAT_EXCLUSIVE_SENTENCE`, types `DeriveSalesDayContext`, `DerivedFigures`, `DeriveSalesDayResult`.
- `v1-methods.ts` (pure): `normalizePosV1Alias`, `toCentavos`, `resolvePosV1Methods`, types `ResolverTender`, `ResolvedMethods`.
- `v1-census.ts` (pure): `classifyDay`, `emptyCensus`, `addDay`, `censusGate`, `formatCensus`, types `DayClass`, `Census`.
- `v1-sold-items.ts` (pure): `soldItemsFromFeed`, `sameItemsProjection`, type `SoldItemsFromFeed`.
- `v1-recheck.ts`: `recheckPosDay`, `recheckRecentDays`, `RECHECK_RECENT_DAYS` (7), types `RecheckFetchers`, `RecheckResult`, `RecheckRecentResult`.
- `day-import-job.ts`: `posDayImportSweep`, `CATCH_UP_DAYS` (7), types `PosDayImportOutcome`, `PosDayImportSweepResult`.
- `plan.ts` (pure): `explodePosSales`, types `PosMapMode`, `PlanSection`, `PosSoldItemInput`, `MapLookup`, `RecipeIngredientLookup`, `RecipeLookup`, `PlanLine`, `ExplodeInput`.
- `item-map.ts`: `upsertPosItemMap`, `requestMap`, `decideMapRequest`, plus input/outcome types.
- `usage-pull.ts`: `buildPlan`, `finalizeSections`, `voidPosUsagePull`, `pullHolds`, `SNAPSHOT_MAX_AGE_MS`, types `BuildPlanInput`, `BuildPlanOutcome`, `FinalizeSectionsInput`, `SectionOutcome`, `FinalizeResult`.
- `depletion-source.ts`: `planInstant`, `loadDepletionLookups`, `menuRuleCoveredItemIds`, `assertNoPlannedPullAtLinkedSwitchedStores`, `compareDepletionSources`, `switchUsageSource`, `linkPosV1Item`, `unlinkPosV1Item`, `seedLinkFromMap`, types `UsageSource`, `DepletionLookups`, `DifferenceKind`, `SourceDifference`, `SourceComparison`, `SwitchUsageSourceInput`, `LinkPosV1ItemInput`.
## Invariants
- `authorize()` comes first in every write. Links and tenders need `manage_chart_of_accounts` (admin-level); terminal links need `provision_clock_terminal`; item maps need `manage_pos_map`.
- POS is called with POS's own store id (the link's `pos_store_id`), never the v2 store id; no lock or transaction is held across a fetch, and a failed fetch writes nothing.
- The single float-to-centavo conversion is `toCentavos` (accepted only within 0.001 of a centavo); after it only `@shareat/core/money` is used. `deriveSalesDay` is pure and runs before any write.
- A POS method resolves only through a tender's explicit normalized alias; unresolved non-zero or negative methods refuse.
- `linkStoreToPos` locks the store row `FOR UPDATE` first so a typed sales day and a link serialize; relinking never changes `store_id`. `provisionPosTerminalLink` allows one active tablet per store (revokes the previous link) and is the only writer of the table.
- The day-import job only drafts `open` sales days: it never submits, verifies, posts or voids; it runs under `withOrgPrincipal`; an existing day in any status is skipped; a dry run rolls back and writes no run row.
- Usage pull: finalizing creates a usage DRAFT per (store, day, room) and moves no stock; the server rebuilds the plan at finalize and writes only the intersection with what the caller confirmed (`PLAN_CHANGED` otherwise); a `no_stock` map yields no line; sections are one-shot per (pull, section).
- `depletion-source.ts` is the only `pos/**` file that may name the menu, and writes only menu tables, never v1 tables.
- Rechecks store what POS says now against the basis feed's stored store id (not the current link).
## Side Effects
- Network: `v1-feed.ts` calls the POS bridge using `POS_API_URL`/`POS_API_KEY` read via `env()` at call time.
- DB writes via `posV1Repo`, `posMappingRepo`, `salesDaysRepo`, `stockUsageRepo`, `auditLogRepo` and related repos on the caller's `Tx`; the recheck functions and the sweep open their own short transactions (`withOrgPrincipal`).
- `usage-pull.ts` creates and voids usage records; `day-import-job.ts` writes scheduler run records and logs. No ledger posting by this module itself (imports go through `sales-days/import`).
- Pure files (`plan`, `v1-derive`, `v1-methods`, `v1-census`, `v1-sold-items`): None.
## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
