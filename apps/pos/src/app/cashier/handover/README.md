# src/app/cashier/handover contract

## Overview

Cash handover route mounting CashHandoverClient.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/cashier/handover`; `CashHandoverPage`.

## Invariants

- The role guard allows admin/manager/cashier.

## Side Effects

- The mounted client reads handover history and submits through cash handover helpers.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (317 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
