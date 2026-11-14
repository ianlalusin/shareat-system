# src/app/api/pos2/analytics contract

## Overview

Boundary index for apply-delta.

## Interface

- [apply-delta](./apply-delta/README.md) — POST `/api/pos2/analytics/apply-delta` adapter for analytics updates.

## Invariants

The following child-contract rules apply within their owning child boundaries.

- The route exports nodejs runtime and force-dynamic execution.
- Request handling passes through `runPos2Route` and `handleApplyDelta`.

## Side Effects

- Child boundary behavior: Delegates authentication/validation and Firestore effects to the server handler; returns its Response.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.
