# src/app/api/pos2/session-voids contract

## Overview

POST `/api/pos2/session-voids` adapter for unpaid-session void.

## Interface

- [route.ts](./route.ts) — `runtime`, `dynamic`, `POST`.

## Invariants

- The route exports nodejs runtime and force-dynamic execution.
- Request handling passes through `runPos2Route` and `handleSessionVoid`.

## Side Effects

- Delegates authentication/validation and Firestore effects to the server handler; returns its Response.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (450 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
