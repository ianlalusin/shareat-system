# src/app/online-orders contract

## Overview

Online-order management route.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/online-orders`; `OnlineOrdersPage`.

## Invariants

- The page delegates the workflow to OnlineOrdersClient.

## Side Effects

- Mounts the client that subscribes to orders and issues workflow API calls.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (166 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
