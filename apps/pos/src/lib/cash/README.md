# src/lib/cash contract

## Overview

Cash method identification, handover calculations and durable submission-attempt handling.

## Interface

- [cash-method.ts](./cash-method.ts) — `isCashMethod`.
- [convert-net.ts](./convert-net.ts) — `ConversionLike`, `NEGATIVE_METHOD_NOTICE`, `parseCashAdjustment`, `convertNetPesos`, `handoverReadFrom`, `computeExpectedCash`, `convertLineText`, `buildHandoverRecord`, `negativeMethods`.
- [handover-submit.ts](./handover-submit.ts) — `HandoverAttempt`, `readHandoverAttempt`, `saveHandoverAttempt`, `commitHandover`.
- [handover.ts](./handover.ts) — `getShiftDayStartMs`, `getCashMethodNames`, `computeCashSales`, `computeHandoverCash`.

## Invariants

- Calculations use whole centavos internally and convert at the Firestore/display boundary.
- A nonzero manual cash adjustment requires a reason.
- A saved handover request keeps its original ID across uncertain acknowledgments; a failed promise does not prove rollback.

## Side Effects

- Reads cash methods and sales from Firestore, persists a pending attempt in supplied storage, and submits handover transactions.
- Confirmation reads bypass the cache when the outcome is uncertain.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 4 direct source files (12504 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
