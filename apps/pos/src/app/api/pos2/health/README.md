# src/app/api/pos2/health contract

## Overview

GET `/api/pos2/health` reachability/version endpoint.

## Interface

- [route.ts](./route.ts) — `runtime`, `dynamic`, `GET`.

## Invariants

- The endpoint uses nodejs runtime and force-dynamic execution.
- Version comes from the POS package/build configuration.
- This endpoint is deliberately unauthenticated and dependency-free so it can answer when backing services are down.

## Side Effects

- Returns a JSON health response without invoking the protected-operation dependency builder.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (888 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
