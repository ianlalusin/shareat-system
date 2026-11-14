# Accounts Receivable
## Overview
Accounts receivable (T-131), deliberately the mirror of `ap`: charges, collections, voids and write-offs, with the same allocation discipline and no stored balance. Where AP's surplus becomes `1240`, AR's becomes `2140` customer store credits payable. The platform fee is booked here exactly once.

## Interface
- `index.ts`: `AR_CONTROL_CODE`, `STORE_CREDIT_CODE`, `recordCharge`, `recordChargeWithCollection`, `previewCreditExposure`, `voidCharge`, `recordCollection`, `voidCollection`, `writeOffCharge`, `suggestCollectionAllocation`, types `RecordChargeInput`, `PayNowInput`, `RecordChargeWithCollectionInput`, `ArAllocationInput`, `RecordCollectionInput`, `ArOrderingKeys`, `SuggestArAllocationResult`.

## Invariants
- The platform fee is recognised once (v1 recognised it twice, costing PHP 198,148.29); `POSTING-PATTERNS.md` `ar_collection` is the authority for the legs.
- AR figures are summed from the ledger, never stored.
- Collections allocate oldest-first; surplus goes to `STORE_CREDIT_CODE` (`2140`).
- Charging (the one act that creates AR exposure) authorizes `approve_buyer` and enforces the credit limit at the full total; an override carries a `creditOverrideReason` (DEF-158).
- Voids reverse the original entry via `reverseEntry`; write-offs require `write_off_receivable`.

## Side Effects
- Writes charges, collections and allocations via `arRepo` and customer data via `customersRepo`; appends `audit_log` rows.
- Posts and reverses journal entries (`postEntry`/`reverseEntry`).
- Opens a transaction via `transaction(...)` when `tx` is `null`.
- Authorizes `approve_buyer`, `record_ar_collection`, `write_off_receivable`, `transfer_funds`.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
