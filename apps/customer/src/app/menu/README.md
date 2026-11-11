# apps/customer/src/app/menu

## Overview

Categorized menu and cart quantity controls at /menu.

## Interface

- Default Page wraps MenuScreen in RequireSession; useLive loads getMenu with order-change subscription disabled.

## Invariants

- Refills display Included; displayed prices come from menu data and are not copied into order lines.
- Cart quantity updates use shared provider helpers.

## Side Effects

- Reads menu data and changes provider cart state through addToCart/setCartQty; no order is sent from this screen.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
