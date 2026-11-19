# T-608: Split interest out of loan repayments taken from platform payouts (DEF-931)

**Owner:** builder (Sonnet). **Spec:** BOSS (Opus), 19 Nov 2026.
**Ian's rulings, 19 Nov 2026:**
- **Option 2:** every peso a platform deducts for a loan is split the same way, part principal and part interest.
- **Keep the store-to-store entries.** A loan stays owned by one store. Any store's payout may repay it, and the 1250 / 2150 pair records who owes whom. No "company-wide loan" change.

## The problem (DEF-931)

When a settlement repays a loan, `recordChannelSettlement` (`packages/domain/src/channel-settlements/index.ts`, the loan-leg loop) debits 2400 with the **whole** deduction.
- Nothing goes to interest expense 7200.
- On live erp2 the Grab Quick Cash loan shows ₱15,946.92 of principal repaid after 9 days and ₱0.00 of interest.
- In truth, ₱946.92 of that was interest.

## The rule

The rule applies only to a loan that has **both** `repayment_amount` and `term_periods` set (a scheduled loan):

- Total to repay `T` = `repayment_amount × term_periods`.
- Total interest `I` = `T − principal_amount`. If `I ≤ 0`, everything is principal.
- Per leg, compute interest **cumulatively**, so rounding never drifts and the last payment lands exactly:
  - `paidBefore` = principal paid + interest paid on this loan, from the ledger, before this leg.
  - `interestBefore` = interest already booked on the loan.
  - `interest = clamp(roundHalfUp((paidBefore + leg) × I / T) − interestBefore, 0, leg)`.
  - `principal = leg − interest`.
  - All arithmetic is in bigint centavos (see `loans/interest.ts`).
- **The cumulative form corrects itself.** The 9 days already booked with ₱0 interest have their missing ₱946.92 picked up by the next leg posted after deploy. No migration and no correcting journal entry are needed.
- **Grab Quick Cash check:**
  - `T = 1,771.88 × 90 = 159,469.20`
  - `I = 9,469.20`
  - A full payment splits ₱1,666.67 principal + ₱105.21 interest (±1 centavo from rounding).
- Loans without a schedule keep today's behaviour (all principal).
  - Manual `recordLoanPayment` is **not touched**. It already splits interest first by rate.

## Posting changes (one place: the loan-leg loop)

**Same-store leg:** Dr 2400 the principal part, then Dr 7200 the interest part, at the loan's store. Party on the 7200 line: see Step 1.

**Cross-store leg:** the paying store's 1250 and the owner's 2150 stay at the **full** leg amount. The owner store's 2400 debit splits into Dr 2400 principal + Dr 7200 interest, both at the owner store.

**A part with ₱0 gets no line.**

**Void:** the existing reversal mirrors every line. It needs no change, but add a test.

## Step 1: let the ledger find settlement interest

Today `loansRepo.positionOf` (`packages/db/src/repo/loans.ts` ~line 195) counts interest only from `source_type = PAYMENT_SOURCE, source_id = loanId`. Settlement interest would be invisible to it.
- **Preferred:** put `party_type 'loan', party_id <loanId>` on every new 7200 line. Then have `positionOf` (and the list or summary queries at ~lines 360 and 413) also count 7200 lines carrying that party.
- **First check** that the party trigger from migration 0007 (`journal_lines_check_party_requirement`) allows a party on 7200, which has `requires_party = false`.
  - If it **forbids** one, stop and report to BOSS. Do not change the trigger or the account.
- Avoid double counting: the manual-payment 7200 lines have no party. Count them through the existing source rule. Count party-tagged lines through the new rule.

## Step 2: the loan check must know interest is still owed

`settlement-intake/loan-check.ts` treats a loan as open while principal outstanding > 0, and expects the final payment to equal the principal still owed (~lines 111–114, 173, 311).
- With interest split out, the last payment is bigger than the principal left, so the final day would wrongly read "mismatch".
- **Change:** for a scheduled loan, "left to pay" = `T − (principal paid + interest paid)`. Use it everywhere `outstandingBefore` is used.
  - That covers the open-loan filter, the final-payment test and `expected`.
  - It also covers the "earlier pending days" subtraction.
- Unscheduled loans keep using principal outstanding.
- Put the "left to pay" figure on the loan position (e.g. `leftToPay`) so the loans screen can show it too.

## Step 3: show it

Loans screen and loan detail: show "Interest paid", which already exists and now becomes real. Add "Left to pay (principal + interest)" for scheduled loans. Plain words; no new page.

## Tests (integration, on any `_test` DB; synthetic data only)

1. **Same-store split:** a scheduled loan (150,000 / 1,771.88 × 90) and one full leg post 1,666.67 to 2400 and 105.21 to 7200. Position: principal paid 1,666.67, interest paid 105.21.
2. **Cross-store split:** 1250 and 2150 carry the full amount. The owner store gets 2400 + 7200. The ledger still balances per store pair (invariant 6 holds).
3. **Split rows on one day:** 1,350.30 + 421.58 together give the same cumulative interest as one 1,771.88 leg.
4. **Catch-up:** given an existing all-principal leg, the next leg carries the missed interest. Interest never goes above the leg.
5. **Last payment:** after 89 full legs, the 90th makes interest paid exactly `I` and principal paid exactly `principal_amount`. The loan check reads "ok" for a final payment equal to "left to pay", not principal.
6. **Unscheduled loan:** a leg is still 100% principal. Manual `recordLoanPayment` is unchanged (existing tests stay green).
7. **Void:** reverses the 7200 line too; interest paid goes back.

## Out of scope (each with a reason)

- **Capping a leg at the loan's balance:** a known limit, already documented in the channel-settlements README. Separate.
- **Booking the October Grab repayments:** this is Ian's data entry once T-608 is live. The cumulative rule handles the order.
- **Daily accrual or month-end interest entries:** Ian chose the per-payment split. It already puts interest in the month and year each payment happens.
- **A company-wide loan owner:** Ian ruled to keep it as it is, 19 Nov.
- **Banay-Banay as a store, and the all-stores Grab upload:** separate defects.

## Done when

- Tests 1–7 pass, plus the existing t511 loan-leg and approve-day suites.
- Per-package typecheck is clean.
- `packages/domain/src/channel-settlements/README.md` and `loans/README.md` describe the split.
- On erp2, after deploy, the next Grab day posted shows interest on the Quick Cash loan. The catch-up should be about ₱946.92 + ₱105.21 if it's the 10th day.
