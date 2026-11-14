# apps/customer/src/lib

## Overview

Cart operations, Money display, request ids and live data loading.

## Interface

- cart.ts exports Cart, MAX_QTY, emptyCart, setQty, addItem, removeItem, cartCount and toOrderLines.
- format.ts exports peso; ids.ts exports newId; use-live.ts exports LiveState and useLive.

## Invariants

- Cart helpers return new structures and carry item ids/quantities rather than prices; finite quantities are floored and capped at 20.
- useLive only loads once a session exists and ignores asynchronous results after unmount.

## Side Effects

- Cart and Money helpers have no external writes; newId reads browser crypto or time/random fallback.
- useLive invokes the injected CustomerData loader and optionally subscribes to session order changes; cleanup unsubscribes.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
