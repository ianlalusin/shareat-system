# apps/customer/src/app/orders

## Overview

Joined-table order history and demo progress at /orders.

## Interface

- Default Page wraps OrdersScreen in RequireSession; useLive loads orders and menu names.

## Invariants

- Status labels cover preparing, partly_served, served and cancelled.
- Demo advance controls appear only when demo controls exist and the order is preparing or partly served.

## Side Effects

- Subscribes to order changes, reads the menu once per session, and invokes demo.advanceOrder only in the fixture demo.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
