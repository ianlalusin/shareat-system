-- 0195 - T-392 S3: the dual-run comparator's three tables.
-- docs/tasks/392-dual-run-comparator.md Contract section 3 and "S3 rulings" (binding). Hand-authored per ADR-012 s5.
-- Merges after 0194 (T-398 S1): the store and person references use 0194's same-org composite FK pattern.
--
--   dual_run_reports      one row per store-week VERSION (R8): append-only, the identity is unique, a changed
--                         fingerprint is a new row. CHECKs: week_start is a Monday, through is inside the week,
--                         verdict is one of four, no_data => compared_days = 0 (ruling 3: only no_data implies 0).
--   dual_run_lines        the line table of one report: v1 / v2 / delta, class, per-day jsonb. delta = v2 - v1 is a CHECK.
--                         org_id is NOT NULL and the composite FK (org_id, report_id) keeps it equal to its report's; the
--                         repo copies it from the report (S3 money ruling e). No trigger.
--   dual_run_dispositions what a person asserted about a delta: V1_DEFECT or V2_DEFECT only, always with a DEF-nnn ref
--                         (ref is NOT NULL plus the regex CHECK, ruling 4).
-- Every money column is numeric(14,2) with a *_finite_check (T-371). All three: RLS ENABLE + FORCE, app role SELECT and
-- INSERT only (append-only: no UPDATE, no DELETE). No trigger.
--
-- READ ONLY production precheck (additive; nothing to backfill):
--   select to_regclass('dual_run_reports'), to_regclass('dual_run_lines'), to_regclass('dual_run_dispositions');  -- expect NULL x3

CREATE TABLE "dual_run_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"through" date NOT NULL,
	"v1_fingerprint" text NOT NULL,
	"v2_fingerprint" text NOT NULL,
	"keys_sha" text NOT NULL,
	"v1_snapshot_sha" text NOT NULL,
	"v1_extracted_at" timestamp with time zone NOT NULL,
	"verdict" text NOT NULL,
	"compared_days" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dual_run_reports_week_monday_check" CHECK (extract(isodow from "week_start") = 1),
	CONSTRAINT "dual_run_reports_through_in_week_check" CHECK ("through" >= "week_start" AND "through" <= "week_start" + 6),
	CONSTRAINT "dual_run_reports_verdict_check" CHECK ("verdict" in ('no_data','ties','explained','open')),
	CONSTRAINT "dual_run_reports_compared_days_check" CHECK ("compared_days" >= 0 AND "compared_days" <= 7),
	CONSTRAINT "dual_run_reports_no_data_days_check" CHECK ("verdict" <> 'no_data' OR "compared_days" = 0),
	CONSTRAINT "dual_run_reports_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "dual_run_reports_identity_unique" UNIQUE ("org_id","store_id","week_start","through","v1_fingerprint","keys_sha","v2_fingerprint")
);--> statement-breakpoint

CREATE TABLE "dual_run_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"line_key" text NOT NULL,
	"label" text NOT NULL,
	"v1_amount" numeric(14,2) NOT NULL,
	"v2_amount" numeric(14,2) NOT NULL,
	"delta" numeric(14,2) NOT NULL,
	"class" text NOT NULL,
	"paired" boolean NOT NULL,
	"auto_reason" text,
	"per_day" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"v1_counter" numeric(14,2),
	"opening_gap" numeric(14,2),
	CONSTRAINT "dual_run_lines_key_unique" UNIQUE ("report_id","kind","line_key"),
	CONSTRAINT "dual_run_lines_kind_check" CHECK ("kind" in ('cash_bank','staff_cash','sales_tender','expense_category','ap_supplier','inventory_basis','unassigned_store')),
	CONSTRAINT "dual_run_lines_delta_check" CHECK ("delta" = "v2_amount" - "v1_amount"),
	CONSTRAINT "dual_run_lines_class_check" CHECK ("class" in (
		'TIES','INVENTORY_BASIS','PAYROLL_ON_V1','NOT_IN_DUAL_RUN_SCOPE','V2_ONLY_EVENT','V1_CASH_RESIDUAL','AP_AT_INVOICE',
		'SUPPLIER_ADVANCE_1240','V2_CORRECTION_DATED_LATER','CHANNEL_AR_FLOW','PENDING_V2','PENDING_V1','DATE_SHIFT',
		'NOT_DOUBLE_ENTERED','KEYING_DIFFERENCE','MISCLASSIFIED','UNMAPPED_KEY','V1_DEFECT','V2_DEFECT','UNEXPLAINED',
		'V1_REMITTED_FIELD_ZERO','V1_UNKNOWN_EXPENSE_GROUP','V1_EXPENSE_ENTRY_GROUP_CONFLICT')),
	CONSTRAINT "dual_run_lines_v1_amount_finite_check" CHECK ("v1_amount" > '-Infinity'::numeric and "v1_amount" < 'Infinity'::numeric),
	CONSTRAINT "dual_run_lines_v2_amount_finite_check" CHECK ("v2_amount" > '-Infinity'::numeric and "v2_amount" < 'Infinity'::numeric),
	CONSTRAINT "dual_run_lines_delta_finite_check" CHECK ("delta" > '-Infinity'::numeric and "delta" < 'Infinity'::numeric),
	CONSTRAINT "dual_run_lines_v1_counter_finite_check" CHECK ("v1_counter" > '-Infinity'::numeric and "v1_counter" < 'Infinity'::numeric),
	CONSTRAINT "dual_run_lines_opening_gap_finite_check" CHECK ("opening_gap" > '-Infinity'::numeric and "opening_gap" < 'Infinity'::numeric)
);--> statement-breakpoint

CREATE TABLE "dual_run_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"kind" text NOT NULL,
	"line_key" text NOT NULL,
	"delta_at" numeric(14,2) NOT NULL,
	"class" text NOT NULL,
	"ref" text NOT NULL,
	"note" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dual_run_dispositions_kind_check" CHECK ("kind" in ('cash_bank','staff_cash','sales_tender','expense_category','ap_supplier','inventory_basis','unassigned_store')),
	CONSTRAINT "dual_run_dispositions_class_check" CHECK ("class" in ('V1_DEFECT','V2_DEFECT')),
	CONSTRAINT "dual_run_dispositions_ref_check" CHECK ("ref" ~ '^DEF-[0-9]+$'),
	CONSTRAINT "dual_run_dispositions_delta_at_finite_check" CHECK ("delta_at" > '-Infinity'::numeric and "delta_at" < 'Infinity'::numeric)
);--> statement-breakpoint

ALTER TABLE "dual_run_reports" ADD CONSTRAINT "dual_run_reports_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_reports" ADD CONSTRAINT "dual_run_reports_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_reports" ADD CONSTRAINT "dual_run_reports_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_reports" ADD CONSTRAINT "dual_run_reports_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_reports" ADD CONSTRAINT "dual_run_reports_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "dual_run_lines" ADD CONSTRAINT "dual_run_lines_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_lines" ADD CONSTRAINT "dual_run_lines_report_id_dual_run_reports_id_fk"
	FOREIGN KEY ("report_id") REFERENCES "dual_run_reports"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_lines" ADD CONSTRAINT "dual_run_lines_report_same_org_fk"
	FOREIGN KEY ("org_id","report_id") REFERENCES "dual_run_reports"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "dual_run_dispositions" ADD CONSTRAINT "dual_run_dispositions_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_dispositions" ADD CONSTRAINT "dual_run_dispositions_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_dispositions" ADD CONSTRAINT "dual_run_dispositions_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_dispositions" ADD CONSTRAINT "dual_run_dispositions_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dual_run_dispositions" ADD CONSTRAINT "dual_run_dispositions_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "dual_run_reports_store_week_idx" ON "dual_run_reports" ("org_id","store_id","week_start");--> statement-breakpoint
CREATE INDEX "dual_run_lines_report_idx" ON "dual_run_lines" ("report_id");--> statement-breakpoint
CREATE INDEX "dual_run_dispositions_line_idx" ON "dual_run_dispositions" ("org_id","store_id","week_start","kind","line_key");--> statement-breakpoint

ALTER TABLE "dual_run_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dual_run_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dual_run_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dual_run_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dual_run_dispositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dual_run_dispositions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "dual_run_reports_org_isolation" ON "dual_run_reports"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "dual_run_lines_org_isolation" ON "dual_run_lines"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "dual_run_dispositions_org_isolation" ON "dual_run_dispositions"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

GRANT SELECT, INSERT ON "dual_run_reports" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT ON "dual_run_lines" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT ON "dual_run_dispositions" TO "shareat_app";
