# src/components/receipts contract

## Overview

Manager-approved refund and tender-correction dialogs.

## Interface

- [RefundReceiptDialog.tsx](./RefundReceiptDialog.tsx) — `CASH_ONLY_SENTENCE`, `RefundReceiptDialog`.
- [TenderCorrectionDialog.tsx](./TenderCorrectionDialog.tsx) — `TenderCorrectionDialog`.

## Invariants

- Refunds require internet and currently support cash only.
- Tender correction records movement through the server instead of editing the paid receipt.

## Side Effects

- Submits protected POS2 requests and updates dialog/callback state after results.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (20005 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
