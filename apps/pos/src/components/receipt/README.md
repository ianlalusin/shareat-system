# src/components/receipt contract

## Overview

Receipt preview/print markup.

## Interface

- [receipt-view.tsx](./receipt-view.tsx) — `ReceiptView`.

## Invariants

- Persisted VAT split is preferred for historical receipts.
- Senior/PWD IDs are masked on screen and included in print markup.

## Side Effects

- Renders sensitive receipt data supplied by the caller; no direct SDK write in this view.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (12990 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
