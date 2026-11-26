-- 0288 - T-636: tick each government contribution on or off, per staff member. docs/tasks/636-statutory-toggles.md; hand-authored per ADR-012 s5.
-- Journal idx 288, `when` = 0287's (T-634, 1810870307084) + 86400000 = 1810956707084: renumbered 0280 -> 0283 -> 0288 on 26 Nov 2026 because main holds up to 0286
-- and T-634 takes 0287. The journal test allows gaps, so this applies in order whichever of them lands first.
--
-- WHY. Ian, 25 Nov 2026: "individual government contributions can be ticked off individually coz sometimes we have staff who is not regular like on call and we
-- dont pay sss philhealth for them". Recorded caution: PH rules generally make SSS / PhilHealth / Pag-IBIG compulsory for employees; Ian confirms with the
-- accountant which on-call staff may be excluded. The app records the choice and who made it (audit `person.statutory_deduction_set`); it does not judge legality.
--
-- WHAT IT ADDS. persons.deduct_sss, persons.deduct_philhealth, persons.deduct_pagibig: boolean NOT NULL DEFAULT true. Person-level (contributions are per person
-- per month across employments). DEFAULT true backfills every existing person to today's behaviour; ADD COLUMN with a constant default is a catalog-only change
-- (no table rewrite). A pay run skips an agency when its flag is false OR the number is missing (packages/domain/src/payroll); a posted payslip keeps its amounts.
--
-- payslips.unticked_agencies text[] NOT NULL DEFAULT '{}': which of a posted slip's skipped agencies were UNTICKED (a choice), as opposed to having no number.
-- Needed because skipped_agencies (0206) records only THAT an agency was skipped: the statutory-payments month detail keeps a missing-number row at 0.00 (so
-- the payer sees who has no number) but leaves an unticked person out for that agency. CHECK unticked_agencies <@ skipped_agencies: an unticked agency is always
-- skipped. Existing slips get '{}' (nothing was unticked before this task).
--
-- GRANTS. persons has no column-level UPDATE grant: shareat_app's table-level UPDATE comes from 0011's ALTER DEFAULT PRIVILEGES, so the new columns are writable
-- with nothing added here. RLS is unchanged (the existing persons policies cover every column).
-- LOCK BUDGET. lock_timeout 5s first; four ADD COLUMNs with constant defaults (metadata only) and one CHECK (validates payslips once; every row is '{}').

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "deduct_sss" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "deduct_philhealth" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "deduct_pagibig" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "unticked_agencies" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_unticked_agencies_check" CHECK ("unticked_agencies" <@ "skipped_agencies");
