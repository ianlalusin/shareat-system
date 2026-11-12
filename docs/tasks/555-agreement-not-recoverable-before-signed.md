# T-555 - a deduction agreement is not recoverable before its signing date (audit M-002)

Owner: AUDIT. Number given by BOSS 10 Nov 2026 (block T-552..T-557). No migration. Source finding:
`shareat-audits/OPEN/2026-11-09-payroll-branches.md` (M-002). Base: origin/main d50a4e0.

## Defect (re-located on main d50a4e0)

- Writer `packages/domain/src/payroll/deduction-agreements.ts` `recordDeductionAgreement` (lines 146-153): validates real dates and
  notice <= signing, but accepts a `signedOn` in the future and inserts an active agreement. The DB check only compares notice
  to signing.
- Readers: `packages/db/src/repo/deduction-agreements.ts:110` `listActiveForPerson` selects every ACTIVE agreement with no date
  test. It feeds `agreedRecoverable` (deduction-agreements.ts:47, called from payroll/index.ts:537 with `periodEnd`,
  separation.ts:78 with `separationDate`, thirteenth-month.ts:112 with `${year}-12-31`) and `applyDeductionRecovery`
  (deduction-agreements.ts:72, called at payroll/index.ts:806, separation.ts:221, thirteenth-month.ts:253).
  A future-dated (typo) record therefore authorises recovery from the next payout, before the employee signed it.

## Fix (two parts)

1. **Readers:** an agreement counts only when `signed_on <= the date of the payout/recovery` (`on`). Add an optional
   `signedOnOrBefore` parameter to `listActiveForPerson` (SQL `a.signed_on <= ...`, also in the locking select so the lock set
   matches), pass `on` from `agreedRecoverable`, and add an `on` parameter to `applyDeductionRecovery` that all three callers
   pass (payroll: the run's period end; separation: separationDate; 13th month: `${year}-12-31`). The preview
   (`agreedRecoverable`) and the spend (`applyDeductionRecovery`) MUST use the same date so they never disagree (the apply step
   refuses when the agreements "no longer cover" the figure, so a mismatch would be a new bug). Keep T-521's `runTaken` logic
   exactly as it is.
2. **Writer:** refuse a `signedOn` later than today on the business clock (find the repo's business-date helper in packages/core;
   do not use the server's local time zone) with words like "The signing date cannot be in the future.". Boundary: today is
   allowed. This is the audit's "normally refuse" policy; PR text must flag it so Ian can overrule.

Files: `packages/domain/src/payroll/deduction-agreements.ts`, `packages/db/src/repo/deduction-agreements.ts`, the three callers'
`applyDeductionRecovery` call lines (`payroll/index.ts`, `separation.ts`, `thirteenth-month.ts`); test
`packages/domain/tests/integration/t555-agreement-signed-on.test.ts` (new, real PostgreSQL; reuse the fixture of
`t521-deduction-limit-per-run.test.ts` and the T-519 agreement tests).

## Tests (write FIRST, red on d50a4e0)

(a) an agreement whose `signed_on` is after the pay run's period end: `agreedRecoverable` returns zero for it and the payslip
recovers nothing (red on main: recovers); (b) same on separation and 13th month; (c) signed on the period end day: recoverable
(boundary); (d) writer refuses tomorrow, accepts today; (e) apply with a date before signing never spends a future agreement.
Existing T-519/T-521 tests must stay green.

## Out of scope

Legal effect of signature dates (a software contract only); any change to caps or per-run limits.
