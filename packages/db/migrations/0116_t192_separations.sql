-- T-192 — separations: an employment's end, its pro-rated 13th month, and the clearance gate.
-- docs/tasks/192-separation-final-pay-clearance.md
--
-- separation_pay_amount is MANUALLY ENTERED, never derived — PH separation pay is owed only for
-- authorized causes (Labor Code Art. 298/299) at cause-specific multipliers; just cause and
-- resignation legally owe none. `cause` is captured for the record, not consumed by a formula.
--
-- Hand-written, per DEF-073/DEF-121 (this repo's drizzle-kit snapshot chain is stale since
-- ~migration 0020; every migration since has been hand-written from schema.ts). Never edited
-- after apply.

CREATE TABLE "separations" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE restrict,
  "store_id" uuid NOT NULL REFERENCES "stores"("id") ON DELETE restrict,
  "employment_id" uuid NOT NULL REFERENCES "employments"("id") ON DELETE restrict,
  "person_id" uuid NOT NULL REFERENCES "persons"("id") ON DELETE restrict,
  "separation_date" date NOT NULL,
  "cause" text NOT NULL,
  "thirteenth_month_basic_pay_earned" numeric(14, 2) DEFAULT '0' NOT NULL,
  "thirteenth_month_gross" numeric(14, 2) DEFAULT '0' NOT NULL,
  "separation_pay_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
  "advance_recovered" numeric(14, 2) DEFAULT '0' NOT NULL,
  "net_pay" numeric(14, 2) DEFAULT '0' NOT NULL,
  "clearance_confirmed_at" timestamp with time zone,
  "clearance_confirmed_by" uuid REFERENCES "persons"("id") ON DELETE restrict,
  "clearance_notes" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "money_account_id" uuid REFERENCES "money_accounts"("id") ON DELETE restrict,
  "posted_at" timestamp with time zone,
  "posted_by" uuid REFERENCES "persons"("id") ON DELETE restrict,
  "voided_at" timestamp with time zone,
  "voided_by" uuid REFERENCES "persons"("id") ON DELETE restrict,
  "void_reason" text,
  "journal_entry_id" uuid,
  "notes" text,
  "created_by" uuid NOT NULL REFERENCES "persons"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "separations_cause_check"
    CHECK ("cause" in ('resignation','just_cause','redundancy','retrenchment','closure','disease','other')),
  CONSTRAINT "separations_status_check" CHECK ("status" in ('draft', 'posted', 'voided')),
  CONSTRAINT "separations_thirteenth_month_nonnegative_check"
    CHECK ("thirteenth_month_basic_pay_earned" >= 0 and "thirteenth_month_gross" >= 0),
  CONSTRAINT "separations_separation_pay_nonnegative_check" CHECK ("separation_pay_amount" >= 0),
  CONSTRAINT "separations_net_nonnegative_check" CHECK ("net_pay" >= 0),
  CONSTRAINT "separations_net_identity_check"
    CHECK ("net_pay" = "thirteenth_month_gross" + "separation_pay_amount" - "advance_recovered"),
  CONSTRAINT "separations_advance_within_gross_check"
    CHECK ("advance_recovered" <= "thirteenth_month_gross" + "separation_pay_amount"),
  -- Clearance is a GATE, not a derived value — both null or both set.
  CONSTRAINT "separations_clearance_pair_check"
    CHECK (("clearance_confirmed_at" is null) = ("clearance_confirmed_by" is null)),
  -- Posting without clearance is unrepresentable at the database boundary too, not just checked
  -- in the domain layer — defence in depth for the one gate this table exists to enforce.
  CONSTRAINT "separations_posted_needs_clearance_check"
    CHECK ("status" = 'draft' or "clearance_confirmed_at" is not null),
  CONSTRAINT "separations_posted_pair_check"
    CHECK (("posted_at" is null) = ("posted_by" is null)),
  CONSTRAINT "separations_posted_shape_check"
    CHECK (("status" = 'draft') = ("posted_at" is null)),
  CONSTRAINT "separations_void_shape_check"
    CHECK (("status" = 'voided') = ("voided_at" is not null and "void_reason" is not null)),
  CONSTRAINT "separations_posted_needs_account_check"
    CHECK ("status" = 'draft' or "money_account_id" is not null)
);

-- One POSTED separation per employment at a time — same "void frees it to be posted again" shape
-- as pay_runs/thirteenth_month_runs. A voided separation (wrong cause, wrong date) does not
-- permanently block that employment from ever separating.
CREATE UNIQUE INDEX "separations_employment_posted_unique"
  ON "separations" ("employment_id") WHERE ("status" = 'posted');
CREATE INDEX "separations_org_store_idx" ON "separations" ("org_id", "store_id");
CREATE INDEX "separations_person_idx" ON "separations" ("person_id");

-- ---------------------------------------------------------------------------------------------
ALTER TABLE "separations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "separations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "separations_org_isolation" ON "separations" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
