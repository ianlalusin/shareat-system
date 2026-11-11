# Trade
## Overview
Trade orders (T-132, T-133): one ordering and fulfilment flow with two accounting treatments derived from the counterparty (ADR-008 section 8). An external customer or franchise gets a real sale (AR + wholesale revenue); an internal branch gets the commissary transfer that eliminates on consolidation. `returns.ts` (T-179) handles customer returns and credit application.

## Interface
- `index.ts`: `WHOLESALE_REVENUE_CODE` (4300), `assertTradeTotalReconciles`, `createTradeOrder`, `confirmTradeOrder`, `dispatchTradeOrder`, `voidTradeOrder`, `receiveTradeOrder`, `setBirInvoiceNo`, types `TradeLineDraft`, `CreateTradeOrderInput`, `DispatchResult`, `ReceiveTradeOrderLineInput`, `ReceiveTradeOrderInput`, `ReceiveTradeOrderResult`.
- `returns.ts`: `RETURN_REVENUE_CODE` (4950), `CUSTOMER_RETURN_UNSELLABLE_REASON`, `customerReturnableQuantity`, `customerCreditBalance`, `recordCustomerReturn`, `voidCustomerReturn`, `applyCredit`, types `RecordCustomerReturnLineInput`, `RecordCustomerReturnInput`, `RecordCustomerReturnResult`, `RecordCustomerReturnOutcome`, `VoidCustomerReturnOutcome`, `ApplyCreditOutcome`.

## Invariants
- A branch is not a customer of its own company: internal dispatch never books revenue.
- Dispatch is the billing event and bills by calling `recordCharge` (AR), so exactly one function owns the `1210`/revenue legs (no double recognition).
- Internal dispatch relieves the commissary's real stock layers; both stores' books move at `receiveTradeOrder`, keyed to what actually arrived. `5170`/`5175` are no longer posted here.
- `assertTradeTotalReconciles` is a pure, directly callable check that refuses non-finite or mismatched totals.
- Two-actor branch orders: `authorizeEither` asks each alternative with non-logging `can()` and, if all fail, re-asks the first with `authorize()` so the refusal shown matches the intended action.
- Returns: cap is `receivedQuantity` for an internal order and `fulfilledQuantity`/`quantity` for external, minus quantity already returned. An external return reverses the sale's own consumption (`reverseConsumption`); an internal one consumes the branch layer fresh and creates a commissary layer.
- Returns reverse revenue (`4950`), cost and stock, and respect the closed-stock-period guard.
- Void reverses journal entries with one shared instant stamped on every reversal.

## Side Effects
- Writes trade orders/lines, customer returns, stock layers and movements, and `audit_log` rows via repos.
- Posts and reverses journal entries (`postEntry` via AR, `reverseEntry`).
- Functions open a transaction via `transaction(...)` when `tx` is `null`; otherwise join the caller's.
- Reads the clock (`new Date()`) when voiding.
- Authorizes `dispatch_branch_order`, `approve_buyer`, `apply_customer_credit`, `void_customer_return` (among others).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
