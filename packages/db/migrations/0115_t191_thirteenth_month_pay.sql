-- T-191 — 13th-month pay. docs/tasks/191-thirteenth-month-pay.md
--
-- NOT pay_runs/payslips wearing a new name. pay_runs' overlap guard is a GiST EXCLUDE on a date
-- RANGE, built to stop two regular periods double-paying the same attendance days -- a 13th-month
-- "period" is the whole calendar year, which nests inside every regular period already posted for
-- it and would trip a guard built for a different mistake. payslips requires a pay_rate_id and
-- attendance minutes, neither of which a sum-across-the-year payout has an honest answer for.
-- So: a smaller pair, mirroring the PATTERN (run -> payout -> journal entry) without inheriting
-- fields that do not apply.
--
-- Hand-written, per DEF-073 (Drizzle's own snapshot chain for this repo is stale past migration
-- 0019 -- packages/db/migrations/meta/ has no snapshot files between 0019 and 0114 -- so
-- `drizzle-kit generate` cannot diff cleanly; every migration since has been hand-written from the
-- schema in packages/db/schema/, exactly as this one is). Never edited after apply.

CREATE TABLE "thirteenth_month_runs" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "store_id" uuid NOT NULL REFERENCES "stores"("id") ON DELETE restrict,
  "year" integer NOT NULL,
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
  CONSTRAINT "thirteenth_month_runs_year_check" CHECK ("year" between 2020 and 2100),
  CONSTRAINT "thirteenth_month_runs_status_check" CHECK ("status" in ('draft', 'posted', 'voided')),
  CONSTRAINT "thirteenth_month_runs_posted_pair_check"
    CHECK (("posted_at" is null) = ("posted_by" is null)),
  CONSTRAINT "thirteenth_month_runs_posted_shape_check"
    CHECK (("status" = 'draft') = ("posted_at" is null)),
  CONSTRAINT "thirteenth_month_runs_void_shape_check"
    CHECK (("status" = 'voided') = ("voided_at" is not null and "void_reason" is not null))
);

-- A year cannot partially overlap another year, so a plain partial-unique index is enough --
-- unlike pay_runs, no GiST exclude is needed. Voiding frees the year to be posted again, matching
-- pay_runs' own "void -> payable again" shape.
CREATE UNIQUE INDEX "thirteenth_month_runs_store_year_posted_unique"
  ON "thirteenth_month_runs" ("store_id", "year") WHERE ("status" = 'posted');

CREATE TABLE "thirteenth_month_payouts" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "thirteenth_month_runs"("id") ON DELETE restrict,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "employment_id" uuid NOT NULL REFERENCES "employments"("id") ON DELETE restrict,
  -- Stored as well as the employment: an employment can end, and this row must stay readable.
  "person_id" uuid NOT NULL REFERENCES "persons"("id") ON DELETE restrict,
  -- Kept alongside gross_pay even though gross = basic_pay_earned / 12 is derivable, for the same
  -- reason payslips keeps its component pays: an amount that decided somebody's money should be
  -- readable years later without re-deriving it from rows that may have changed shape by then.
  "basic_pay_earned" numeric(14, 2) NOT NULL,
  "gross_pay" numeric(14, 2) NOT NULL,
  "advance_recovered" numeric(14, 2) DEFAULT '0' NOT NULL,
  "net_pay" numeric(14, 2) NOT NULL,
  "journal_entry_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thirteenth_month_payouts_basic_pay_nonnegative_check" CHECK ("basic_pay_earned" >= 0),
  CONSTRAINT "thirteenth_month_payouts_gross_nonnegative_check" CHECK ("gross_pay" >= 0),
  CONSTRAINT "thirteenth_month_payouts_net_nonnegative_check" CHECK ("net_pay" >= 0),
  CONSTRAINT "thirteenth_month_payouts_net_identity_check"
    CHECK ("net_pay" = "gross_pay" - "advance_recovered"),
  CONSTRAINT "thirteenth_month_payouts_advance_within_gross_check" CHECK ("advance_recovered" <= "gross_pay")
);

-- One payout per job per run. Two would pay the year twice.
CREATE UNIQUE INDEX "thirteenth_month_payouts_run_employment_unique"
  ON "thirteenth_month_payouts" ("run_id", "employment_id");

-- ---------------------------------------------------------------------------------------------
-- RLS. Both org_column -- thirteenth_month_payouts names what a person earned, same sensitivity
-- as payslips.
ALTER TABLE "thirteenth_month_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "thirteenth_month_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "thirteenth_month_runs_org_isolation" ON "thirteenth_month_runs" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());

ALTER TABLE "thirteenth_month_payouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "thirteenth_month_payouts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "thirteenth_month_payouts_org_isolation" ON "thirteenth_month_payouts" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
