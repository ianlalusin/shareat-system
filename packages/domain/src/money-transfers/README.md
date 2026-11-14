# Money Transfers
## Overview
Moves money between money accounts (cashier or office, any direction) as one balanced ledger entry, and settles inter-store debt. Transfers are manager-level (`transfer_funds`), not admin-only: they record something that happened, unlike opening an account (T-139, bible row 150). Cross-store transfers carry the 1250/2150 due-from/due-to pair so each store's books balance on their own.

## Interface
- `index.ts`: `createMoneyTransfer`, `voidMoneyTransfer`, `CreateMoneyTransferInput`, `CreateMoneyTransferResult`; re-exports `settleBetweenStores`, `SettleBetweenStoresInput`, `SettleBetweenStoresResult`
- `settle.ts`: `settleBetweenStores`, `SettleBetweenStoresInput`, `SettleBetweenStoresResult`
- `prepare.ts` (internal; `index.ts` does not re-export it): `prepareTransfer`, `PreparedTransfer`, `DEFAULT_FEE_ACCOUNT_CODE` (`6870`)

## Invariants
- Both `amountOut` (left the source) and `amountIn` (reached the destination) are stated; the fee is DERIVED as the difference and posts to the fee account (default 6870 Bank charges).
- A retired account cannot be either end of a transfer.
- Overdraw rule (bible row 154): `checkDraw` is shared with `approveExpense`; a cashier account whose day is unverified may overdraw, returning a `warning` the caller must show.
- Cross-store: the source store is owed what actually LANDED (not what left); the 1250/2150 pairs must eliminate at entity level (total 1250 equals total 2150).
- Settlement (`settleBetweenStores`) is the same single entry as the cash move plus a CLEARING pair (Dr 2150 at the debtor, Cr 1250 at the creditor), capped by what the ledger says is owed, so a repayment never adds a second opposite debt. `sourceType` stays `'transfer'` (a new type would leak into remittance figures). Authorization is `transfer_funds` at BOTH stores.
- `createMoneyTransfer` and `settleBetweenStores` share `prepareTransfer` (loads both ends, authorizes, builds legs); do not fork the logic.
- Void requires `transfer_funds` at the transfer's store and, for a cross-store transfer, at the destination store too.

## Side Effects
- DB writes via `moneyTransfersRepo` inside a transaction; functions taking `tx: Tx | null` open their own `transaction` when null.
- Ledger: transfers and settlements post through `postEntry`; void reverses the entry.
- `authorize()` runs for each store involved.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
