# items

## Overview

Items at `/items`. Stock item master, variants, units, lifecycle and store sellability overrides.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/items`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `StoreSellabilityView`, `sellabilityByStore`, `soldAsLabel`, `listItems`, `itemKindCounts`, `dismissedPairs`, `variationParentOptions`, `variationsOf`, `unitHistoryExists`, `retireReadout`, `getItem`, `itemPrices`, `pendingRequests`, `duplicateCandidates`, `pendingRequestCodes`, `mayApproveItem`, `peso`, `withOrgPrincipal`, `parseKindFilter`.
- [ItemCodeField.tsx](./ItemCodeField.tsx) — `ItemCodeSuggestionView`, `ItemCodeFieldProps`, `ItemCodeField`.
- [actions.ts](./actions.ts) — `requestItemAction`, `createItemAction`, `updateItemFlagsAction`, `setStoreSellabilityAction`, `clearStoreSellabilityAction`, `changeItemUnitAction`, `renameItemAction`, `setItemStatusAction`.
- [family.ts](./family.ts) — `FamilyRow`, `arrangeFamilies`, `parseKindFilter`.
- [page.tsx](./page.tsx) — `ItemsPage`.
- [typed-forms.ts](./typed-forms.ts) — `ITEM_RENAME`, `ITEM_UNIT`, `ITEM_FLAGS`, `ITEM_STORE_SELLABILITY`, `ITEM_VARIANT`.
- [[id]](./[id]/README.md) — Item at `/items/[id]`. Stock item master, variants, units, lifecycle and store sellability overrides.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.
- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.

## Side Effects

- Submitted forms invoke `requestItemAction`, `mergeItemsAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createItem`, `openItemRequestSentence`, `setStoreSellability`, `updateItem`, `createItemAction`; persistence or external operations belong to those called services.
- Repository calls: `itemsRepo.listStoreSellabilityOverrides`, `itemsRepo.sellabilityAt`, `itemsRepo.listItems`, `itemsRepo.countItemsByKind`, `itemsRepo.listDismissals`, `itemsRepo.listVariationsOf`, `itemsRepo.unitHistoryExists`, `itemsRepo.retireReadout`, `itemsRepo.getItemById`, `itemsRepo.priceHistory`, `itemsRepo.priceMovement`, `itemsRepo.priceBySupplier`, `itemsRepo.listItemRequests`, `itemsRepo.findDuplicateCandidates`, `itemsRepo.findOpenRequestByName`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 6 local production/configuration files scanned; 47,622 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
