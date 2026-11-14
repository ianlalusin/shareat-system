# Liabilities
## Overview
Generic liabilities (T-128): what the business owes that no other module tracks. Charges credit control account `2500` with the liability as the party; payments debit it, so `2500` nets to zero when settled.

## Interface
- `index.ts`: `LIABILITY_CONTROL_CODE` (2500), `createLiability`, `chargeLiability`, `payLiability`, `reverseLiabilityEntry`, `retireLiability`, `isOverdue`, type `CreateLiabilityInput`.

## Invariants
- Posting shapes: charge DR expense (or asset) / CR 2500 (party = the liability); payment DR 2500 (party = it) / CR money account.
- No stored totals (DEF-074): every figure is summed from `2500` by party.
- Amounts are parsed after `authorize()` into a `(14,2)` brand; commas or a third decimal are refused.
- All writes authorize `approve_expense` at the liability's store.
- Reversal goes through `reverseEntry`; retiring sets `retiredAt`.

## Side Effects
- Writes liabilities via `liabilitiesRepo`; posts and reverses journal entries (`postEntry`/`reverseEntry`).
- `retireLiability` stamps `retiredAt` with `new Date()`.
- Opens a transaction via `transaction(...)` when `tx` is `null`.
- `isOverdue`: None (pure function).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
