# Loans
## Overview
A deliberately standard loan model (T-126, bible row 158): a debt, money in, money out, interest recognised when paid. It owns creating a loan agreement, posting disbursements and payments to the ledger, and reversing a loan posting. v1's specifics (channel auto-deduct, cross-store paydown) are NOT here; they layer on top.

## Interface
- `index.ts`: `LOAN_LIABILITY_CODE` (`'2400'`), `INTEREST_EXPENSE_CODE` (`'7200'`), `CreateLoanInput`, `createLoan`, `disburseLoan`, `RecordPaymentResult`, `recordLoanPayment`, `reverseLoanEntry`; also re-exports everything in `interest.ts`.
- `interest.ts`: types `RatePeriod`, `InterestMethod`, `AccruedInput`, `SplitInput`, `PaymentSplit`, `InstalmentInput`; functions `dailyRate`, `accruedInterest`, `splitPayment`, `scheduledInstalment`, `totalOf`, `remainingOf`.

## Invariants
- `createLoan` moves no money: a signed, undrawn loan is a commitment, not a debt.
- Disbursement posts DR money account / CR `2400`; payment posts DR `2400` principal, DR `7200` interest, CR money account. The ledger party of the `2400` line is the LOAN, not the lender.
- The principal/interest split is COMPUTED (`accruedInterest` then `splitPayment`), never accepted from the caller. Interest accrues from the last payment date, or the loan start date if none.
- A month is 30 days, a year 365 (`dailyRate`); `ratePeriod` is carried on every loan and is NOT NULL.
- Overpayment and payment against a zero balance are refused, not absorbed. Outstanding is derived from what was disbursed (drawable in stages), not the agreed principal.
- `authorize()` runs first (`manage_chart_of_accounts` to create, `record_ap_payment` at the loan's store to pay/reverse); field rules (`LOAN_*_RULES`) are asserted after the gate. Paying from another store's money account also needs `transfer_funds` there; reversal needs it at every other store the entry touches.
- `reverseLoanEntry` first confirms the entry carries a `2400` line partied to THIS loan (DEF-156), then calls `reverseEntry`; an already-reversed entry returns `created: false`.
- Cashier money accounts warn and office accounts refuse on overdraw via the shared `checkDraw`.
- Amounts are `Money`/`Decimal` strings; the rate is branded numeric(8,4).
- `interest.ts` functions are pure.

## Side Effects
- `createLoan` writes via `loansRepo.insertLoan`.
- `disburseLoan` and `recordLoanPayment` post journal entries through `postEntry` (with `withInterStoreLegs` for cross-store legs); `disburseLoan` uses idempotency key `loan:<id>:disbursement:<date>:<amount>`.
- `reverseLoanEntry` posts a reversal entry through `reverseEntry`.
- Each public function accepts `tx: Tx | null`; with `null` it opens its own `transaction()`, otherwise it joins the caller's.
- `interest.ts`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
