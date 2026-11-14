# Prepaid
## Overview
Prepaid items (T-125): an expense already paid but not yet used up (insurance, a permit, rent in advance). It sits at `1400` and is released into the P&L monthly. Owns create/confirm, amortisation, reversal, write-off and the system amortisation run.

## Interface
- `index.ts`: `PREPAID_ACCOUNT_CODE` (1400), `AMORTISATION_EXPENSE_CODE` (6750), `prepaidSchedule`, `createPrepaidItem`, `confirmPrepaidTerm`, `amortisePrepaidItem`, `checkFullyAmortised`, `reverseAmortisation`, `writeOffPrepaidItem`, `undoWriteOff`, `runAmortisationAsSystem`, types `CreatePrepaidItemInput`, `AmortiseResult`, `WriteOffInput`, `AmortiseAllResult`.

## Invariants
- Unlike fixed assets: `1400` alone is decremented directly (no contra account; do not add one for symmetry), no salvage (runs to zero), monthly interval only, and the term is a contract (`coverage_months`).
- The straight-line arithmetic is shared with fixed assets via `shared/straight-line.ts`; do not copy it.
- Typed fields are parsed after `authorize()` on the value (DEF-481).
- `runAmortisationAsSystem` applies the system org principal inside each per-item transaction, not once around the loop, so one item's failure does not affect the others.
- Create/confirm/write-off/undo authorize `manage_prepaid_items`; amortise/reverse authorize `run_amortisation`.

## Side Effects
- Writes prepaid items and schedule rows via `prepaidRepo`; posts and reverses journal entries (`postEntry`/`reverseEntry`).
- Opens a transaction via `transaction(...)` when `tx` is `null`; `runAmortisationAsSystem` runs under `withSystemOrgPrincipal`.
- `prepaidSchedule`: None (pure function).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
