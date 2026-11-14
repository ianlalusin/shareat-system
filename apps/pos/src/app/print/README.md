# src/app/print contract

## Overview

Boundary index for session-pin.

## Interface

- [session-pin](./session-pin/README.md) — Printable customer-join PIN/QR slip.

## Invariants

The following child-contract rules apply within their owning child boundaries.

- Printing waits for a PIN, store/session context and resolved join URL state.

## Side Effects

- Child boundary behavior: Subscribes to session data, fetches join-link data, reads paper preference and invokes the PIN print hook.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.
