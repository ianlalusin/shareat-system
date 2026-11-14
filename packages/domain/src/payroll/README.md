# Payroll
## Overview
The pay rate, the pay run and the payslip (T-189 onward), plus statutory contributions (SSS, PhilHealth, Pag-IBIG, withholding), the 13th-month run and separation/final pay. The engines (`compute.ts`, `periods.ts`, `statutory.ts`) are pure; `index.ts`, `thirteenth-month.ts`, `separation.ts` and `rates.ts` own the transactions and ledger postings. Payroll posts through `postEntry`/`reverseEntry` and recovers staff advances from account `1230`.

## Interface
- `index.ts`: `SALARIES_ACCOUNT` (6100), `PAYROLL_ADVANCE_ACCOUNT` (1230), `STATUTORY_PAYABLE_ACCOUNT`, `WITHHOLDING_PAYABLE_ACCOUNT`, `STATUTORY_EXPENSE_ACCOUNT`, `setPayRate`, `previewPayRun`, `outstandingAdvance`, `postPayRun`, `voidPayRun`, types `PayslipDraft`, `PayRunPreview`; re-exports `compute`, `periods`, `statutory`, `rates`, `thirteenth-month`, `separation`.
- `compute.ts`: `HALF_HOUR_THRESHOLD_MINUTES` (25), `FULL_HOUR_THRESHOLD_MINUTES` (50), `steppedHours`, `computePay`, `advanceToRecover`, types `DayInput`, `Multipliers`, `ComputedPay`.
- `periods.ts`: `lastDayOfMonth`, `derivePeriods`, `tilesTheMonth`, `periodForDate`, `payoutDateFor`, `maxPayoutGapDays`, types `PayPeriod`, `PeriodConfig`, `PayoutConfig`.
- `statutory.ts`: `AGENCIES`, `monthlyContribution`, `withholdingTax`, `computeStatutory`, types `Agency`, `ContributionRate`, `WithholdingBracket`, `AgencyPrior`, `MonthlyContribution`, `StatutoryInput`, `StatutoryResult`.
- `rates.ts`: `addStatutoryRate`, `confirmStatutoryRate`, `discardStatutoryRate`, `addWithholdingBracketSet`, `confirmWithholdingBracketSet`, `discardWithholdingBracketSet`, `addMinimumWage`, `confirmMinimumWage`, `discardMinimumWage`, `setGovernmentIds`.
- `thirteenth-month.ts`: `THIRTEENTH_MONTH_ACCOUNT` (6140), `THIRTEENTH_MONTH_EXEMPT_CEILING`, `preview13thMonthRun`, `post13thMonthRun`, `void13thMonthRun`.
- `separation.ts`: `SEPARATION_PAY_ACCOUNT` (6150), `previewSeparation`, `postSeparation`, `voidSeparation`.

## Invariants
- All money uses `@shareat/core/money` (exact bigint centavos, round-half-up); no floats.
- `compute.ts`, `periods.ts`, `statutory.ts` are pure: no database, clock or I/O. No rate, ceiling or bracket is hard-coded in `statutory.ts`; figures come from effective-dated rows.
- Overtime minutes become hours on a 25/50-minute ladder (`steppedHours`); lateness is deliberately not laddered.
- Pay periods never cross a month boundary and must tile the month (`tilesTheMonth`).
- Statutory contributions are monthly: month-to-date true-up; employee shares are cut to fit inside gross before an advance is recovered, so net never goes below zero. Employer share posts in full.
- Rate rows are immutable once confirmed; a correction is a new row with a later `effective_from`. A table cannot start on or before the latest posted `period_end`.
- A person may not post a pay run that pays their own employment (admins are not exempt).
- Void reverses the ledger entry and unfreezes the attendance days (the only place a freeze is lifted).
- `separationPayAmount` is an input to `postSeparation`, never computed; wages to the separation date come from a normal pay run.
- `index.ts` and `thirteenth-month.ts`/`separation.ts` import each other deliberately; `thirteenth-month` is re-exported at the end of `index.ts`.

## Side Effects
- Writes pay rates, pay runs, payslips, 13th-month and separation rows via repos (`payrollRepo`, `statutoryRepo`, `thirteenthMonthRepo`, `separationsRepo`).
- Posts and reverses journal entries via `postEntry`/`reverseEntry`.
- `rates.ts` writes `audit_log` rows in the same transaction.
- Opens its own transaction (`transaction(...)`) when `tx` is `null`; otherwise joins the caller's.
- Authorizes `set_pay_rate`, `run_payroll`, `enrol_staff` and `manage_payroll_rates` first.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
