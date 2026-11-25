-- 0279 - T-635: slicer pay. The slicer records, another staff member confirms, payroll pays per kg. docs/tasks/635-slicer-pay.md; hand-authored per ADR-012 s5.
-- Journal idx 279, `when` = 0277's + 2 * 86400000 (idx 278 is reserved by T-634 on another machine; renumber at merge if that lands first).
--
-- WHY. Ian, 24-25 Nov: "it looks for staff who is slicer and that staff can record his production. someone, currently other staff not necessary manager has to
-- check and confirm it then the app computes how much payment to pay to the slicer". Per kg of paid slices, paid with payroll as salary (like v1).
-- Builds on bible row 326: a slice record carries who sliced, paid/unpaid and the rate; paying stays in payroll.
--
-- WHAT IT ADDS
--   production_records       performed_by_person_id (who sliced; the domain requires it to POST a slice record), confirmed_by_person_id + confirmed_at (another person checked it),
--                            paid_by_pay_run_id (the posted pay run that paid it: the same idea as attendance_days.frozen_by_pay_run_id). Existing rows keep all four null.
--                            CHECKs: the confirmation is a pair; the confirmer is never the slicer; a paid record is confirmed and still posted (so a void or an
--                            edit-clears-confirmation of a paid record is refused by the database as well as by the domain).
--   production_record_lines  is_paid (default true): only OUTPUT lines of a slice record with is_paid count toward the slicer's pay. Existing lines are paid.
--   slicer_pay_rates         what a kg of paid slices pays, effective-dated and APPEND-ONLY like pay_rates (select + insert only; no UPDATE or DELETE grant). item_id null = org default;
--                            an item row in force beats the default. One row per scope per day it changes. KEEP (configuration).
--   payslips                 slicer_pay, slicer_kg, slicer_records (zero defaults, so every existing slip and every fixture that inserts one still holds). The gross identity is
--                            restated with the new leg (as 0205 did for leave): gross = basic + ot + night + holiday + leave + sil + slicer.
--
-- LABOUR IS NEVER BOOKED TWICE. The slicer pay is booked ONCE, by the payslip's own entry (Dr 6100 gross, which now includes it). This migration adds no journal path.
-- `production_records.labour_cost` stays what it was: the capitalisation credit to 6100 at post (docs/POSTING-PATTERNS.md production.conversion.slice), which nets the
-- payroll expense into the output's cost. The pay run reads the record, never writes to it except the freeze, and posts nothing against the production entry.
--
-- S2 (Ian, 25 Nov): staff clock in as SLICER or REGULAR. The choice rides on the punch event; the day remembers it; a slicer day pays 0 from the daily rate.
--   attendance_punches       worked_as (null = the event carried no choice = regular; an old queued punch still ingests)
--   attendance_days          worked_as NOT NULL default 'regular': DERIVED on every recompute from the day's first clock-in punch, overridden by a live `worked_as` adjustment
--                            (never a hand-set column a recompute would overwrite)
--   attendance_adjustments   a new kind `worked_as` (+ its payload column): a manager's audited correction, superseding like every other kind
--   payslips                 slicer_days (the days paid as slicer, shown beside the regular days) and slicer_earlier_records (late-confirmed records from before the period)
--
-- No existing data is read, moved or deleted. Nothing in this file can fail on production data: every new column is nullable or has a constant default, and every new CHECK is
-- true of a row whose new columns are null / zero.
-- LOCK BUDGET. lock_timeout 5s first; ADD COLUMN with a constant default does not rewrite; the new CHECKs validate a small table.
-- GRANTS (ADR-012 s5 4a). production_records, production_record_lines and payslips keep their existing grants (the new columns are covered). slicer_pay_rates: SELECT, INSERT only.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ---- production_records ---------------------------------------------------------------------
ALTER TABLE "production_records" ADD COLUMN "performed_by_person_id" uuid;
--> statement-breakpoint
ALTER TABLE "production_records" ADD COLUMN "confirmed_by_person_id" uuid;
--> statement-breakpoint
ALTER TABLE "production_records" ADD COLUMN "confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "production_records" ADD COLUMN "paid_by_pay_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_performed_by_person_id_persons_id_fk"
	FOREIGN KEY ("performed_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_confirmed_by_person_id_persons_id_fk"
	FOREIGN KEY ("confirmed_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_paid_by_pay_run_id_pay_runs_id_fk"
	FOREIGN KEY ("paid_by_pay_run_id") REFERENCES "pay_runs"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_performed_by_same_org_fk"
	FOREIGN KEY ("org_id", "performed_by_person_id") REFERENCES "persons"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_confirmed_by_same_org_fk"
	FOREIGN KEY ("org_id", "confirmed_by_person_id") REFERENCES "persons"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_paid_by_pay_run_same_org_fk"
	FOREIGN KEY ("org_id", "paid_by_pay_run_id") REFERENCES "pay_runs"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_confirmed_pair_check"
	CHECK (("confirmed_by_person_id" IS NULL) = ("confirmed_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_confirmer_not_slicer_check"
	CHECK ("confirmed_by_person_id" IS NULL OR "performed_by_person_id" IS NULL OR "confirmed_by_person_id" <> "performed_by_person_id");
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_paid_shape_check"
	CHECK ("paid_by_pay_run_id" IS NULL OR ("confirmed_at" IS NOT NULL AND "status" = 'posted'));
--> statement-breakpoint
CREATE INDEX "production_records_paid_run_idx" ON "production_records" ("paid_by_pay_run_id");
--> statement-breakpoint

-- ---- production_record_lines -----------------------------------------------------------------
ALTER TABLE "production_record_lines" ADD COLUMN "is_paid" boolean DEFAULT true NOT NULL;
--> statement-breakpoint

-- ---- payslips --------------------------------------------------------------------------------
-- A slicer paid ONLY per kg has no daily pay rate to price the slip under, so pay_rate_id may be null (BOSS ruling, 25 Nov). Every existing slip keeps its rate; the
-- same-org composite FK is MATCH SIMPLE, so a null passes it.
ALTER TABLE "payslips" ALTER COLUMN "pay_rate_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "slicer_pay" numeric(14,2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "slicer_kg" numeric(14,3) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "slicer_records" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "slicer_days" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "slicer_earlier_records" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_slicer_nonnegative_check" CHECK ("slicer_pay" >= 0 AND "slicer_kg" >= 0 AND "slicer_records" >= 0 AND "slicer_days" >= 0 AND "slicer_earlier_records" >= 0 AND "slicer_earlier_records" <= "slicer_records");
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_slicer_pay_finite_check" CHECK ("slicer_pay" > '-Infinity'::numeric AND "slicer_pay" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_slicer_kg_finite_check" CHECK ("slicer_kg" > '-Infinity'::numeric AND "slicer_kg" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" DROP CONSTRAINT "payslips_gross_identity_check";
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_gross_identity_check"
	CHECK ("gross_pay" = "basic_pay" + "ot_pay" + "night_diff_pay" + "holiday_pay" + "leave_pay" + "sil_conversion_pay" + "slicer_pay");
--> statement-breakpoint

-- ---- S2: worked as slicer or regular -----------------------------------------------------------
ALTER TABLE "attendance_punches" ADD COLUMN "worked_as" text;
--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_worked_as_check" CHECK ("worked_as" IS NULL OR "worked_as" IN ('regular','slicer'));
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD COLUMN "worked_as" text DEFAULT 'regular' NOT NULL;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_worked_as_check" CHECK ("worked_as" IN ('regular','slicer'));
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD COLUMN "worked_as" text;
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" DROP CONSTRAINT "attendance_adjustments_kind_check";
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_kind_check"
	CHECK ("kind" in ('start_anchor', 'early_out_approved', 'half_day_override', 'verify', 'void', 'overtime_approved', 'worked_as'));
--> statement-breakpoint
-- The payload whitelist (0110), restated with the new kind and the new column: `worked_as` is carried by its own kind and by no other.
ALTER TABLE "attendance_adjustments" DROP CONSTRAINT "attendance_adjustments_payload_shape_check";
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_payload_shape_check" CHECK (
  ("kind" = 'start_anchor' AND "chosen_anchor_minute" IS NOT NULL
     AND "effective_out_minute" IS NULL AND "is_half_day" IS NULL AND "approved_ot_minutes" IS NULL AND "worked_as" IS NULL)
  OR ("kind" = 'early_out_approved' AND "effective_out_minute" IS NOT NULL
     AND "chosen_anchor_minute" IS NULL AND "is_half_day" IS NULL AND "approved_ot_minutes" IS NULL AND "worked_as" IS NULL)
  OR ("kind" = 'half_day_override' AND "is_half_day" IN ('true','false')
     AND "chosen_anchor_minute" IS NULL AND "effective_out_minute" IS NULL AND "approved_ot_minutes" IS NULL AND "worked_as" IS NULL)
  OR ("kind" = 'overtime_approved' AND "approved_ot_minutes" IS NOT NULL AND "approved_ot_minutes" >= 0
     AND "chosen_anchor_minute" IS NULL AND "effective_out_minute" IS NULL AND "is_half_day" IS NULL AND "worked_as" IS NULL)
  OR ("kind" = 'worked_as' AND "worked_as" IN ('regular','slicer')
     AND "chosen_anchor_minute" IS NULL AND "effective_out_minute" IS NULL AND "is_half_day" IS NULL AND "approved_ot_minutes" IS NULL)
  OR ("kind" IN ('verify','void') AND "chosen_anchor_minute" IS NULL
     AND "effective_out_minute" IS NULL AND "is_half_day" IS NULL AND "approved_ot_minutes" IS NULL AND "worked_as" IS NULL)
);
--> statement-breakpoint

-- ---- slicer_pay_rates ------------------------------------------------------------------------
CREATE TABLE "slicer_pay_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid,
	"rate_per_kg" numeric(14,2) NOT NULL,
	"effective_from" date NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slicer_pay_rates_rate_positive_check" CHECK ("rate_per_kg" > 0),
	CONSTRAINT "slicer_pay_rates_rate_per_kg_finite_check" CHECK ("rate_per_kg" > '-Infinity'::numeric AND "rate_per_kg" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "slicer_pay_rates" ADD CONSTRAINT "slicer_pay_rates_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "slicer_pay_rates" ADD CONSTRAINT "slicer_pay_rates_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "slicer_pay_rates" ADD CONSTRAINT "slicer_pay_rates_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "slicer_pay_rates" ADD CONSTRAINT "slicer_pay_rates_item_id_same_org_fk"
	FOREIGN KEY ("org_id", "item_id") REFERENCES "items"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "slicer_pay_rates" ADD CONSTRAINT "slicer_pay_rates_created_by_same_org_fk"
	FOREIGN KEY ("org_id", "created_by") REFERENCES "persons"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
-- One rate per scope per day it changes (a second row for the same day is two answers). The org default (item_id null) is one scope.
CREATE UNIQUE INDEX "slicer_pay_rates_org_item_from_unique"
	ON "slicer_pay_rates" ("org_id", (coalesce("item_id", '00000000-0000-0000-0000-000000000000'::uuid)), "effective_from");
--> statement-breakpoint
CREATE INDEX "slicer_pay_rates_org_idx" ON "slicer_pay_rates" ("org_id", "effective_from");
--> statement-breakpoint

-- RLS and grants: append-only, so SELECT and INSERT only (ADR-012 s5 4a; the default privileges give a new table exactly that, 0169).
ALTER TABLE "slicer_pay_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "slicer_pay_rates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "slicer_pay_rates_org_isolation" ON "slicer_pay_rates" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT ON "slicer_pay_rates" TO "shareat_app";
