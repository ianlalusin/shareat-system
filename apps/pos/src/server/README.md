# src/server contract

## Overview

Boundary index for pos2.

## Interface

- [pos2](./pos2/README.md) — Server ports and protected handlers for analytics, refunds, conversions and related manager-approved POS operations.

## Invariants

The following child-contract rules apply within their owning child boundaries.

- Identity verifies JSON, bearer token and server-side staff/store context before protected work.
- Manager approval validates device/PIN through an injected approval port.
- Refund amount and prior-refund limits are recomputed from server records; client counters are not authority.

## Side Effects

- Child boundary behavior: Builds Firebase Admin/auth dependencies from server configuration and performs Firestore transactions.
- Child boundary behavior: Handlers produce JSON responses; dependency setup can read a configured credential file at runtime (not read during this documentation task).

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.
