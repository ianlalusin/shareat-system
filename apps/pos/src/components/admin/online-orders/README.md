# src/components/admin/online-orders contract

## Overview

Online-order client and open/delivery/pricing controls.

## Interface

- [DeliveryAvailabilityControl.tsx](./DeliveryAvailabilityControl.tsx) — `DeliveryAvailabilityControl`.
- [DeliveryPricingSettings.tsx](./DeliveryPricingSettings.tsx) — `DeliveryPricingSettings`.
- [OnlineAvailabilityControl.tsx](./OnlineAvailabilityControl.tsx) — `SelectedMode`, `OnlineAvailabilityControl`.
- [OnlineOrdersClient.tsx](./OnlineOrdersClient.tsx) — `buildTrustSignal`, `OnlineOrdersClient`.

## Invariants

- Delivery availability is independent of pickup.
- Pricing saves re-fetch raw configuration before writing so unrelated fields survive.

## Side Effects

- Subscribes to Firestore orders/threads and calls storefront/workflow HTTP APIs; availability controls emit callbacks.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 4 direct source files (29566 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
