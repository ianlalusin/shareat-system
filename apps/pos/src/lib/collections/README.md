# src/lib/collections contract

## Overview

Fetch/subscription adapters for global discounts and charges with date/store applicability.

## Interface

- [globalCollections.ts](./globalCollections.ts) — `todayDateString`, `isDiscountDateActive`, `discountDateStatus`, `fetchApplicableGlobalDiscounts`, `fetchApplicableGlobalCharges`, `subscribeApplicableGlobalDiscounts`, `subscribeApplicableGlobalCharges`.

## Invariants

- Start and end dates bound discount activity.
- Date helpers accept an injected current date for deterministic evaluation.

## Side Effects

- Fetches global Firestore collections and creates snapshot subscriptions whose unsubscribe is returned.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (3506 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
