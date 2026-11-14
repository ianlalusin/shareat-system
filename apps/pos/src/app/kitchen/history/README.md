# src/app/kitchen/history contract

## Overview

Client-loaded kitchen history route.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/kitchen/history`; `KitchenHistoryPage`.

## Invariants

- The history client is loaded dynamically behind Suspense.

## Side Effects

- Mounts HistoryPageClient and its store-scoped history queries.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (646 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
