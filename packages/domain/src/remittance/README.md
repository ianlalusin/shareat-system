# Remittance
## Overview
Pooled remittance (T-143): one cashier handover settling many end-day reports. What is remitted is the end-day report (the cashier's net movement for a date), not the sales report. A remittance posts nothing of its own; each line moves through `createMoneyTransfer`, and a charged shortage posts a separate entry.

## Interface
- `index.ts`: `createRemittance`, `reverseRemittance`, `resolveRemittanceVariance`, `remittanceStateOf`, `setStoreCashPolicy`, types `RemittanceLineInput`, `CreateRemittanceInput`, `CreateRemittanceResult`; re-exports `allocateFifo` and types `DayOwed`, `Allocation`, `AllocationResult`.
- `allocate.ts` (pure): `allocateFifo(days, handedOver)`, types `DayOwed`, `Allocation`, `AllocationResult`.
- `audit.ts`: `recordRemittanceEvent` (writes the `remittance.recorded` audit row).

## Invariants
- FIFO: pay the oldest owed day first; a shortage or overage is recorded on the last day the org OWED, not the last day touched (DEF-398/399).
- `allocateFifo` is pure and compares with `@shareat/core/money` (`compare`/`isZero`), never float round-trips. It is deliberately not merged with `shared/allocate-oldest-first.ts`.
- A day becomes remittable when its sales day is verified (the lock).
- One posting path: remittance lines go through `createMoneyTransfer`; the only other posting is the charged shortage (Dr 1230 person / Cr cashier account) via `postStaffShortageCharge`, a separate entry with `source_type 'remittance_variance'`, excluded from what a day owes (`CUSTODY_SOURCE_TYPES`), and reversed with the remittance.
- Reversal locks and RE-READS status (two reversals must not both pass `posted`); a reason is required.
- Variance resolution refuses unless the variance is `open`.
- The audit event lives in `audit.ts` so the action-coverage scan does not misread `action:` type members in `index.ts`.

## Side Effects
- Writes remittance, remittance-line, allocation and variance rows via `remittanceRepo`.
- Posts and reverses journal entries (`postEntry`/`reverseEntry`) and money transfers (`createMoneyTransfer`/`voidMoneyTransfer`).
- Appends `audit_log` rows in the same transaction; `createRemittance` and `reverseRemittance` open a transaction via `transaction(...)`.
- Authorizes `accept_remittance` and `set_cash_policy`.
- `allocate.ts`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
