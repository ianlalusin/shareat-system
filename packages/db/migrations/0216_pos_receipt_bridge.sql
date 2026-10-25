-- 0216 - T-472 S1: the nightly POS receipt bridge tables (pos_bridge_receipts, _receipt_lines, _receipt_tenders, _day_checks),
-- the pos_bridge_receipts_current view, UNIQUE (org_id, id) on tenders, and the scheduler_runs job CHECK widened with 'pos_receipt_bridge'.
-- docs/tasks/472-pos-nightly-receipt-bridge.md Rulings 3-7; hand-authored per ADR-012 s5. Numbered 0216 by the orchestrator (0215 = T-455,
-- which merges first; until then the journal skips 215). Schema: packages/db/schema/pos-bridge.ts.
--
-- WHY. Every night the bridge copies each POS receipt (lines, payments, voids, refunds) into Postgres, read-only on Firebase, so the ERP can check
-- its daily totals against real receipts. Nothing is posted; sales_days is untouched. A new VERSION row is written only when a document's hash changes.
--
-- SHAPE. Money is whole centavos in bigint (RULES #6); money_flag marks a figure POS gave that was not a whole centavo. NO personal data: no customer
-- name/TIN/address, no senior/PWD name or ID (Ruling 7). Every child has its OWN org_id and a composite FK (org_id, receipt_id) ->
-- pos_bridge_receipts (org_id, id) (DEF-491: no single-column org->org FK, no via-header policy, no trigger). Children are ON DELETE CASCADE so the
-- 1 Jan 2027 date_scoped purge (Ruling 4, each table by its own pos_calendar_date) cannot be blocked by delete order. The tender link needs
-- UNIQUE (org_id, id) on tenders, added here as 0213 did for pos_v1_day_feeds.
--
-- RLS. ENABLE + FORCE, one org-isolation policy per table through app_current_org() (DEF-077) with WITH CHECK (DEF-183).
-- GRANTS. receipts / lines / tenders are append-only: SELECT, INSERT for shareat_app. day_checks is recomputed nightly: SELECT, INSERT, UPDATE.
-- The view is security_invoker = true, so it applies the CALLER's RLS on pos_bridge_receipts.
-- JOB CHECK. Rewritten as 0209 did; every existing value is kept. DROP ... IF EXISTS so the T-398 scratch-database tests, which strip every CHECK before
-- applying the pending migrations, can still apply this one.
-- NO feed_id on day_checks: the day-feed row is purged at cutover and a kept row may not point at a purged one.
CREATE TABLE "pos_bridge_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pos_store_id" text NOT NULL,
	"firestore_doc_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"receipt_number" text,
	"terminal_no" text,
	"parent_doc_id" text,
	"client_at" timestamp with time zone,
	"pos_calendar_date" date NOT NULL,
	"subtotal_centavos" bigint NOT NULL,
	"discount_centavos" bigint NOT NULL,
	"total_centavos" bigint NOT NULL,
	"money_flag" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"doc_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_bridge_receipts_version_unique" UNIQUE ("org_id", "pos_store_id", "firestore_doc_id", "version"),
	CONSTRAINT "pos_bridge_receipts_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "pos_bridge_receipts_version_check" CHECK ("version" >= 1),
	CONSTRAINT "pos_bridge_receipts_kind_check" CHECK ("kind" in ('sale', 'refund')),
	CONSTRAINT "pos_bridge_receipts_status_check" CHECK ("status" in ('final', 'voided', 'gone')),
	CONSTRAINT "pos_bridge_receipts_doc_hash_check" CHECK ("doc_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pos_bridge_receipts_pos_store_id_not_blank_check" CHECK (btrim("pos_store_id") <> ''),
	CONSTRAINT "pos_bridge_receipts_firestore_doc_id_not_blank_check" CHECK (btrim("firestore_doc_id") <> ''),
	CONSTRAINT "pos_bridge_receipts_raw_object_check" CHECK (jsonb_typeof("raw") = 'object')
);
--> statement-breakpoint
CREATE TABLE "pos_bridge_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"pos_calendar_date" date NOT NULL,
	"pos_item_id" text,
	"item_name" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price_centavos" bigint NOT NULL,
	"discount_centavos" bigint DEFAULT 0 NOT NULL,
	"line_total_centavos" bigint NOT NULL,
	"money_flag" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pos_bridge_receipt_lines_receipt_line_unique" UNIQUE ("org_id", "receipt_id", "line_no"),
	CONSTRAINT "pos_bridge_receipt_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "pos_bridge_receipt_lines_quantity_finite_check" CHECK ("quantity" > '-Infinity'::numeric and "quantity" < 'Infinity'::numeric)
);
--> statement-breakpoint
CREATE TABLE "pos_bridge_receipt_tenders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"pos_calendar_date" date NOT NULL,
	"method_alias" text NOT NULL,
	"tender_id" uuid,
	"amount_centavos" bigint NOT NULL,
	"money_flag" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pos_bridge_receipt_tenders_receipt_seq_unique" UNIQUE ("org_id", "receipt_id", "seq"),
	CONSTRAINT "pos_bridge_receipt_tenders_seq_check" CHECK ("seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "pos_bridge_day_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pos_store_id" text NOT NULL,
	"pos_calendar_date" date NOT NULL,
	"receipt_count" integer NOT NULL,
	"net_sales_centavos" bigint NOT NULL,
	"feed_total_centavos" bigint,
	"difference_centavos" bigint,
	"result" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_bridge_day_checks_store_day_unique" UNIQUE ("org_id", "store_id", "pos_calendar_date"),
	CONSTRAINT "pos_bridge_day_checks_result_check" CHECK ("result" in ('match', 'mismatch', 'pending')),
	CONSTRAINT "pos_bridge_day_checks_receipt_count_check" CHECK ("receipt_count" >= 0),
	CONSTRAINT "pos_bridge_day_checks_pending_shape_check" CHECK (("result" = 'pending') = ("feed_total_centavos" is null) and ("feed_total_centavos" is null) = ("difference_centavos" is null))
);
--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipts" ADD CONSTRAINT "pos_bridge_receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_lines" ADD CONSTRAINT "pos_bridge_receipt_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_tenders" ADD CONSTRAINT "pos_bridge_receipt_tenders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_bridge_day_checks" ADD CONSTRAINT "pos_bridge_day_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipts" ADD CONSTRAINT "pos_bridge_receipts_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_lines" ADD CONSTRAINT "pos_bridge_receipt_lines_receipt_id_same_org_fk" FOREIGN KEY ("org_id", "receipt_id") REFERENCES "public"."pos_bridge_receipts"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_tenders" ADD CONSTRAINT "pos_bridge_receipt_tenders_receipt_id_same_org_fk" FOREIGN KEY ("org_id", "receipt_id") REFERENCES "public"."pos_bridge_receipts"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_tenders" ADD CONSTRAINT "pos_bridge_receipt_tenders_tender_id_same_org_fk" FOREIGN KEY ("org_id", "tender_id") REFERENCES "public"."tenders"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_bridge_day_checks" ADD CONSTRAINT "pos_bridge_day_checks_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pos_bridge_receipts_store_day_idx" ON "pos_bridge_receipts" ("org_id", "store_id", "pos_calendar_date");
--> statement-breakpoint
CREATE INDEX "pos_bridge_receipt_lines_date_idx" ON "pos_bridge_receipt_lines" ("org_id", "pos_calendar_date");
--> statement-breakpoint
CREATE INDEX "pos_bridge_receipt_tenders_date_idx" ON "pos_bridge_receipt_tenders" ("org_id", "pos_calendar_date");
--> statement-breakpoint
CREATE INDEX "pos_bridge_day_checks_date_idx" ON "pos_bridge_day_checks" ("org_id", "pos_calendar_date");
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_bridge_receipts_org_isolation" ON "pos_bridge_receipts"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "pos_bridge_receipts" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "pos_bridge_receipts" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_bridge_receipt_lines_org_isolation" ON "pos_bridge_receipt_lines"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "pos_bridge_receipt_lines" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "pos_bridge_receipt_lines" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_tenders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_bridge_receipt_tenders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_bridge_receipt_tenders_org_isolation" ON "pos_bridge_receipt_tenders"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "pos_bridge_receipt_tenders" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "pos_bridge_receipt_tenders" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "pos_bridge_day_checks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_bridge_day_checks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_bridge_day_checks_org_isolation" ON "pos_bridge_day_checks"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "pos_bridge_day_checks" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pos_bridge_day_checks" TO "shareat_app";
--> statement-breakpoint
CREATE VIEW "public"."pos_bridge_receipts_current" WITH (security_invoker = true) AS
	SELECT DISTINCT ON ("org_id", "pos_store_id", "firestore_doc_id")
		"id", "org_id", "store_id", "pos_store_id", "firestore_doc_id", "version", "kind", "status", "receipt_number", "terminal_no",
		"parent_doc_id", "client_at", "pos_calendar_date", "subtotal_centavos", "discount_centavos", "total_centavos", "money_flag",
		"raw", "doc_hash", "created_at"
	FROM "pos_bridge_receipts"
	ORDER BY "org_id", "pos_store_id", "firestore_doc_id", "version" DESC;
--> statement-breakpoint
GRANT SELECT ON "pos_bridge_receipts_current" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "scheduler_runs" DROP CONSTRAINT IF EXISTS "scheduler_runs_job_check";
--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay',
	                 'order_wastage_backstop', 'finding_observation', 'budget_reissue', 'recurring_expenses',
	                 'orphan_file_sweep', 'fiscal_period_seed', 'usage_auto_post', 'pos_day_import', 'pos_receipt_bridge'));
