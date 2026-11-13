# T-573 — Loan payment: lock the loan, compute interest exactly (DEF-840, DEF-841)

Status: SPEC (BOSS, 2026-11-13). Money code: Sonnet builder + Sonnet auditor. No migration.

## Problem (verified on main 4c250d2)
- **DEF-841** `packages/domain/src/loans/interest.ts:68-69`: `accruedInterest` computes
  `Number(base) * dailyRate(...) * days` in floating point, then `toFixed(2)`. `dailyRate` (:26) is a float.
  Large principals and long periods can land a centavo off, and `toFixed` rounds half-to-even-ish on binary floats.
- **DEF-840** `packages/domain/src/loans/index.ts:233-241`: `recordLoanPayment` reads `positionOf` and
  `lastPaymentDate` with no lock on the loan. Two concurrent payments both see the same balance and the same
  "since" date: interest is booked twice and the overpayment guard (:256) passes for both.

## Rules
1. **Exact interest.** Compute in scaled integers on the money brand — no `Number()` on money, no float rate.
   `interest = round_half_up( base_centavos × rate_percent × days / (100 × DAYS_IN[period]) )` with the rate
   taken from the stored decimal string (`loan.interestRate`), never `Number(loan.interestRate)`.
   Use a bigint numerator/denominator and one rounding step. Rounding: half-up, to the centavo (state it in the JSDoc).
   `dailyRate` keeps its signature only if another caller needs it; otherwise remove it. Grep callers first.
2. **Lock the loan first.** In `recordLoanPayment`, before `positionOf`, take a row lock on the loan
   (`SELECT ... FOR UPDATE` via a new `loansRepo.lockForPayment(tx, orgId, loanId)`, same shape as
   `cash-requests.ts:226-241`). Keep the existing auth order (DEF-556 note at :228): authorize, then lock, then read.
   Apply the same lock in any other writer that changes a loan's position (disbursement :177, write-off/close if any).
3. Nothing else changes: split, overpayment refusal, idempotency key (`paymentId`) stay as they are.

## Tests (must fail on main first)
- Unit `loans/interest`: table of cases including a large principal (₱5,000,000 at 36%/yr, 365 days), a tiny
  balance, a half-centavo tie (rounds up), and every method/period. Compare against hand-computed exact values.
  A mutant reverting to the float formula must turn at least one case red.
- Integration: two `recordLoanPayment` calls on one loan in parallel transactions (two connections). Exactly one
  books the accrued interest; the second sees the first's payment as `since` and the reduced balance. A payment
  that would overpay after the first commits is refused.
- No golden-master change for existing loans unless a centavo moves; if one moves, list it in the PR.

## Out of scope
- Changing interest methods or day-count conventions (v1 parity stays).
- DEF-859 (payroll factor floats) — negligible, downgraded; separate.
