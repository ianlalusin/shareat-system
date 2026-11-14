# Cash Requests
## Overview
Cash requests (T-144): a float handed to a person and what comes back. Owns creating, deciding, cancelling, releasing and settling a request. Only release and settlement touch the ledger; asking for money is not a financial event.

## Interface
- `index.ts`: `STAFF_FLOAT_CODE` (1120), `STAFF_ADVANCE_CODE` (1230), `createCashRequest`, `decideCashRequest`, `cancelCashRequest`, `releaseCashRequest`, `settleCashRequest`, types `CreateCashRequestInput`, `SettleResult`.

## Invariants
- Posting shapes: release DR 1120 / CR funding account; return DR funding account / CR 1120; shortage DR 1230 / CR 1120 so 1120 nets to zero. Spend (DR expense / CR 1120) is posted by the expenses module, not here.
- The request itself posts nothing (bible 16.10).
- A shortage is charged to the person holding the float (1230 is party-bearing, `party_type = 'employee'`), never to nobody.
- Create/cancel authorize `create_expense`; decide/release/settle authorize `approve_expense`, all at the request's own store.
- Typed fields are validated by the `CASH_REQUEST_*_RULES` field rules.

## Side Effects
- Writes cash requests via `cashRequestsRepo`; appends `audit_log` rows.
- Release and settlement post journal entries via `postEntry`.
- Opens a transaction via `transaction(...)` when `tx` is `null`.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
