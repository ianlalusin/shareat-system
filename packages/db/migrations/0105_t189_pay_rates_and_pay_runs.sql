-- T-189 — pay rates, pay runs, payslips. Phase 5 slice 1.
-- docs/tasks/189-pay-rates-and-the-pay-run.md
--
-- Shaped by a read-only probe of the live v1 data, not by the v1 code: payroll there has produced
-- ZERO payslips across 7 stores, and not one of 126 staff carries an SSS, PhilHealth, Pag-IBIG or
-- TIN number. So no statutory tables here — they follow the data (phase plan §5).
--
-- Hand-written, per DEF-073. Never edited after apply.

CREATE TABLE "pay_rates" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  -- A rate belongs to a JOB, not a person: a rehire is a new employment with a new rate.
  "employment_id" uuid NOT NULL REFERENCES "employments"("id") ON DELETE restrict,
  "basis" text NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "effective_from" date NOT NULL,
  "note" text,
  "created_by" uuid NOT NULL REFERENCES "persons"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pay_rates_amount_positive_check" CHECK ("amount" > 0),
  CONSTRAINT "pay_rates_basis_check" CHECK ("basis" in ('daily', 'hourly'))
);

-- There is deliberately NO effective_to. The rate in force on a date is the latest row whose
-- effective_from <= that date. A stored end date is a second fact that can disagree with the
-- next row's start; v1 keeps one and has to close it on every write.
CREATE UNIQUE INDEX "pay_rates_employment_from_unique"
  ON "pay_rates" ("employment_id", "effective_from");
CREATE INDEX "pay_rates_org_idx" ON "pay_rates" ("org_id");

CREATE TABLE "pay_runs" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "store_id" uuid NOT NULL REFERENCES "stores"("id") ON DELETE restrict,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "money_account_id" uuid NOT NULL REFERENCES "money_accounts"("id") ON DELETE restrict,
  "posted_at" timestamp with time zone,
  "posted_by" uuid REFERENCES "persons"("id") ON DELETE restrict,
  "voided_at" timestamp with time zone,
  "voided_by" uuid REFERENCES "persons"("id") ON DELETE restrict,
  "void_reason" text,
  "notes" text,
  "created_by" uuid NOT NULL REFERENCES "persons"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pay_runs_period_order_check" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "pay_runs_status_check" CHECK ("status" in ('draft', 'posted', 'voided')),
  -- posted_at / posted_by are a PAIR, and they SURVIVE a void: a voided run WAS posted, and
  -- erasing when and by whom would erase the only record that it ever paid anybody.
  CONSTRAINT "pay_runs_posted_pair_check"
    CHECK (("posted_at" is null) = ("posted_by" is null)),
  CONSTRAINT "pay_runs_posted_shape_check"
    CHECK (("status" = 'draft') = ("posted_at" is null)),
  CONSTRAINT "pay_runs_void_shape_check"
    CHECK (("status" = 'voided') = ("voided_at" is not null and "void_reason" is not null))
);

CREATE INDEX "pay_runs_org_status_idx" ON "pay_runs" ("org_id", "status");
CREATE INDEX "pay_runs_store_period_idx" ON "pay_runs" ("store_id", "period_start", "period_end");

-- ⭐ THE OVERLAP GUARD. Bible §16.6: "a paid payroll period is frozen, blocked by period OVERLAP
-- not exact bounds — the stricter and correct test." A unique index on (store, start, end) would
-- accept 1–15 August beside 10–20 August and pay the overlap twice.
-- `btree_gist` is already installed; the guard applies only to POSTED runs, so drafts may overlap
-- freely while somebody is still deciding the period.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_no_overlapping_posted_period"
  EXCLUDE USING gist (
    "store_id" WITH =,
    daterange("period_start", "period_end", '[]') WITH &&
  ) WHERE ("status" = 'posted');

CREATE TABLE "payslips" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "pay_runs"("id") ON DELETE restrict,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "employment_id" uuid NOT NULL REFERENCES "employments"("id") ON DELETE restrict,
  -- Stored as well as the employment: an employment can end, and a payslip must stay readable.
  "person_id" uuid NOT NULL REFERENCES "persons"("id") ON DELETE restrict,
  -- The rate this was computed under, so re-reading a March payslip in June gives March's answer.
  "pay_rate_id" uuid NOT NULL REFERENCES "pay_rates"("id") ON DELETE restrict,
  "days_worked" numeric(6, 2) NOT NULL,
  "minutes_worked" integer DEFAULT 0 NOT NULL,
  "ot_minutes" integer DEFAULT 0 NOT NULL,
  "night_diff_minutes" integer DEFAULT 0 NOT NULL,
  "holiday_minutes" integer DEFAULT 0 NOT NULL,
  "basic_pay" numeric(14, 2) NOT NULL,
  "ot_pay" numeric(14, 2) DEFAULT '0' NOT NULL,
  "night_diff_pay" numeric(14, 2) DEFAULT '0' NOT NULL,
  "holiday_pay" numeric(14, 2) DEFAULT '0' NOT NULL,
  "gross_pay" numeric(14, 2) NOT NULL,
  "advance_recovered" numeric(14, 2) DEFAULT '0' NOT NULL,
  "net_pay" numeric(14, 2) NOT NULL,
  "journal_entry_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payslips_days_nonnegative_check" CHECK ("days_worked" >= 0),
  CONSTRAINT "payslips_gross_identity_check"
    CHECK ("gross_pay" = "basic_pay" + "ot_pay" + "night_diff_pay" + "holiday_pay"),
  -- ⚠️ This identity GAINS `- statutory - withholding` when T-190 lands. v1's went from four legs
  -- to five to six, and each time everything asserting the old identity broke. Restate it here,
  -- once, in the migration that adds the term.
  CONSTRAINT "payslips_net_identity_check" CHECK ("net_pay" = "gross_pay" - "advance_recovered"),
  CONSTRAINT "payslips_net_nonnegative_check" CHECK ("net_pay" >= 0),
  CONSTRAINT "payslips_advance_within_gross_check" CHECK ("advance_recovered" <= "gross_pay")
);

CREATE UNIQUE INDEX "payslips_run_employment_unique" ON "payslips" ("run_id", "employment_id");
CREATE INDEX "payslips_org_person_idx" ON "payslips" ("org_id", "person_id");
CREATE INDEX "payslips_run_idx" ON "payslips" ("run_id");

-- ⭐ The seam T-157 left open. Its own comment: "the column lands now; Phase 5 sets it, which is
-- why the FK is deliberately absent until the pay-run table exists." It exists now.
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_frozen_by_pay_run_fk"
  FOREIGN KEY ("frozen_by_pay_run_id") REFERENCES "pay_runs"("id") ON DELETE restrict;

-- ---------------------------------------------------------------------------------------------
-- RLS. All three are org_column; payslips name what a person earns.
ALTER TABLE "pay_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pay_rates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pay_rates_org_isolation" ON "pay_rates" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());

ALTER TABLE "pay_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pay_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pay_runs_org_isolation" ON "pay_runs" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());

ALTER TABLE "payslips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payslips" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payslips_org_isolation" ON "payslips" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
