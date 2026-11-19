# T-613: money follow-ups from the 19 Nov audits (T-534, T-597)

**Owner:** builder (Sonnet), with a Sonnet money auditor. **Spec:** BOSS (Opus), 19-20 Nov 2026. **No migration expected.**
Each item needs a test that fails without the fix (a mutant). Register rows: next free DEF numbers at build time, marked fixed (T-613).

## A. Retired money accounts: the remaining payout writers (from the T-597 audit, finding 1)

Call `assertActiveAccount` (T-597, `packages/domain/src/money-accounts/overdraft.ts`) before posting in:
- `packages/domain/src/expenses/approve.ts` (~235-262), the expense funding account
- `packages/domain/src/trade/returns.ts` (~262-270), the customer cash refund
- `packages/domain/src/service-charge/index.ts` (~63-75), the distribution
- `packages/domain/src/remittance/index.ts` (~144-145), both the from and the to account

**Keep allowing** retired accounts where T-597 deliberately does: AP `voidPayment`, AR and loans collections and disbursements, till counts.

## B. A staff-float account refused in the domain for supplier refunds (finding 2)

`refundSupplierCredit` must refuse a staff-float account itself, not rely on the page filter.

## C. Replay before the retired check (finding 4)

`recordPayment` (AP) and `payLiability` must check for an idempotent replay **before** `assertActiveAccount`, as `recordStatutoryPayment` does. A double-click retry after an account is retired then returns the original answer.

## D. POS refunds (from T-534 S4's known limits; BOSS accepted for go-live, fix after)

1. **The refund cap ignores an S3 tender correction.** Cap each original payment's refundable amount at amount − change − already refunded − **amount corrected away from it**. A correction's **target** method also becomes refundable up to the corrected amount. Test: ₱1,000 cash, ₱300 corrected to GCash, refund at most ₱700 cash plus ₱300 GCash.
2. **A refund larger than that method's takings refuses the Z.** The sales day can't hold a negative cash or wallet figure. Design question: post the excess as a separate refund entry (Dr 4950 / Cr money account) outside the sales day. **Stop and report with a proposal before building**; this needs a posting-pattern lookup.
3. **A Z with only refunds and no sales** says "nothing to close". Allow a Z when there are refunds, conversions or corrections, even with no receipts.
4. **Refunding an earlier day's receipt has no screen** (`/pos/receipts` lists only receipts since the last Z). Add a "Find a receipt" search by receipt number, limited to the store's last 30 days, opening the same Refund dialog.

## E. Payroll separation SIL draw (T-597 audit, out of scope there)

`settleSilAtSeparation` is a second cash draw that `checkDraw` doesn't count. Include it in the separation's draw check.

## Out

- The DEF-159 two-requests release race: a pre-existing rule, not a regression; its own task if Ian wants it.
- The `upsertPosDiscountPreset` audit `source: 'etl'` label (T-611 S3): cosmetic; fix only if trivial while there.
