# T-521 - an agreement's per-payroll limit holds across a person's payslips in one run

Owner: AUDIT. Source: fifty-third pass (`deduction-recovery-allocation-ignores-individual-limit`), leftover after T-519 S1 (#157). No migration, no DEF, no bible row.
Branch `audit/t521-deduction-limit-per-run`. The number was given by BOSS (6 Nov 2026).

## Problem
T-519 S1 made `applyDeductionRecovery` give each agreement at most min(room, `perPayrollLimit`, left) per PAYSLIP.
A person with two employments in one run (a rehire, same store) has two payslips. `agreedRecoverable` caps the person's TOTAL
(20% of whole gross, sum of limits, unpaid, 1230 balance), asked once per person; `payroll/index.ts` subtracts what earlier slips took.
But the split is made per slip with no memory: if slip 1 recovers less than the total (small net), slip 2 gives the same agreement its limit again.
Example: A (1,000 owed, limit 100), B (1,000 owed, limit 900); slip 1 (gross 50) takes about 48, all to A; slip 2 takes 100 more from A, so A has paid about 148 against a signed limit of 100.

## Rule
A payroll run recovers from one agreement at most its `perPayrollLimit` in total, however many payslips the person has in that run.
13th month and separation are unchanged (agreed unpaid amount only, no per-run limit).

## Change (exact files)
- `packages/domain/src/payroll/deduction-agreements.ts`: `applyDeductionRecovery(..., runTaken?: Map<string, Money>)` replaces the boolean `perRunLimit`.
  When `runTaken` is given: take = min(room, perPayrollLimit minus runTaken[agreement], left), and `runTaken` is updated. Omitted = the 13th-month/separation behaviour.
- `packages/domain/src/payroll/index.ts` (posting loop, about line 704 and 804): one `Map` per run, passed to every slip's call.
- Test `packages/domain/tests/integration/t521-deduction-limit-per-run.test.ts` (real PostgreSQL, `_test` DB): two employments, first slip small. Red on old code (A over 100), green after.
No other caller passes the old boolean (separation.ts:221 and thirteenth-month.ts:253 omit it).
The total is still covered: the agreed total minus what earlier slips took equals the remaining per-agreement room, so the "agreements no longer cover" refusal does not fire.
