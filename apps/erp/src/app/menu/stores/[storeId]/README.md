# stores/[storeId]

## Overview

"What this store sells" at `/menu/stores/[storeId]` (T-632). Every active company menu item for one store, switched on or off, with its price per menu hour, a kitchen-station warning, and the flavours of each item. Parent blueprint: [up one directory](../../README.md).

## Interface

- Page route `/menu/stores/[storeId]`; the store is the path segment and must be one of the viewer's stores.
- [actions.ts](./actions.ts): `switchOnAction`, `switchOffAction`, `flavourAction`.
- [page.tsx](./page.tsx): `StoreSellsPage`.

## Invariants

- Writes go only through the domain switches `switchVariantOn`, `switchVariantOff`, `switchOptionValue` (packages/domain/src/menu/store-menu.ts), which authorize `set_menu_price` at the store first and call the existing `setMenuOffer`, `withdrawMenuOffer` and `setOptionOffer` in one transaction.
- Online channel prices are not edited here (Menu > Prices). Route editing is not here (Kitchen).
- The page reads through `requirePageAccess` and `loadStoreSells`; the controls shown are presentation only.
