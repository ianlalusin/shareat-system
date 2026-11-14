# src/lib/statutory contract

## Overview

Senior/PWD identity capture, diner shares, exact totals and receipt/payment integration.

## Interface

- [capture.ts](./capture.ts) — `normalizeIdNo`, `maskIdNo`, `resolveHeads`, `addStatutoryDiner`, `removeStatutoryDiner`, `assignDishToDiner`, `statutoryPaymentBlockers`, `statutoryActivityEntry`, `maskDinersForClosedSession`.
- [mutations.ts](./mutations.ts) — `mutateStatutoryDiners`.
- [payment.ts](./payment.ts) — `assertStatutoryPaymentReady`.
- [session.ts](./session.ts) — `StatutorySession`, `statutoryInputOf`, `receiptStatutoryDiners`.
- [shares.ts](./shares.ts) — `StatutoryInput`, `statutoryShares`, `pruneDishAssignments`.
- [totals.ts](./totals.ts) — `statutoryTotals`.

## Invariants

- ID normalization and masking are separate from the full identity retained at receipt capture.
- Diner mutations require the actor to match the authenticated Firebase user and a valid store/session path.
- Payment readiness runs before sale numbering/writes and can require online reversal of a points reward.

## Side Effects

- Runs Firestore session transactions and can DELETE a blocked loyalty redemption through HTTP.
- Share/allocation/totals helpers calculate values without external writes.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 6 direct source files (25940 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
