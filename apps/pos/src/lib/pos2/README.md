# src/lib/pos2 contract

## Overview

Authenticated POS2 client transport and interpretation of uncertain void outcomes.

## Interface

- [client.ts](./client.ts) — `Pos2Error`, `POS2_UNREACHABLE`, `postPos2`.
- [voidOutcome.ts](./voidOutcome.ts) — `ALREADY_VOIDED`, `voidOutcome`.

## Invariants

- Calls require a current Firebase ID token.
- An unreachable response is an unknown outcome; retries retain the same request identity.
- Only the exact already-voided response is treated as confirmation of an existing void.

## Side Effects

- POSTs to `/api/pos2/*` with token/device information and throws structured Pos2Error refusals.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (3082 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
