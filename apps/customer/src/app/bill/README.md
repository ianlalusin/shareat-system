# apps/customer/src/app/bill

## Overview

Read-only estimated add-on bill at /bill.

## Interface

- Default Page wraps BillScreen in RequireSession; useLive calls CustomerData.getBill.

## Invariants

- Bill is an estimate for the cashier to finalize; refills remain included and are not added to its total.
- Money display uses peso rather than recomputing amounts in the screen.

## Side Effects

- Loads the bill and subscribes to session order changes through useLive; renders returned values without a payment mutation.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
