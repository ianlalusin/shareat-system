# Money Accounts
## Overview
The places money sits (ADR-010): creating, renaming and retiring money accounts, setting a till float, and the single draw-verdict rule that decides whether an account may give up money. A thin service over `moneyAccountsRepo`; the repo owns SQL, this module owns the gate and the intent-level rules.
## Interface
- `index.ts`: `glCodeFor`, `createMoneyAccount`, `retireMoneyAccount`, `renameMoneyAccount`, `setTillFloat`, type `CreateMoneyAccountInput`; re-exports `judgeDraw`, `checkDraw`, `DrawVerdict` from `./overdraft`.
- `draw-verdict.ts` (no DB import, safe in a browser bundle): `judgeDraw(account, available, drawn)`, types `DrawableAccount`, `DrawVerdict`.
- `overdraft.ts`: `checkDraw(tx, orgId, account, drawn, context)`; re-exports `judgeDraw`, `DrawVerdict`, `DrawableAccount`.
## Invariants
- Adding, renaming and retiring an account require `manage_chart_of_accounts` (org-scoped, admin-only); `setTillFloat` requires `set_cash_policy`. Input rules (`assertFieldRules`) run only after `authorize()`.
- The GL code is derived by `glCodeFor`, never chosen: non-cash is always 1140; cash is 1110 (cashier), 1120 (staff), 1130 (office). Instrument and custodian are not editable (they decide the GL code).
- Retire, never delete: a foundation account cannot be retired while its store is trading, and an account still holding a balance cannot be retired.
- One cash location per custodian per store (they would share one GL account with no party to tell lines apart).
- `judgeDraw` is the ONE definition of "can this account cover it", pure and exact (Money compared in centavos): a cashier drawer may run behind down to its `overdraftLimit` (warning, `blocked: false`), past it is blocked; office and staff balances are complete, so any shortfall is blocked. `floatTarget` is not consulted.
- Availability is what the LEDGER says (`moneyAccountsRepo.balanceOf`), never a stored figure; `checkDraw` throws on `blocked` and returns the warning message otherwise.
- `draw-verdict.ts` must not import `@shareat/db` (client bundle boundary); `overdraft.ts` and `shared/money-lines.ts` re-export it.
- A till float is a target only: setting it does not put money in the drawer; clearing (null) with no target is a no-op.
## Side Effects
- DB writes via `moneyAccountsRepo` (create, rename, retire, set float) on the caller's `Tx`, or a fresh `transaction` when `tx` is `null` (create and retire).
- Reads ledger balances and store records via the repos. No ledger posting, clock, network or disk access.
## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
