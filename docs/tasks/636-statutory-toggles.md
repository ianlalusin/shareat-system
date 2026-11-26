# T-636: tick each government contribution on or off, per staff member

**Owner:** builder (Sonnet). Auditor: Sonnet (payroll money). **Spec:** BOSS (Opus), 25 Nov 2026. **MIGRATION 0288** (reserved).

**Ian, 25 Nov 2026:** "individual government contributions can be ticked off individually coz sometimes we have staff who is not regular like on call and we dont pay sss philhealth for them" → "yes build it".
**Caution, recorded:** PH rules generally make SSS / PhilHealth / Pag-IBIG compulsory for employees. Ian confirms with the accountant which on-call staff may be excluded. The app records the choice and who made it; it does not judge legality.

## Today (facts, origin/main)

- Government ID numbers live on `persons` (packages/db/schema/persons.ts:64: `sss_no`, plus the PhilHealth / Pag-IBIG / TIN columns). They are set by `setGovernmentIds` (packages/domain/src/payroll/rates.ts) from the staff page `apps/erp/src/app/staff/[employmentId]/page.tsx`.
- The pay run (packages/domain/src/payroll/index.ts ~:521) skips an agency for a person when that person has NO number for it (`skipped` → `computeStatutory`), and lists them in `missingGovernmentIds` as a warning.
- There is no explicit "do not deduct" choice.

## Rule

1. `persons` gains three booleans: `deduct_sss`, `deduct_philhealth`, `deduct_pagibig`. They are NOT NULL, default true, so every existing person keeps today's behaviour. They are person-level, because contributions are per person per month across employments.
2. Edited on the staff page, beside the government ID numbers: three tick boxes, "Deduct SSS", "Deduct PhilHealth", "Deduct Pag-IBIG".
   - Same capability as `setGovernmentIds` today; authorize first.
   - Audit the before/after per changed flag (a new audit action, e.g. `person.statutory_deduction_set`; register it in the audit catalogue and the 0197-style action list as the t402 test requires).
   - Plain hint: "Untick only for staff who are not covered, such as on-call staff. Check with your accountant."
3. Pay run: an agency is skipped when `deduct_<agency>` is false OR the number is missing.
   - Only the MISSING-number case goes into `missingGovernmentIds`. A deliberate untick is not a warning.
   - The preview shows a quiet "Not deducted (unticked): SSS" note per person, so the payer sees it.
   - Skip both the employee AND the employer share (EE, ER, EC) for that agency, exactly as the missing-number skip does today.
   - Month-to-date priors and the statutory-payments export must stay consistent: an unticked agency contributes nothing and appears nowhere.
4. A posted payslip is never changed by a later tick or untick (it already stores its amounts).

## Not in this task

- Withholding tax (TIN) toggles.
- Per-employment flags.
- Employment-type rules.
- Back-pay or corrections of past payslips.

## Tests (each with a mutant that goes red)

1. Untick SSS only: SSS EE/ER/EC are 0, while PhilHealth and Pag-IBIG are computed. Net pay identity holds.
2. Unticked with a number present: no deduction, and NOT listed in missingGovernmentIds. A missing number with the tick on is still listed.
3. Defaults: an existing person keeps deducting (backfill default true).
4. Authorize first; a refused role is tested; the audit row shows before/after.
5. A posted payslip is unchanged after untick (stored amounts).
6. The statutory-payments month export leaves an unticked person out for that agency.

Hand-authored migration (ADR-012 §5). persons is an existing table, so check whether its RLS/grants need the new columns added to a column-level UPDATE grant. Full CI suite. census:write. Typecheck per shareat-builder.md.


## As built (builder, 25 Nov 2026)

- **Migration 0288** (`packages/db/migrations/0288_t636_statutory_deduction_flags.sql`): `persons.deduct_sss`, `deduct_philhealth`, `deduct_pagibig`
  (boolean NOT NULL DEFAULT true: every existing person keeps deducting; catalog-only ADD COLUMN). **Grants:** persons has no column-level UPDATE grant
  (shareat_app's UPDATE comes from 0011's default privileges), so nothing is added; RLS unchanged. Journal idx 288 (renumbered from 0280 to 0283 to 0288 on 26 Nov:
  main holds up to 0286, T-634 takes 0287), `when` = 0287's (1810870307084) + 1 day = 1810956707084; the journal test allows gaps.
- **Addition beyond the spec, needed for rule 3 / test 6:** `payslips.unticked_agencies text[] NOT NULL DEFAULT '{}'`, CHECK `unticked_agencies <@
  skipped_agencies`. `skipped_agencies` (0206) records only THAT an agency was skipped, not why; the month detail must keep a missing-number row at 0.00
  (today's behaviour) but leave an unticked person out. Existing slips get '{}'.
- **Domain:** `agenciesToSkip(facts)` (pure, `payroll/statutory.ts`): skipped = unticked OR missing; only missing feeds `missingGovernmentIds`; an agency
  both unticked and missing counts as unticked. The pay run uses it (EE, ER and EC all skipped, priors untouched, exactly as the missing-number path);
  each draft carries `untickedAgencies`, which the post stores. `setStatutoryDeductions` (`payroll/rates.ts`): `enrol_staff` at the store (same as
  `setGovernmentIds`), authorize first, locks the person, one audit row `person.statutory_deduction_set` with before/after of each CHANGED tick; no change
  writes nothing. Audit catalogue +1 (ceiling 308 -> 309).
- **Export:** `statutoryPaymentsRepo.monthDetail` leaves out a payslip whose `unticked_agencies` holds that agency (the CSV export reads the same rows).
- **ERP:** the staff page's Government numbers Edit gains "Deduct SSS / PhilHealth / Pag-IBIG" ticks with the hint "Untick only for staff who are not
  covered, such as on-call staff. Check with your accountant.", and a summary line "Not deducted (unticked): ...". The same save action calls
  `setStatutoryDeductions` in the same transaction, only when the form carries the hidden `statutoryTicks` marker (an unticked checkbox is absent from the
  form). Payroll preview: a missing number keeps the warning; an unticked agency shows a quiet "Not deducted (unticked): SSS". A POSTED slip's line now says
  "not deducted: SSS" (it used to say "no SSS no.", which would be false for an untick).
