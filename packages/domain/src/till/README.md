# Till
## Overview
Till custody (T-186): opening a shift, counting the till, closing it, and charging a shortage to a named person. A physical count versus the ledger is the cashier's variance; this is the first record that lets a shortage name a person.

## Interface
- `index.ts`: `STAFF_ADVANCE_ACCOUNT` (1230), `openTillShift`, `recordTillCount`, `closeTillShift`, `chargeTillShortage`, types `OpenShiftInput`, `CountInput`.

## Invariants
- Three variances, never confused: `tillFloatOffTarget` (books vs target, nobody answers), this module (physical count vs ledger, the cashier answers), and `remittance_variances` (batch vs owed).
- A shortage is a receivable from the staffer on `1230`, never a P&L account.
- A handover cannot cross stores (that is a transfer); the shift being taken over must exist.
- The attendance link is a reference only; this module stores no clock times.
- The float is a target on the single cashier drawer (`1110`), not a separate account.
- Charges go through `postStaffShortageCharge`, shared with remittance; amounts parsed with `parseMoneyInput`.
- Counting authorizes `record_till_count`; charging authorizes `resolve_till_variance`.
- Business refusals are thrown as errors (`refuse(...)` or `Error`).

## Side Effects
- Writes shifts and counts via `tillShiftsRepo`; reads money accounts via `moneyAccountsRepo`.
- A charged shortage posts a journal entry through `postStaffShortageCharge`.
- Opens a transaction via `transaction(...)` when `tx` is `null`.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
