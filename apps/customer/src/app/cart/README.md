# apps/customer/src/app/cart

## Overview

Diner cart editing and idempotent order submission at /cart.

## Interface

- Default Page wraps CartScreen in RequireSession; uses cart provider helpers and CustomerData.placeOrder.

## Invariants

- Submissions contain only item ids, quantities and one request id per attempt; retry keeps that id until the cart changes.
- Empty carts and busy submissions cannot send another order.

## Side Effects

- Edits provider cart state; successful placement clears the cart and navigates to /orders; current CustomerData is an in-memory fixture.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
