# src/lib/storefront contract

## Overview

Delivery/pricing sanitization and online-order availability calculations.

## Interface

- [delivery-config.ts](./delivery-config.ts) — `DeliveryConfigInput`, `DeliveryConfig`, `sanitizeDeliveryConfig`.
- [online-hours.ts](./online-hours.ts) — `OnlineOrderMode`, `OnlineAvailabilityInput`, `isWithinStoreHours`, `OnlineAvailability`, `computeOnlineAvailability`.

## Invariants

- Availability combines automatic store hours and manual controls.
- Invalid/missing opening-hour values retain the explicitly coded permissive fallback.
- Delivery form values are sanitized before set-config submission.

## Side Effects

- Returns configuration/availability values; no direct network or storage calls in these helpers.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (4365 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
