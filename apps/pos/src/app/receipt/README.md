# src/app/receipt contract

## Overview

Single-receipt preview and 58/80mm printing.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/receipt`; `ReceiptPage`.

## Invariants

- A missing receipt selection renders an explicit notice.
- The role guard allows admin/manager/cashier.

## Side Effects

- Reads receipt/session/payment metadata, loads receipt settings and invokes the shared print hook.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (9801 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
