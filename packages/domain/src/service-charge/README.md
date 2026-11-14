# Service Charge
## Overview
`distributeServiceCharge` (T-187 slice 1, closes the DEF-082 discharge path): records that a store's service-charge float (account `2160`) was handed to staff, and by how much. It does not split the amount per employee.

## Interface
- `index.ts`: `distributeServiceCharge(...)`.

## Invariants
- Posting shape: DR `2160` (that store) / CR the money account, both at `store_id = storeId`.
- The cap is that store's own `2160` balance, derived from the ledger (never a stored column); a store may not spend another store's float. Exceeding it refuses (never clamps), strictly before any write.
- No per-employee, eligibility or rounding logic; the split is processed by hand. There is no org-wide form: one store per call.
- The money account must belong to `storeId`.
- Authorizes `approve_expense` at the store.

## Side Effects
- Posts one journal entry via `postEntry` inside a transaction (`transaction(...)`).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
