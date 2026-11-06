# T-519: payroll recovers a staff charge only under a signed deduction agreement (DEF-813)

**Status:** SPEC 5 Nov 2026 (BOSS). **Migration:** 0234 (reserved on BOARD). **Lanes:** Sonnet tester, then builder, then auditor (money + schema: auditor stays Sonnet, mutation-checked).

## Why
- Ian 4 Nov (franchise review Q6): a staff charge is repaid only under a written agreement the employee signs, after a notice-and-explain step. This applies to managers too.
- Ian 5 Nov, choosing between (a) everything needs an agreement and (b) only charges and shortages need it: "b".
- Labor Code Art. 113 and the Omnibus Rules (Book III, Rule VIII, Sec. 14) allow a deduction for loss or damage only when all of these hold: the employee is clearly responsible, they were given a chance to show cause, the amount is fair, and the deduction is at most 20% of the employee's wages in a week.
- Today `outstandingAdvance` (packages/domain/src/payroll/index.ts:573) recovers the person's WHOLE 1230 balance every run. The same balance is recovered in the 13th-month and separation runs.

## Facts (discovery 5 Nov, origin/main)
- Every employee-party debit to 1230 is a charge, not a requested cash advance. Requested advances post to 1120 (`cash_request_release`) and are untouched here, which is choice (b).
- The six charge sources and their `source_type` values:
  - cash-request shortage: `cash_request_shortage` (cash-requests/index.ts:477)
  - till shortage: `tillcountshortage` (till/index.ts:317)
  - remittance variance: `remittance_variance` (remittance/index.ts:771)
  - commissary transit charge: `trade_discrepancy` (commissary/discrepancy.ts:221)
  - order wastage charge: `order_wastage` (wastage/orders.ts:214), blocked today by `isPhase5StaffAdvancesAvailable()`
  - owner drawing moved onto pay: `owner_pay_recovery` (owners/index.ts:502)
- None of them records an acknowledgement. No agreement table exists.

## Rulings
- **R1. The charge stays a receivable; recovery needs an agreement.** Posting a charge to 1230 is unchanged, so the books still show what the person owes. Payroll, 13th month and separation recover ONLY amounts covered by an ACTIVE agreement. Anything else stays on 1230 and is listed as "Waiting for the employee's signed agreement".
- **R2. The agreement record.** New table `staff_deduction_agreements` (migration 0234), store-scoped. Columns:
  - `person_id`, `store_id`
  - `source_type` and `source_entry_id`: the charge's journal entry, as a composite same-org FK
  - `amount` (numeric(14,2), above 0, at most the charge)
  - `per_payroll_limit` (numeric(14,2), above 0)
  - `notice_given_at` (date)
  - `employee_explanation` (text, required; may be "none given")
  - `signed_on` (date)
  - `evidence_file_id`: the scan of the signed paper, using a new stored-file purpose `staff_deduction_agreement`
  - `recorded_by`, `recorded_at`
  - `status`: `active`, `completed` or `cancelled`
  - Append-only apart from the status and its stamps (column-level UPDATE grant). One active agreement per charge entry. Row-level security on.
- **R3. The legal cap.** For each payroll run, the recovery from charges is at most 20% of that run's gross wages, pro-rated as 20% of the gross for the run's period. It is also at most the sum of each active agreement's `per_payroll_limit`, and at most the agreed amounts still unpaid. Requested advances (1120) are outside this cap. 13th month and separation recover only the agreed unpaid amount (the 20% weekly cap is for wages; a final-pay recovery still needs the agreement).
- **R4. Who.** Recording an agreement needs the existing `manage_payroll`-level capability at the store. Read capabilities.ts: use the capability that already governs payroll adjustments, and add no new one unless none fits. Then name it here. The recorder can never be the charged person. The charge's notice must be dated on or before `signed_on`.
- **R5. Owner drawings (`owner_pay_recovery`).** Treated as a charge, so it needs an agreement. When the actor and the person are the same person, the owner's own action IS their agreement: the domain writes the agreement row automatically, with an explanation of "own request".
- **R6. Completion.** When an agreement's recovered total reaches its amount, its status becomes `completed` in the same transaction as the payroll post. A voided payroll run reopens it (the status goes back to active and the remaining amount returns).
- **R7. Screens (minimal).** Under a person's payroll page: the charges waiting for an agreement, a "Record signed agreement" form (amount, limit per payroll, notice date, explanation, signed date, scan upload), and the active agreements with what's left to pay. The payslip shows "Charge repayment (agreement of <date>)".

## Slices
- **S1 (this spec):** migration 0234 plus schema, repo, classification and RLS registry; the domain functions `recordDeductionAgreement`, `cancelDeductionAgreement` and `agreedRecoverable(person, runGross)`; payroll, 13th month and separation switched from `outstandingAdvance` to `agreedRecoverable`; completion and reopen on void. Tests come first:
  - a charge with no agreement recovers 0 and stays on 1230
  - an agreed charge recovers at most min(20% of gross, limit, unpaid)
  - two agreements
  - completion
  - a void reopens it
  - the 13th month and separation gates
  - staff, or the charged person, recording an agreement is refused
  - a cross-store or cross-org agreement is refused
  - owner self-agreement
  - Then the full suite on a fresh gate DB (migration rule).
- **S2:** the screens (R7), using the impeccable skill, plus a rendered check.

## Out
Requested cash advances (1120, choice b). Changing how charges are created. Notice by SMS or email. E-signature (the scan of a paper signature is the evidence in release 1). Charged staff member's own read-only view of agreements: deferred, the payslip line is their record in release 1 (BOSS 6 Nov).

## Open for Ian (not blocking S1)
None. The 20% cap is set by the regulation, not chosen.
