# src/app/api/pos2 contract

## Overview

Boundary index for analytics, conversions, health, refunds, session-voids, tender-corrections.

## Interface

- [analytics](./analytics/README.md) — Boundary index for apply-delta.
- [conversions](./conversions/README.md) — POST `/api/pos2/conversions` adapter for payment-method conversion.
- [health](./health/README.md) — GET `/api/pos2/health` reachability/version endpoint.
- [refunds](./refunds/README.md) — POST `/api/pos2/refunds` adapter for cash refund.
- [session-voids](./session-voids/README.md) — POST `/api/pos2/session-voids` adapter for unpaid-session void.
- [tender-corrections](./tender-corrections/README.md) — POST `/api/pos2/tender-corrections` adapter for paid-receipt tender correction.

## Invariants

The following child-contract rules apply within their owning child boundaries.

- The route exports nodejs runtime and force-dynamic execution.
- Request handling passes through `runPos2Route` and `handleApplyDelta`.
- Request handling passes through `runPos2Route` and `handleConversion`.

## Side Effects

- Child boundary behavior: Delegates authentication/validation and Firestore effects to the server handler; returns its Response.
- Child boundary behavior: Returns a JSON health response without invoking the protected-operation dependency builder.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.
