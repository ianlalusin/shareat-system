-- 0228 - T-511 S2a: the Grab / Foodpanda settlement upload, database side.
-- docs/tasks/511-settlement-upload-s2-spec.md "Migration 0228" and docs/designs/channel-settlement-upload.md (Decisions Taken 1-16); hand-authored per ADR-012 s5.
-- Journal idx 228 (BOSS reserved 0228, 0229 and 0230 for T-511; 0226 T-508 and 0227 T-510 sort before it).
--
-- WHY. Ian wants platform statements (Grab, Foodpanda) read into the system and checked by a person before anything posts. This migration adds only the
-- places to PUT things: nothing here reads a file, shows a screen or posts a journal entry.
--
-- SHAPE.
--   sales_channels.platform, .platform_store_code   which platform a channel is and the store code printed on its statements. Both set or both NULL.
--                                                   Unique per (org, platform, lower(trim(code))) across ACTIVE AND INACTIVE channels (a retired channel keeps its code).
--   loans.repayment_amount                          the expected daily repayment (numeric(14,2), NULL = not recorded, > 0 when set, finite check).
--   stored_files_purpose_check                      widened with 'channel_settlement_file' (0204 pattern: DROP, ADD NOT VALID, VALIDATE).
--   settlement_uploads                              one row per uploaded file (fingerprint unique per org: the same file twice is refused).
--   settlement_day_lines                            one row per channel, sales date and version; carries the review decision.
--   settlement_loan_lines                           allocation units for a day's loan rows.
--   settlement_other_lines                          adjustments, charges and the like (PandaGO rows are never booked).
--   log_break_glass_approval                        its capability list must equal CAPABILITIES (0220/0222/0224 pin): + upload_settlement_files,
--                                                   edit_platform_store_code, edit_loan_repayment_amount.
--
-- ORDER OF MERGE. log_break_glass_approval is re-created in full here. 0226 (T-508) may also re-create it. Whichever migration merges LAST must list EVERY
-- capability in CAPABILITIES (tests/unit/t398-s6-approval-capability-list.test.ts reads the newest migration that defines the function): re-copy the list
-- from the other one and add its names, do not just keep this file's list.
--
-- MONEY. Every numeric column is numeric(14,2) with a <table>_<column>_finite_check of the exact body the t327 census compares. `order_value` holds the NET
-- figure staff record (Grab "Net Sales", Foodpanda column R); see the column comment. A stored money column is never updatable in place (grants below).
--
-- FOREIGN KEYS. Composite-only same-org twins (org_id, col) -> parent (org_id, id), never a bare single-column FK (t398 C1). settlement_uploads and
-- settlement_day_lines are themselves FK targets, so each carries exactly one inline UNIQUE (org_id, id) (t398 K2). No jsonb, and no uuid column named
-- *_id / *_by without a twin FK (t398 C6); the content hash is called `fingerprint`.
-- STORE CONSISTENCY (BOSS 3 Nov, delta to 2a). A day line's and an upload's store_id MUST equal their channel's store_id: managers are scoped by the line's store_id,
-- so a wrong store there would show one store's money to another store's manager. The channel reference on settlement_uploads and settlement_day_lines is therefore the
-- 3-column composite (org_id, channel_id, store_id) -> sales_channels (org_id, id, store_id), which REPLACES the 2-column (org_id, channel_id) twin (it still pins the org,
-- so it is still the same-org guard). It needs a hand-added UNIQUE (org_id, id, store_id) on sales_channels (section 1; trivially true, id alone is unique). The separate
-- (org_id, store_id) -> stores twin stays. ON UPDATE NO ACTION: moving a channel to another store is refused while any upload or day line references it.
-- ONE SETTLEMENT PER DAY LINE (BOSS 3 Nov). settlement_day_lines_settlement_id_key: UNIQUE (org_id, settlement_id) WHERE settlement_id IS NOT NULL.
--
-- RLS and GRANTS (ADR-012 s5 rules 4 and 4a). ENABLE + FORCE RLS and the policy <table>_org_isolation (app_current_org()) on all four. The app role gets SELECT and INSERT, and
-- COLUMN-LEVEL UPDATE only (precedent 0222:139): settlement_uploads (superseded_by); settlement_day_lines (review_state, decision_reason, decided_by, decided_at,
-- settlement_id, is_current, changed_since_booked, recorded_figure, difference); settlement_loan_lines (is_active); settlement_other_lines (is_current).
-- No DELETE, no TRUNCATE. Staged rows are superseded, never deleted.
--
-- LOCK BUDGET (ADR-012 s5, as 0225). The ALTERs touch sales_channels, loans and stored_files, all small tables; the purpose CHECK is added NOT VALID and validated in a
-- second statement so the full-table scan runs under a lighter lock. First statement SET LOCAL lock_timeout = '5s' (resets at commit).
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 1. sales_channels: platform and the store code the platform prints
ALTER TABLE "sales_channels" ADD COLUMN "platform" text;
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD COLUMN "platform_store_code" text;
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_platform_check" CHECK ("platform" IS NULL OR "platform" IN ('grab', 'foodpanda'));
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_platform_code_pair_check" CHECK (("platform" IS NULL) = ("platform_store_code" IS NULL));
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_platform_code_not_blank_check" CHECK ("platform_store_code" IS NULL OR length(trim("platform_store_code")) > 0);
--> statement-breakpoint
-- Case- and whitespace-insensitive, per org and platform, over ACTIVE AND INACTIVE channels (precedent item_aliases_org_alias_key, 0224). NULL codes never collide.
CREATE UNIQUE INDEX "sales_channels_org_platform_code_key" ON "sales_channels" ("org_id", "platform", lower(trim("platform_store_code"))) WHERE "platform_store_code" IS NOT NULL;
--> statement-breakpoint
-- The target of the 3-column channel+store FK on settlement_uploads and settlement_day_lines (section 4). Trivially true (id alone is unique); it sits beside the
-- (org_id, id) unique from 0213, which stays the single target of every other composite twin (t398 K2 counts only the 2-column one).
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_org_id_id_store_id_unique" UNIQUE ("org_id", "id", "store_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. loans: the expected daily repayment
ALTER TABLE "loans" ADD COLUMN "repayment_amount" numeric(14,2);
--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_repayment_amount_positive_check" CHECK ("repayment_amount" > 0);
--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_repayment_amount_finite_check" CHECK ("repayment_amount" > '-Infinity'::numeric AND "repayment_amount" < 'Infinity'::numeric);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. stored_files: the purpose of an uploaded settlement statement (8 current values from 0205 + 'channel_settlement_file')
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_purpose_check";
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_purpose_check" CHECK ("purpose" IN ('receipt_photo', 'ar_collection_proof', 'memo_document', 'wastage_dispute', 'onboarding_document', 'staff_photo', 'staff_signature', 'leave_document', 'channel_settlement_file')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "stored_files" VALIDATE CONSTRAINT "stored_files_purpose_check";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4a. settlement_uploads: one row per uploaded file
CREATE TABLE "settlement_uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"file_kind" text NOT NULL,
	"file_id" uuid NOT NULL,
	"pdf_file_id" uuid,
	"fingerprint" text NOT NULL,
	"reader_version" text NOT NULL,
	"matched_code" text,
	"period_from" date,
	"period_to" date,
	"invoice_number" text,
	"orders_read" integer DEFAULT 0 NOT NULL,
	"loan_rows_read" integer DEFAULT 0 NOT NULL,
	"other_rows_read" integer DEFAULT 0 NOT NULL,
	"superseded_by" uuid,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_uploads_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "settlement_uploads_platform_check" CHECK ("platform" IN ('grab', 'foodpanda')),
	CONSTRAINT "settlement_uploads_file_kind_check" CHECK ("file_kind" IN ('grab_transactions', 'grab_transfers', 'foodpanda_invoice')),
	CONSTRAINT "settlement_uploads_counts_check" CHECK ("orders_read" >= 0 AND "loan_rows_read" >= 0 AND "other_rows_read" >= 0)
);
--> statement-breakpoint
ALTER TABLE "settlement_uploads" ADD CONSTRAINT "settlement_uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- 3 columns: pins the org AND the store (the upload's store_id must be its channel's store).
ALTER TABLE "settlement_uploads" ADD CONSTRAINT "settlement_uploads_channel_store_same_org_fk" FOREIGN KEY ("org_id", "channel_id", "store_id") REFERENCES "public"."sales_channels"("org_id", "id", "store_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_uploads" ADD CONSTRAINT "settlement_uploads_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_uploads" ADD CONSTRAINT "settlement_uploads_file_id_same_org_fk" FOREIGN KEY ("org_id", "file_id") REFERENCES "public"."stored_files"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_uploads" ADD CONSTRAINT "settlement_uploads_pdf_file_id_same_org_fk" FOREIGN KEY ("org_id", "pdf_file_id") REFERENCES "public"."stored_files"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_uploads" ADD CONSTRAINT "settlement_uploads_uploaded_by_same_org_fk" FOREIGN KEY ("org_id", "uploaded_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_uploads" ADD CONSTRAINT "settlement_uploads_superseded_by_same_org_fk" FOREIGN KEY ("org_id", "superseded_by") REFERENCES "public"."settlement_uploads"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_uploads_org_fingerprint_key" ON "settlement_uploads" ("org_id", "fingerprint");
--> statement-breakpoint
CREATE INDEX "settlement_uploads_org_channel_idx" ON "settlement_uploads" ("org_id", "channel_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4b. settlement_day_lines: one row per channel, sales date and version
CREATE TABLE "settlement_day_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"sales_date" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"source_upload_id" uuid NOT NULL,
	"payout_upload_id" uuid,
	"order_value" numeric(14,2) NOT NULL,
	"gross_info" numeric(14,2) NOT NULL,
	"commission" numeric(14,2) NOT NULL,
	"marketing" numeric(14,2) NOT NULL,
	"platform_fee" numeric(14,2) NOT NULL,
	"vendor_discount" numeric(14,2) NOT NULL,
	"loan_deduction" numeric(14,2) NOT NULL,
	"loan_disbursal" numeric(14,2) NOT NULL,
	"net_payout" numeric(14,2) NOT NULL,
	"unexplained" numeric(14,2) DEFAULT 0 NOT NULL,
	"recorded_figure" numeric(14,2),
	"difference" numeric(14,2),
	"payout_reference" text,
	"payout_date" date,
	"payment_arrival_date" date,
	"paid_state" text NOT NULL,
	"fee_month_note" text,
	"changed_since_booked" boolean DEFAULT false NOT NULL,
	"review_state" text DEFAULT 'pending' NOT NULL,
	"decision_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"settlement_id" uuid,
	CONSTRAINT "settlement_day_lines_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "settlement_day_lines_platform_check" CHECK ("platform" IN ('grab', 'foodpanda')),
	CONSTRAINT "settlement_day_lines_version_check" CHECK ("version" >= 1),
	CONSTRAINT "settlement_day_lines_paid_state_check" CHECK ("paid_state" IN ('paid', 'not_paid')),
	CONSTRAINT "settlement_day_lines_review_state_check" CHECK ("review_state" IN ('pending', 'booked', 'rejected')),
	-- pending: nothing decided yet. rejected: a person said no and gave a reason, and nothing was booked. booked: a person said yes and a settlement exists.
	CONSTRAINT "settlement_day_lines_review_shape_check" CHECK (
		("review_state" = 'pending' AND "decision_reason" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL AND "settlement_id" IS NULL)
		OR ("review_state" = 'rejected' AND "decision_reason" IS NOT NULL AND length(trim("decision_reason")) > 0 AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "settlement_id" IS NULL)
		OR ("review_state" = 'booked' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "settlement_id" IS NOT NULL)
	),
	CONSTRAINT "settlement_day_lines_order_value_finite_check" CHECK ("order_value" > '-Infinity'::numeric AND "order_value" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_gross_info_finite_check" CHECK ("gross_info" > '-Infinity'::numeric AND "gross_info" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_commission_finite_check" CHECK ("commission" > '-Infinity'::numeric AND "commission" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_marketing_finite_check" CHECK ("marketing" > '-Infinity'::numeric AND "marketing" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_platform_fee_finite_check" CHECK ("platform_fee" > '-Infinity'::numeric AND "platform_fee" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_vendor_discount_finite_check" CHECK ("vendor_discount" > '-Infinity'::numeric AND "vendor_discount" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_loan_deduction_finite_check" CHECK ("loan_deduction" > '-Infinity'::numeric AND "loan_deduction" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_loan_disbursal_finite_check" CHECK ("loan_disbursal" > '-Infinity'::numeric AND "loan_disbursal" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_net_payout_finite_check" CHECK ("net_payout" > '-Infinity'::numeric AND "net_payout" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_unexplained_finite_check" CHECK ("unexplained" > '-Infinity'::numeric AND "unexplained" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_recorded_figure_finite_check" CHECK ("recorded_figure" > '-Infinity'::numeric AND "recorded_figure" < 'Infinity'::numeric),
	CONSTRAINT "settlement_day_lines_difference_finite_check" CHECK ("difference" > '-Infinity'::numeric AND "difference" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "settlement_day_lines" ADD CONSTRAINT "settlement_day_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- 3 columns: pins the org AND the store (the day line's store_id must be its channel's store; managers are scoped by it).
ALTER TABLE "settlement_day_lines" ADD CONSTRAINT "settlement_day_lines_channel_store_same_org_fk" FOREIGN KEY ("org_id", "channel_id", "store_id") REFERENCES "public"."sales_channels"("org_id", "id", "store_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_day_lines" ADD CONSTRAINT "settlement_day_lines_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_day_lines" ADD CONSTRAINT "settlement_day_lines_source_upload_id_same_org_fk" FOREIGN KEY ("org_id", "source_upload_id") REFERENCES "public"."settlement_uploads"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_day_lines" ADD CONSTRAINT "settlement_day_lines_payout_upload_id_same_org_fk" FOREIGN KEY ("org_id", "payout_upload_id") REFERENCES "public"."settlement_uploads"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_day_lines" ADD CONSTRAINT "settlement_day_lines_decided_by_same_org_fk" FOREIGN KEY ("org_id", "decided_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_day_lines" ADD CONSTRAINT "settlement_day_lines_settlement_id_same_org_fk" FOREIGN KEY ("org_id", "settlement_id") REFERENCES "public"."channel_settlements"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- One CURRENT line per channel and sales date; every version of a date is unique even when retired.
CREATE UNIQUE INDEX "settlement_day_lines_current_key" ON "settlement_day_lines" ("org_id", "channel_id", "sales_date") WHERE "is_current";
--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_day_lines_version_key" ON "settlement_day_lines" ("org_id", "channel_id", "sales_date", "version");
--> statement-breakpoint
-- One day line per channel_settlements row (a retry or a 2c/2d bug must not book two days onto one settlement). Partial: pending and rejected lines have no settlement.
CREATE UNIQUE INDEX "settlement_day_lines_settlement_id_key" ON "settlement_day_lines" ("org_id", "settlement_id") WHERE "settlement_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "settlement_day_lines_org_store_date_idx" ON "settlement_day_lines" ("org_id", "store_id", "sales_date");
--> statement-breakpoint
COMMENT ON COLUMN "settlement_day_lines"."order_value" IS 'NET sales as staff record them, i.e. AFTER the platform discount: Grab "Net Sales", Foodpanda column R. This is the figure compared with what staff recorded.';
--> statement-breakpoint
COMMENT ON COLUMN "settlement_day_lines"."gross_info" IS 'Information only: the gross before the discount (Grab "Amount", Foodpanda column K). Never booked.';
--> statement-breakpoint
COMMENT ON COLUMN "settlement_day_lines"."vendor_discount" IS 'Information only, signed: the discount the merchant funded (Grab merchant-funded discount, Foodpanda columns O+P+Q). Never booked: staff record the sale net of it, so booking it would count it twice.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4c. settlement_loan_lines: allocation units for a day's loan rows (an admin override inserts new active lines and flips the old ones inactive)
CREATE TABLE "settlement_loan_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"day_line_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"row_ordinal" integer NOT NULL,
	"loan_id" uuid,
	"allocation_source" text DEFAULT 'auto' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "settlement_loan_lines_kind_check" CHECK ("kind" IN ('deduction', 'disbursal')),
	CONSTRAINT "settlement_loan_lines_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "settlement_loan_lines_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric),
	CONSTRAINT "settlement_loan_lines_allocation_source_check" CHECK ("allocation_source" IN ('auto', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "settlement_loan_lines" ADD CONSTRAINT "settlement_loan_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_loan_lines" ADD CONSTRAINT "settlement_loan_lines_day_line_id_same_org_fk" FOREIGN KEY ("org_id", "day_line_id") REFERENCES "public"."settlement_day_lines"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_loan_lines" ADD CONSTRAINT "settlement_loan_lines_loan_id_same_org_fk" FOREIGN KEY ("org_id", "loan_id") REFERENCES "public"."loans"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "settlement_loan_lines_org_day_line_idx" ON "settlement_loan_lines" ("org_id", "day_line_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4d. settlement_other_lines: adjustments, charges and the like. PandaGO is never booked from a statement.
CREATE TABLE "settlement_other_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"day_line_id" uuid,
	"kind" text NOT NULL,
	"booked_as" text NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"line_date" date,
	"description" text,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "settlement_other_lines_kind_check" CHECK ("kind" IN ('adjustment', 'compensation', 'chargeback', 'withholding_tax', 'advertisement', 'cancelled_order', 'period_charge', 'platform_fee_weekly', 'pandago')),
	CONSTRAINT "settlement_other_lines_booked_as_check" CHECK ("booked_as" IN ('platformFee', 'marketing', 'none')),
	CONSTRAINT "settlement_other_lines_pandago_check" CHECK ("kind" <> 'pandago' OR "booked_as" = 'none'),
	-- Generic text only, no personal data (design Decision on other-row descriptions): capped so a whole statement line cannot be pasted in.
	CONSTRAINT "settlement_other_lines_description_length_check" CHECK ("description" IS NULL OR char_length("description") <= 200),
	CONSTRAINT "settlement_other_lines_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" ADD CONSTRAINT "settlement_other_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" ADD CONSTRAINT "settlement_other_lines_upload_id_same_org_fk" FOREIGN KEY ("org_id", "upload_id") REFERENCES "public"."settlement_uploads"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" ADD CONSTRAINT "settlement_other_lines_day_line_id_same_org_fk" FOREIGN KEY ("org_id", "day_line_id") REFERENCES "public"."settlement_day_lines"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "settlement_other_lines_org_upload_idx" ON "settlement_other_lines" ("org_id", "upload_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. RLS (ADR-012 s5 rule 4)
ALTER TABLE "settlement_uploads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "settlement_uploads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "settlement_uploads_org_isolation" ON "settlement_uploads" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "settlement_day_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "settlement_day_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "settlement_day_lines_org_isolation" ON "settlement_day_lines" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "settlement_loan_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "settlement_loan_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "settlement_loan_lines_org_isolation" ON "settlement_loan_lines" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "settlement_other_lines_org_isolation" ON "settlement_other_lines" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 6. Grants (ADR-012 s5 rule 4a): born SELECT + INSERT; UPDATE only on the named state columns, never on a money column; no DELETE, no TRUNCATE.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "settlement_uploads", "settlement_day_lines", "settlement_loan_lines", "settlement_other_lines" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "settlement_uploads", "settlement_day_lines", "settlement_loan_lines", "settlement_other_lines" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("superseded_by") ON "settlement_uploads" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("review_state", "decision_reason", "decided_by", "decided_at", "settlement_id", "is_current", "changed_since_booked", "recorded_figure", "difference") ON "settlement_day_lines" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("is_active") ON "settlement_loan_lines" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("is_current") ON "settlement_other_lines" TO "shareat_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 7. T-398 S6 pin: the capability list inside log_break_glass_approval must equal CAPABILITIES; T-511 S2a adds upload_settlement_files, edit_platform_store_code and
-- edit_loan_repayment_amount. Body identical to 0224 otherwise (grants survive CREATE OR REPLACE). If 0226 (T-508) also re-creates this function, the LAST to merge lists EVERY capability.
CREATE OR REPLACE FUNCTION "log_break_glass_approval"("p_person" uuid, "p_capability" text, "p_store" uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_agreement uuid;
	v_org uuid;
	v_franchisor uuid;
	v_name text;
	v_store uuid;
BEGIN
	IF p_person IS NULL THEN
		RETURN false;
	END IF;
	SELECT f."id", f."org_id", f."franchisor_org_id" INTO v_agreement, v_org, v_franchisor FROM "franchise_agreements" f WHERE f."franchisor_person_id" = p_person;
	IF NOT FOUND OR v_org IS DISTINCT FROM app_current_org() THEN
		RETURN false;
	END IF;
	-- Only the franchisor's own person logs his own approval: the caller's signed-in person must BE p_person (audit A1). Nobody else can write a row in his name.
	IF nullif(current_setting('app.person_id', true), '')::uuid IS DISTINCT FROM p_person THEN
		RAISE EXCEPTION 'Only the franchisor person himself can log his own approval.' USING ERRCODE = '42501';
	END IF;
	IF p_capability IS NULL OR NOT (p_capability = ANY (ARRAY[
		'record_sale', 'submit_sales_day', 'verify_sales_day', 'void_sales_day',
		'record_statutory_discount', 'void_statutory_discount', 'approve_pos_correction', 'accept_remittance',
		'record_till_count', 'resolve_till_variance', 'transfer_funds', 'create_expense',
		'edit_own_expense', 'edit_any_expense', 'void_expense', 'approve_expense',
		'record_stock_movement', 'adjust_inventory', 'record_wastage', 'charge_staff_for_discrepancy',
		'transfer_stock', 'void_transfer', 'record_supplier_return', 'void_supplier_return',
		'apply_supplier_credit', 'record_customer_return', 'void_customer_return', 'apply_customer_credit',
		'refund_customer', 'confirm_receipt', 'resolve_trade_discrepancy', 'set_item_threshold',
		'post_order_message', 'place_branch_order', 'fulfil_branch_order', 'dispatch_branch_order',
		'manage_locations', 'receive_delivery', 'allow_over_receipt', 'post_usage',
		'void_usage_record', 'open_count_session', 'commit_count', 'approve_supplier',
		'approve_buyer', 'set_credit_limit', 'manage_expense_budgets', 'manage_recurring_expenses',
		'override_credit_limit', 'record_ap_payment', 'record_ar_collection', 'write_off_receivable',
		'run_cutover', 'manage_items', 'approve_item', 'record_supplier_invoice',
		'verify_supplier_invoice', 'void_supplier_invoice', 'create_wholesale_order', 'dispatch_wholesale_order',
		'view_financial_reports', 'view_trial_balance', 'reverse_entry', 'close_period',
		'override_period_lock', 'create_missing_period', 'book_missed_month', 'post_journal_entry',
		'enrol_staff', 'manage_users', 'manage_stores', 'grant_capability',
		'manage_attendance', 'view_leave_document', 'set_pay_rate', 'run_payroll',
		'manage_payroll_rates', 'remit_statutory', 'view_staff_signature', 'pair_pos_tablet', 'provision_clock_terminal',
		'manage_store_settings', 'set_cash_policy', 'set_channel_payout', 'manage_price_lists',
		'view_menu', 'add_menu_item', 'manage_menu', 'request_menu_item',
		'set_menu_price', 'set_menu_depletion', 'switch_usage_source', 'manage_commissary_offerings',
		'manage_commissary_map', 'manage_fixed_assets', 'run_depreciation', 'manage_prepaid_items',
		'run_amortisation', 'manage_chart_of_accounts', 'post_production', 'edit_posted_production',
		'void_production', 'record_order_wastage', 'resolve_order_wastage', 'charge_staff_for_wastage',
		'reverse_auto_charge', 'manage_recipes', 'manage_pos_map', 'request_pos_map',
		'decide_pos_map_request', 'finalize_pos_usage_pull', 'unlink_store_from_pos', 'verify_own_sales_day',
		'view_activity_log', 'view_activity_log_restricted', 'verify_own_supplier_invoice', 'cross_org_access',
		'view_franchise_sales', 'view_franchise_access_log', 'approve_item_request',
		'upload_settlement_files', 'edit_platform_store_code', 'edit_loan_repayment_amount'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
