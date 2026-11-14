# src/app/refill contract

## Overview

Compatibility redirect to the server floor screen.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/refill`; `RefillPage`.

## Invariants

- The former refill route has one destination.

## Side Effects

- Replaces the route with `/server` on mount.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (250 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
