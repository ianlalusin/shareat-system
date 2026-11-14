# Statutory Discounts
## Overview
The SC/PWD statutory register (RR 5-2017 s5.9 PWD, RR 7-2010 senior), T-137: a parallel record of senior/PWD discounts for BIR purposes. It is not part of the books.

## Interface
- `index.ts`: `recordStatutoryDiscount`, `voidStatutoryDiscount`, `listStatutoryDiscounts`, `summariseStatutoryDiscounts`, types `RecordStatutoryDiscountInput`, `VoidStatutoryDiscountInput`, `ListStatutoryDiscountsQuery`.

## Invariants
- Posts nothing, by design (bible row 75): the daily `sales_days` senior/PWD totals remain the only route to `4900`. The ledger must not move.
- `holderName` and `idNumber` cannot be derived (read off a physical card), so a row must be entered while the customer is present; hence `record_statutory_discount` is staff-open.
- No discount rate is enforced; the rate is recorded, never judged.
- Amounts are parsed after `authorize()` into the `(14,2)` brand.
- Void authorizes `void_statutory_discount`.

## Side Effects
- Writes and voids register rows via the repo; reads for list/summary.
- Opens a transaction via `transaction(...)` for each public function.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
