# menu

## Overview

Menu at `/menu`. Menu catalogue, store prices, item requests and POS depletion-source controls.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/menu`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `str`, `opt`, `wholeNumber`, `isUuid`, `requireId`, `manilaInstant`, `menuErrorMessage`, `confirmTokenFor`, `StoreChoice`, `storesInScope`, `CategoryRow`, `listCategories`, `OverviewItem`, `listOverviewItems`, `listActiveItemNames`, `listActiveStockItems`, `listActiveRecipes`, `OptionValueView`, `OptionGroupView`, `OfferHistoryRow`, `ItemPageData`, `loadItemPage`, `withOrgPrincipal`.
- [actions.ts](./actions.ts) — `createCategoryAction`, `editCategoryAction`, `retireCategoryAction`, `createItemAction`.
- [page.tsx](./page.tsx) — `MenuPage`.
- [typed-forms.ts](./typed-forms.ts) — `MENU_CATEGORY`.
- [items](./items/README.md) — Route namespace `/menu/items`. Menu catalogue, store prices, item requests and POS depletion-source controls.
- [prices](./prices/README.md) — Menu prices at `/menu/prices`. Menu catalogue, store prices, item requests and POS depletion-source controls.
- [requests](./requests/README.md) — Item requests at `/menu/requests`. Menu catalogue, store prices, item requests and POS depletion-source controls.
- [usage-source](./usage-source/README.md) — Usage source at `/menu/usage-source`. Menu catalogue, store prices, item requests and POS depletion-source controls.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `createCategoryAction`, `createItemAction`, `retireCategoryAction`, `editCategoryAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createHash`, `createMenuCategory`, `createMenuItem`, `retireMenuCategory`, `createCategoryAction`, `createItemAction`, `retireCategoryAction`; persistence or external operations belong to those called services.
- Repository calls: `accessRepo.storeIdsForPerson`, `menuRepo.offersInForce`, `menuRepo.dbNow`, `menuRepo.getItem`, `menuRepo.variantsOfItem`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 31,714 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
