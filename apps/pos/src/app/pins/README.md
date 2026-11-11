# src/app/pins contract

## Overview

Session/customer PIN listing and issue/finalize controls.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/pins`; `PinsPage`.
- [pins-client.tsx](./pins-client.tsx) — `PinsClient`.

## Invariants

- The active store scopes session/PIN reads; print navigation carries the selected session ID.

## Side Effects

- Subscribes to Firestore sessions, remembers finalized PIN state and invokes issue/finalize HTTP endpoints.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (10324 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
