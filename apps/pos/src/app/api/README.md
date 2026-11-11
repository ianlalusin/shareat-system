# src/app/api contract

## Overview

Boundary index for pos2.

## Interface

- [pos2](./pos2/README.md) — Boundary index for analytics, conversions, health, refunds, session-voids, tender-corrections.

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
