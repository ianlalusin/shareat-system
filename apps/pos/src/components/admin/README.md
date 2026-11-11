# src/components/admin contract

## Overview

Boundary index for online-orders.

## Interface

- [online-orders](./online-orders/README.md) — Online-order client and open/delivery/pricing controls.

## Invariants

The following child-contract rules apply within their owning child boundaries.

- Delivery availability is independent of pickup.
- Pricing saves re-fetch raw configuration before writing so unrelated fields survive.

## Side Effects

- Child boundary behavior: Subscribes to Firestore orders/threads and calls storefront/workflow HTTP APIs; availability controls emit callbacks.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.
