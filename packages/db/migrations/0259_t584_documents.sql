-- 0259 - T-584: templated HR documents (COE, memo, NTE, contract). docs/tasks/584-documents.md s4 (with R7); hand-authored per ADR-012 s5.
-- Journal idx 259: 0258 is reserved on the coordination board by another lane; the journal test allows a gap and needs idx and when to increase.
--
-- WHY. Admins and store managers were retyping Word files for every certificate of employment, memo, notice to explain and contract. Templates
-- are kept as versions; an issued document is numbered (DOC-YYYY-NNNN, per organisation per year), keeps every version of its text (R7), and is
-- signed per version with the owner's saved signature, attached only after the owner enters their own Employee ID and PIN (the domain checks that).
--
-- THE TABLES. document_templates (library entry), document_template_versions (append-only), issued_documents (only the void columns may change,
-- once), issued_document_versions (append-only; the current version is the highest version_no), issued_document_signatures (append-only; one per
-- version and slot; signature_file_id is copied BY REFERENCE at signing, so a later change to persons.signature_file_id changes nothing printed).
--
-- THE LOCKS (the 0221 / 0239 pattern; no layer is the only lock).
--   1. RLS ENABLE and FORCE, one policy per table through app_current_org() (DEF-077).
--   2. Triggers (ENABLE ALWAYS): documents_refuse_mutation on the three append-only tables (SQLSTATE 23001); issued_documents_guard (no delete; only
--      the void columns change, once); issued_document_versions_sequence (version_no is exactly the previous + 1; no revision of a void document;
--      the document row is locked); issued_document_signatures_current_version (only the current version of a live document can be signed).
--   3. Grants (ADR-012 s5 4a): shareat_app has SELECT + INSERT everywhere; column-level UPDATE only on document_templates (name, kind, retired_at)
--      and issued_documents (the three void columns). No DELETE anywhere.
--   4. Same-org composite foreign keys on every reference (the house pattern, T-398 S1).
--
-- NUMBERING. The number is allocated in the domain under pg_advisory_xact_lock(org, year); the unique index (org_id, number) is the backstop.
-- It also re-creates log_break_glass_approval with the three new capabilities (the t398-s6 test pins that list to CAPABILITIES). Every statement is
-- its own breakpoint, except the last. All five tables are new and empty: no rewrite, no long lock.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_templates_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "document_templates_kind_check" CHECK ("kind" IN ('coe', 'memo', 'nte', 'contract', 'other')),
	CONSTRAINT "document_templates_name_check" CHECK (btrim("name") <> '' AND "name" = btrim("name"))
);
--> statement-breakpoint
CREATE TABLE "document_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"body" text NOT NULL,
	"signature_slots" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_template_versions_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "document_template_versions_version_no_check" CHECK ("version_no" >= 1),
	CONSTRAINT "document_template_versions_body_check" CHECK (btrim("body") <> '' AND length("body") <= 50000),
	CONSTRAINT "document_template_versions_slots_check" CHECK ("signature_slots" <@ ARRAY['issuer', 'employee']::text[])
);
--> statement-breakpoint
CREATE TABLE "issued_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid,
	"number" text NOT NULL,
	"template_version_id" uuid NOT NULL,
	"employment_id" uuid,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "issued_documents_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "issued_documents_number_check" CHECK ("number" ~ '^DOC-[0-9]{4}-[0-9]{4,}$'),
	CONSTRAINT "issued_documents_void_all_or_nothing_check" CHECK (
		("voided_at" IS NULL AND "voided_by" IS NULL AND "void_reason" IS NULL)
		OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND COALESCE(btrim("void_reason"), '') <> '')
	)
);
--> statement-breakpoint
CREATE TABLE "issued_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"issued_document_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"body" text NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issued_document_versions_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "issued_document_versions_body_check" CHECK (btrim("body") <> '' AND length("body") <= 50000),
	CONSTRAINT "issued_document_versions_reason_check" CHECK (("version_no" = 1 AND "reason" IS NULL) OR ("version_no" > 1 AND COALESCE(btrim("reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "issued_document_signatures" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"issued_document_version_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"person_id" uuid NOT NULL,
	"signature_file_id" uuid NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issued_document_signatures_slot_check" CHECK ("slot" IN ('issuer', 'employee'))
);
--> statement-breakpoint
CREATE INDEX "document_templates_org_idx" ON "document_templates" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_template_versions_template_version_unique" ON "document_template_versions" ("template_id", "version_no");
--> statement-breakpoint
CREATE INDEX "document_template_versions_org_idx" ON "document_template_versions" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "issued_documents_org_number_unique" ON "issued_documents" ("org_id", "number");
--> statement-breakpoint
CREATE INDEX "issued_documents_org_issued_idx" ON "issued_documents" ("org_id", "issued_at");
--> statement-breakpoint
CREATE INDEX "issued_documents_employment_idx" ON "issued_documents" ("employment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "issued_document_versions_doc_version_unique" ON "issued_document_versions" ("issued_document_id", "version_no");
--> statement-breakpoint
CREATE INDEX "issued_document_versions_org_idx" ON "issued_document_versions" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "issued_document_signatures_version_slot_unique" ON "issued_document_signatures" ("issued_document_version_id", "slot");
--> statement-breakpoint
CREATE INDEX "issued_document_signatures_org_idx" ON "issued_document_signatures" ("org_id");
--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "document_templates" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_template_same_org_fk" FOREIGN KEY ("org_id", "template_id") REFERENCES "document_templates" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_template_version_id_document_template_vers_fk" FOREIGN KEY ("template_version_id") REFERENCES "document_template_versions" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "employments" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_issued_by_persons_id_fk" FOREIGN KEY ("issued_by") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_store_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_template_version_same_org_fk" FOREIGN KEY ("org_id", "template_version_id") REFERENCES "document_template_versions" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_employment_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_issued_by_same_org_fk" FOREIGN KEY ("org_id", "issued_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ADD CONSTRAINT "issued_document_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ADD CONSTRAINT "issued_document_versions_issued_document_id_issued_document_fk" FOREIGN KEY ("issued_document_id") REFERENCES "issued_documents" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ADD CONSTRAINT "issued_document_versions_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ADD CONSTRAINT "issued_document_versions_document_same_org_fk" FOREIGN KEY ("org_id", "issued_document_id") REFERENCES "issued_documents" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ADD CONSTRAINT "issued_document_versions_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ADD CONSTRAINT "issued_document_signatures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ADD CONSTRAINT "issued_document_signatures_issued_document_version_id_issue_fk" FOREIGN KEY ("issued_document_version_id") REFERENCES "issued_document_versions" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ADD CONSTRAINT "issued_document_signatures_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ADD CONSTRAINT "issued_document_signatures_signature_file_id_stored_files_id_fk" FOREIGN KEY ("signature_file_id") REFERENCES "stored_files" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ADD CONSTRAINT "issued_document_signatures_version_same_org_fk" FOREIGN KEY ("org_id", "issued_document_version_id") REFERENCES "issued_document_versions" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ADD CONSTRAINT "issued_document_signatures_person_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ADD CONSTRAINT "issued_document_signatures_file_same_org_fk" FOREIGN KEY ("org_id", "signature_file_id") REFERENCES "stored_files" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "document_templates_org_isolation" ON "document_templates" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "document_template_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_template_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "document_template_versions_org_isolation" ON "document_template_versions" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "issued_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "issued_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "issued_documents_org_isolation" ON "issued_documents" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "issued_document_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "issued_document_versions_org_isolation" ON "issued_document_versions" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "issued_document_signatures_org_isolation" ON "issued_document_signatures" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "documents_refuse_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A row of % is never changed or removed (% on row % is refused). Revise the document or issue a new template version instead.',
		TG_TABLE_NAME, TG_OP, COALESCE(OLD.id::text, '?')
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "documents_refuse_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "document_template_versions_append_only"
	BEFORE UPDATE OR DELETE ON "document_template_versions"
	FOR EACH ROW EXECUTE FUNCTION "documents_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "document_template_versions" ENABLE ALWAYS TRIGGER "document_template_versions_append_only";
--> statement-breakpoint
CREATE TRIGGER "issued_document_versions_append_only"
	BEFORE UPDATE OR DELETE ON "issued_document_versions"
	FOR EACH ROW EXECUTE FUNCTION "documents_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ENABLE ALWAYS TRIGGER "issued_document_versions_append_only";
--> statement-breakpoint
CREATE TRIGGER "issued_document_signatures_append_only"
	BEFORE UPDATE OR DELETE ON "issued_document_signatures"
	FOR EACH ROW EXECUTE FUNCTION "documents_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ENABLE ALWAYS TRIGGER "issued_document_signatures_append_only";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "issued_documents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'An issued document is never removed (row % is refused). Void it with a reason instead.', OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	-- Only the three void columns may change, and only once: the number, owner, store, employee, template version and time are fixed at issue.
	IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.store_id IS DISTINCT FROM OLD.store_id
		OR NEW.number IS DISTINCT FROM OLD.number OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
		OR NEW.employment_id IS DISTINCT FROM OLD.employment_id OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
		OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
		RAISE EXCEPTION 'An issued document cannot be edited (row % is refused). Revise it as a new version instead.', OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.voided_at IS NOT NULL THEN
		RAISE EXCEPTION 'An issued document that is void stays void (row % is refused).', OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "issued_documents_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "issued_documents_guard"
	BEFORE UPDATE OR DELETE ON "issued_documents"
	FOR EACH ROW EXECUTE FUNCTION "issued_documents_guard"();
--> statement-breakpoint
ALTER TABLE "issued_documents" ENABLE ALWAYS TRIGGER "issued_documents_guard";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "issued_document_versions_sequence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_voided timestamptz;
	v_last integer;
BEGIN
	-- The document row is locked so a revision and a void cannot cross, and two revisions queue.
	SELECT d."voided_at" INTO v_voided FROM "issued_documents" d WHERE d."id" = NEW.issued_document_id FOR UPDATE;
	SELECT COALESCE(MAX(v."version_no"), 0) INTO v_last FROM "issued_document_versions" v WHERE v."issued_document_id" = NEW.issued_document_id;
	IF NEW.version_no <> v_last + 1 THEN
		RAISE EXCEPTION 'The next version of this document is %, not %.', v_last + 1, NEW.version_no USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.version_no > 1 AND v_voided IS NOT NULL THEN
		RAISE EXCEPTION 'A void document cannot be revised.' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "issued_document_versions_sequence"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "issued_document_versions_sequence"
	BEFORE INSERT ON "issued_document_versions"
	FOR EACH ROW EXECUTE FUNCTION "issued_document_versions_sequence"();
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ENABLE ALWAYS TRIGGER "issued_document_versions_sequence";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "issued_document_signatures_current_version"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_doc uuid;
	v_no integer;
	v_last integer;
	v_voided timestamptz;
BEGIN
	SELECT v."issued_document_id", v."version_no" INTO v_doc, v_no FROM "issued_document_versions" v WHERE v."id" = NEW.issued_document_version_id;
	SELECT d."voided_at" INTO v_voided FROM "issued_documents" d WHERE d."id" = v_doc FOR SHARE;
	SELECT MAX(v."version_no") INTO v_last FROM "issued_document_versions" v WHERE v."issued_document_id" = v_doc;
	IF v_no IS DISTINCT FROM v_last THEN
		RAISE EXCEPTION 'Only the current version of a document can be signed.' USING ERRCODE = 'check_violation';
	END IF;
	IF v_voided IS NOT NULL THEN
		RAISE EXCEPTION 'A void document cannot be signed.' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "issued_document_signatures_current_version"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "issued_document_signatures_current_version"
	BEFORE INSERT ON "issued_document_signatures"
	FOR EACH ROW EXECUTE FUNCTION "issued_document_signatures_current_version"();
--> statement-breakpoint
ALTER TABLE "issued_document_signatures" ENABLE ALWAYS TRIGGER "issued_document_signatures_current_version";
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "document_template_versions" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "document_template_versions" TO "shareat_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "issued_document_versions" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "issued_document_versions" TO "shareat_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "issued_document_signatures" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "issued_document_signatures" TO "shareat_app";
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "document_templates" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "document_templates" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("name", "kind", "retired_at") ON "document_templates" TO "shareat_app";
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON "issued_documents" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "issued_documents" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("voided_at", "voided_by", "void_reason") ON "issued_documents" TO "shareat_app";
--> statement-breakpoint
-- T-398 S6 pin: the capability list inside log_break_glass_approval must equal CAPABILITIES; T-584 adds manage_document_templates, issue_documents, view_documents. Body identical to 0240 otherwise (grants survive CREATE OR REPLACE). Whichever migration that re-creates this function merges LAST must list EVERY capability: re-copy the list, do not just keep this file's.
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
		'upload_settlement_files', 'edit_platform_store_code', 'edit_loan_repayment_amount', 'pair_menu_dayparts',
		'request_pos_refill', 'serve_pos_ticket', 'confirm_pos_heads',
		'manage_business_rules',
		'manage_document_templates', 'issue_documents', 'view_documents'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
