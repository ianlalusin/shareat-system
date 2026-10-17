-- 0205 - T-436: leave and absence tracking (kinds, caps, requests, per-date days, year-end SIL payout) and its payslip legs.
-- docs/tasks/436-leave-tracking.md; hand-authored per ADR-012 s5. Journal idx 205 (0204 = T-434 is not in this branch: the gap is legal).
--
-- WHY. v1 only recorded a past absence (no request, no approval, no paid/unpaid, payroll never read it). v2 adds requests with
-- approval, monthly + yearly caps per kind (most specific row wins), the 5 paid Service Incentive Leave days as a derived balance,
-- the statutory kinds (maternity / paternity per birth, solo parent, VAWC, special women), and pay: paid leave is priced by payroll
-- into payslips.leave_pay, and unused SIL days are paid out in cash at year end (or at final pay) into payslips.sil_conversion_pay.
--
-- SHAPE. Five tables + two payslip columns + the gross identity restated + the file-purpose CHECK re-created with all 8 purposes.
--   leave_types         the kinds. org_id NULL = the platform seed every org sees; an org may add its own (org_id = its org).
--   leave_caps          (org, kind, store?, position?) monthly/yearly limits, NULL = no limit. NULLS NOT DISTINCT unique.
--   leave_requests      the header: person, the employment it is filed under, status, paid, note (PERSONAL DATA, bible row 353).
--   leave_request_days  one row per date; owns the "one live leave day per PERSON per date" index and the pay-run freeze pair.
--   leave_commutations  the year-end / final-pay SIL cash payout, one per PERSON per year; paid by a run OR a separation, never both.
-- Kinds are referenced by CODE (text), not FK: platform rows have no org, and a same-org twin cannot point at them (T-398).
-- Four parents gain UNIQUE (org_id, id), the target of the same-org composite FKs (T-398): employments, positions, pay_runs, separations.
--
-- GRANTS. SELECT, INSERT, UPDATE for shareat_app on all five; no DELETE, TRUNCATE, REFERENCES, TRIGGER (nothing is ever deleted).
-- RLS. ENABLE + FORCE; org isolation through app_current_org() (DEF-077) with WITH CHECK (DEF-183). leave_types also READS the NULL-org seed.
-- No existing data is read, moved or deleted. The payslip gross identity is restated with two new zero-default legs, so every
-- existing row still satisfies it (leave_pay = sil_conversion_pay = 0).

ALTER TABLE "employments" ADD CONSTRAINT "employments_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- leave_types
CREATE TABLE "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"paid" boolean NOT NULL,
	"draws_sil" boolean DEFAULT false NOT NULL,
	"statutory" boolean DEFAULT false NOT NULL,
	"needs_proof" boolean DEFAULT false NOT NULL,
	"requestable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"legal_yearly_days" integer,
	"legal_per_birth_days" integer,
	"legal_max_births" integer,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_types_code_shape_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "leave_types_legal_days_positive_check" CHECK (
		("legal_yearly_days" IS NULL OR "legal_yearly_days" > 0)
		AND ("legal_per_birth_days" IS NULL OR "legal_per_birth_days" > 0)
		AND ("legal_max_births" IS NULL OR "legal_max_births" > 0))
);
--> statement-breakpoint
-- ⚠️ DELIBERATELY no FOREIGN KEY on leave_types.org_id. The NULL-org rows are the platform seed, and a FK to organizations would let
-- `TRUNCATE organizations CASCADE` (rls.test.ts runs exactly that on every test) wipe the seed with it. Only the RLS policies below
-- ever write a non-NULL org_id (WITH CHECK org_id = app_current_org()), so it cannot name an org that does not exist.
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_org_code_unique" UNIQUE NULLS NOT DISTINCT ("org_id", "code");
--> statement-breakpoint
-- The platform seed (org_id NULL). Inserted before RLS is switched on, so the policies below never see a NULL-org write.
INSERT INTO "leave_types" ("code", "label", "paid", "draws_sil", "statutory", "needs_proof", "requestable", "legal_yearly_days", "legal_per_birth_days", "legal_max_births", "sort_order") VALUES
	('no_show',       'Absent without notice',         false, false, false, false, false, NULL, NULL, NULL, 10),
	('sick',          'Sick leave',                    false, true,  false, true,  true,  NULL, NULL, NULL, 20),
	('personal',      'Personal leave',                false, true,  false, false, true,  NULL, NULL, NULL, 30),
	('emergency',     'Emergency leave',               false, true,  false, false, true,  NULL, NULL, NULL, 40),
	('sil',           'Service Incentive Leave',       true,  true,  true,  false, true,  NULL, NULL, NULL, 50),
	('maternity',     'Maternity leave (RA 11210)',    false, false, true,  true,  true,  NULL, 105,  NULL, 60),
	('paternity',     'Paternity leave (RA 8187)',     false, false, true,  true,  true,  NULL, 7,    4,    70),
	('solo_parent',   'Solo parent leave (RA 11861)',  true,  false, true,  true,  true,  7,    NULL, NULL, 80),
	('vawc',          'VAWC leave (RA 9262)',          true,  false, true,  true,  true,  10,   NULL, NULL, 90),
	('special_women', 'Special leave for women (RA 9710)', true, false, true, true, true,  60,   NULL, NULL, 100),
	('unpaid_other',  'Unpaid leave (other)',          false, false, false, false, true,  NULL, NULL, NULL, 110);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- leave_caps
CREATE TABLE "leave_caps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"leave_type" text NOT NULL,
	"store_id" uuid,
	"position_id" uuid,
	"monthly_cap" integer,
	"yearly_cap" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "leave_caps_nonnegative_check" CHECK (("monthly_cap" IS NULL OR "monthly_cap" >= 0) AND ("yearly_cap" IS NULL OR "yearly_cap" >= 0)),
	CONSTRAINT "leave_caps_scope_unique" UNIQUE NULLS NOT DISTINCT ("org_id", "leave_type", "store_id", "position_id")
);
--> statement-breakpoint
ALTER TABLE "leave_caps" ADD CONSTRAINT "leave_caps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_caps" ADD CONSTRAINT "leave_caps_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_caps" ADD CONSTRAINT "leave_caps_position_id_same_org_fk" FOREIGN KEY ("org_id", "position_id") REFERENCES "public"."positions"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_caps" ADD CONSTRAINT "leave_caps_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_caps" ADD CONSTRAINT "leave_caps_updated_by_same_org_fk" FOREIGN KEY ("org_id", "updated_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- leave_requests
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"leave_type" text NOT NULL,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"paid" boolean,
	"birth_date" date,
	"note" text,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"cancelled_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "leave_requests_status_check" CHECK ("status" IN ('pending','approved','rejected','cancelled','voided')),
	CONSTRAINT "leave_requests_origin_check" CHECK ("origin" IN ('request','record')),
	-- A decided request names who decided it; a pending or cancelled one has no decider.
	CONSTRAINT "leave_requests_decided_pair_check" CHECK (("decided_by" IS NULL) = ("decided_at" IS NULL)),
	CONSTRAINT "leave_requests_decided_shape_check" CHECK (("status" IN ('approved','rejected','voided')) = ("decided_by" IS NOT NULL)),
	CONSTRAINT "leave_requests_void_shape_check" CHECK (("status" = 'voided') = ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)),
	CONSTRAINT "leave_requests_cancel_shape_check" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "public"."employments"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requested_by_same_org_fk" FOREIGN KEY ("org_id", "requested_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_same_org_fk" FOREIGN KEY ("org_id", "decided_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "leave_requests_person_idx" ON "leave_requests" ("person_id", "status");
--> statement-breakpoint
CREATE INDEX "leave_requests_store_status_idx" ON "leave_requests" ("store_id", "status");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- leave_request_days
CREATE TABLE "leave_request_days" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"leave_type" text NOT NULL,
	"leave_date" date NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"frozen_at" timestamp with time zone,
	"frozen_by_pay_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "leave_request_days_kind_check" CHECK ("kind" IN ('leave','rest_day')),
	CONSTRAINT "leave_request_days_status_check" CHECK ("status" IN ('pending','approved','rejected','cancelled','voided','superseded_by_work')),
	-- Frozen is a pair or neither, like attendance_days (0105).
	CONSTRAINT "leave_request_days_frozen_pair_check" CHECK (("frozen_at" IS NULL) = ("frozen_by_pay_run_id" IS NULL)),
	-- Only an approved, paid leave day is ever frozen; a rest day or an unpaid day pays nothing.
	CONSTRAINT "leave_request_days_frozen_shape_check" CHECK ("frozen_by_pay_run_id" IS NULL OR ("status" = 'approved' AND "paid" AND "kind" = 'leave'))
);
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_request_id_same_org_fk" FOREIGN KEY ("org_id", "request_id") REFERENCES "public"."leave_requests"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "public"."employments"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_frozen_by_pay_run_fk" FOREIGN KEY ("frozen_by_pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_request_days" ADD CONSTRAINT "leave_request_days_frozen_by_pay_run_id_same_org_fk" FOREIGN KEY ("org_id", "frozen_by_pay_run_id") REFERENCES "public"."pay_runs"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- One LIVE (pending or approved) leave day per PERSON per date, whichever job or store it was filed under.
CREATE UNIQUE INDEX "leave_request_days_live_person_date_unique" ON "leave_request_days" ("person_id", "leave_date") WHERE "status" IN ('pending','approved');
--> statement-breakpoint
CREATE INDEX "leave_request_days_request_idx" ON "leave_request_days" ("request_id");
--> statement-breakpoint
CREATE INDEX "leave_request_days_store_date_idx" ON "leave_request_days" ("store_id", "leave_date");
--> statement-breakpoint
CREATE INDEX "leave_request_days_frozen_run_idx" ON "leave_request_days" ("frozen_by_pay_run_id") WHERE "frozen_by_pay_run_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- leave_commutations
CREATE TABLE "leave_commutations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"employment_id" uuid NOT NULL,
	"days" numeric(6, 2) NOT NULL,
	"daily_rate" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"frozen_at" timestamp with time zone,
	"frozen_by_pay_run_id" uuid,
	"separation_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "leave_commutations_year_check" CHECK ("year" BETWEEN 2000 AND 2200),
	CONSTRAINT "leave_commutations_amounts_nonnegative_check" CHECK ("days" >= 0 AND "daily_rate" >= 0 AND "amount" >= 0),
	-- Numeric columns also carry the finite check (T-327 / T-371 G4): NaN and Infinity pass an ordinary >= 0.
	CONSTRAINT "leave_commutations_days_finite_check" CHECK ("days" > '-Infinity'::numeric AND "days" < 'Infinity'::numeric),
	CONSTRAINT "leave_commutations_daily_rate_finite_check" CHECK ("daily_rate" > '-Infinity'::numeric AND "daily_rate" < 'Infinity'::numeric),
	CONSTRAINT "leave_commutations_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric),
	CONSTRAINT "leave_commutations_frozen_pair_check" CHECK (("frozen_at" IS NULL) = ("frozen_by_pay_run_id" IS NULL)),
	-- A payout is paid by a pay run OR by a separation's final pay, never both.
	CONSTRAINT "leave_commutations_one_payer_check" CHECK (NOT ("frozen_by_pay_run_id" IS NOT NULL AND "separation_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "leave_commutations" ADD CONSTRAINT "leave_commutations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_commutations" ADD CONSTRAINT "leave_commutations_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_commutations" ADD CONSTRAINT "leave_commutations_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "public"."employments"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_commutations" ADD CONSTRAINT "leave_commutations_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_commutations" ADD CONSTRAINT "leave_commutations_frozen_by_pay_run_fk" FOREIGN KEY ("frozen_by_pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_commutations" ADD CONSTRAINT "leave_commutations_frozen_by_pay_run_id_same_org_fk" FOREIGN KEY ("org_id", "frozen_by_pay_run_id") REFERENCES "public"."pay_runs"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_commutations" ADD CONSTRAINT "leave_commutations_separation_fk" FOREIGN KEY ("separation_id") REFERENCES "public"."separations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_commutations" ADD CONSTRAINT "leave_commutations_separation_id_same_org_fk" FOREIGN KEY ("org_id", "separation_id") REFERENCES "public"."separations"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- One payout per PERSON per calendar year (not per employment): two concurrent jobs are paid once.
CREATE UNIQUE INDEX "leave_commutations_person_year_unique" ON "leave_commutations" ("person_id", "year");
--> statement-breakpoint
CREATE INDEX "leave_commutations_run_idx" ON "leave_commutations" ("frozen_by_pay_run_id") WHERE "frozen_by_pay_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "leave_commutations_separation_idx" ON "leave_commutations" ("separation_id") WHERE "separation_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- payslips: the two new legs, and the gross identity restated (it must restate itself in the migration that adds a leg - 0105).
-- Neither leg goes into basic_pay: the 13th month reads basic_pay, and PD 851 excludes leave conversions from it.
ALTER TABLE "payslips" ADD COLUMN "leave_pay" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "sil_conversion_pay" numeric(14, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_leave_pay_finite_check" CHECK ("leave_pay" > '-Infinity'::numeric AND "leave_pay" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_sil_conversion_pay_finite_check" CHECK ("sil_conversion_pay" > '-Infinity'::numeric AND "sil_conversion_pay" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_leave_legs_nonnegative_check" CHECK ("leave_pay" >= 0 AND "sil_conversion_pay" >= 0);
--> statement-breakpoint
ALTER TABLE "payslips" DROP CONSTRAINT "payslips_gross_identity_check";
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_gross_identity_check"
	CHECK ("gross_pay" = "basic_pay" + "ot_pay" + "night_diff_pay" + "holiday_pay" + "leave_pay" + "sil_conversion_pay");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- stored_files: the purpose list gains `leave_document` and keeps T-434's staff_photo + staff_signature (0204): all 8.
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_purpose_check";
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_purpose_check" CHECK ("purpose" IN
	('receipt_photo','ar_collection_proof','memo_document','wastage_dispute','onboarding_document','staff_photo','staff_signature','leave_document'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS + grants
ALTER TABLE "leave_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "leave_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "leave_types_read" ON "leave_types" FOR SELECT
	USING ("org_id" IS NULL OR "org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "leave_types_org_insert" ON "leave_types" FOR INSERT
	WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "leave_types_org_update" ON "leave_types" FOR UPDATE
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "leave_caps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "leave_caps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "leave_caps_org_isolation" ON "leave_caps"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "leave_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "leave_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "leave_requests_org_isolation" ON "leave_requests"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "leave_request_days" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "leave_request_days" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "leave_request_days_org_isolation" ON "leave_request_days"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "leave_commutations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "leave_commutations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "leave_commutations_org_isolation" ON "leave_commutations"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "leave_types", "leave_caps", "leave_requests", "leave_request_days", "leave_commutations" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "leave_types", "leave_caps", "leave_requests", "leave_request_days", "leave_commutations" TO "shareat_app";
