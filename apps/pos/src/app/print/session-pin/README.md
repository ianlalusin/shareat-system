# src/app/print/session-pin contract

## Overview

Printable customer-join PIN/QR slip.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/print/session-pin`; `PrintPinPage`.

## Invariants

- Printing waits for a PIN, store/session context and resolved join URL state.

## Side Effects

- Subscribes to session data, fetches join-link data, reads paper preference and invokes the PIN print hook.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (9508 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
