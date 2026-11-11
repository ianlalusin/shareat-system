# apps/customer/src/data

## Overview

CustomerData contract, diner-facing types, in-memory fixture and React context.

## Interface

- CustomerData defines PIN/QR joins, menu/order/bill reads, order placement, feedback, demo sign-up/sign-in and subscribe with an unsubscribe return.
- CustomerProvider and useCustomerData/useDemoControls/useSession/useCart/useNotice expose state to screens; createFixtureCustomerData supplies the sample implementation.
- types.ts exports Store, TableSession, MenuItem, OrderLine, Order, Bill, Result, SignUpInput, Member and OrderEvent; fixtures.ts exports DEMO_STORES, DEMO_TABLES and DEMO_MENU.

## Invariants

- OrderLine carries itemId and qty only; Money values remain strings and bills are estimates.
- The fixture caps quantities at 20, seats a device once per table, deduplicates requests per session, and applies per-device PIN throttling.
- Demo state resets on reload. These fixture checks are examples, not deployed server authorization.

## Side Effects

- The fixture mutates in-memory maps/sets and notifies session subscribers; no live backend request is implemented.
- The provider reads/writes shareat.customer.device in localStorage and shareat.customer.session in sessionStorage after mount, catches unavailable-storage errors, and cleans up subscriptions.
- Demo member passwords and verification codes exist only in fixture memory; no SMS is sent.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
