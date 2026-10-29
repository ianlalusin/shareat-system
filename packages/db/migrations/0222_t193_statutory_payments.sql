-- T-193 S1 (statutory remittance): the schema for paying SSS, PhilHealth, Pag-IBIG and BIR what payroll credited to
-- 2210-2240 (postPayRun). Owed is DERIVED from posted payslips; payments are STORED here, one row per agency per month,
-- split per store in statutory_payment_lines. Docs: docs/tasks/193-statutory-remittance/REFRESH.md s3.
-- Adds: statutory_employers (employer numbers + due day), statutory_payments, statutory_payment_lines (all FORCE RLS with
-- WITH CHECK, same-org FKs incl. journal_entry_id, narrow per-column UPDATE grants), the history guard (ENABLE ALWAYS) on
-- payments, the line-freeze validator (origin) on lines, and account 6810 Penalties and surcharges for every existing org.
-- Trigger classes: statutory_payments_history_guard = always / history_guard; statutory_payment_lines_parent_open_trg = origin / validator.
-- Journal head when written: 0219 (0220 and 0221 are in open PRs; the journal jumps 0219 -> 0222 on this branch).
-- Hand-authored (ADR-012 s5).
CREATE TABLE "statutory_employers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"agency" text NOT NULL,
	"employer_no" text,
	"due_day" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	CONSTRAINT "statutory_employers_agency_check" CHECK ("agency" IN ('sss', 'philhealth', 'pagibig', 'bir')),
	CONSTRAINT "statutory_employers_employer_no_check" CHECK (("agency" = 'bir') = ("employer_no" IS NULL) AND ("employer_no" IS NULL OR "employer_no" ~ '^[0-9]+$')),
	CONSTRAINT "statutory_employers_due_day_check" CHECK ("due_day" BETWEEN 1 AND 31),
	CONSTRAINT "statutory_employers_updated_pair_check" CHECK (("updated_by" IS NULL) = ("updated_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_employers" ADD CONSTRAINT "statutory_employers_updated_by_same_org_fk" FOREIGN KEY ("org_id", "updated_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_employers_org_agency_unique" ON "statutory_employers" ("org_id", "agency");
--> statement-breakpoint
CREATE TABLE "statutory_payments" (
	"id" uuid PRIMARY KEY NOT NULL,                       -- the form-minted paymentId (C2); no default on purpose
	"org_id" uuid NOT NULL,
	"agency" text NOT NULL,
	"month" date NOT NULL,
	"paid_on" date NOT NULL,
	"money_account_id" uuid NOT NULL,
	"reference_no" text NOT NULL,
	"penalty" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"journal_entry_id" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statutory_payments_agency_check" CHECK ("agency" IN ('sss', 'philhealth', 'pagibig', 'bir')),
	CONSTRAINT "statutory_payments_month_first_check" CHECK (extract(day FROM "month") = 1),
	CONSTRAINT "statutory_payments_paid_on_check" CHECK ("paid_on" >= "month"),
	CONSTRAINT "statutory_payments_reference_no_check" CHECK ("reference_no" = btrim("reference_no") AND "reference_no" <> ''),
	CONSTRAINT "statutory_payments_penalty_check" CHECK ("penalty" >= 0),
	CONSTRAINT "statutory_payments_penalty_finite_check" CHECK ("penalty" > '-Infinity'::numeric AND "penalty" < 'Infinity'::numeric),
	CONSTRAINT "statutory_payments_status_check" CHECK (
		("status" = 'posted' AND "void_reason" IS NULL AND "voided_by" IS NULL AND "voided_at" IS NULL)
		OR ("status" = 'voided' AND "void_reason" IS NOT NULL AND btrim("void_reason") <> '' AND "voided_by" IS NOT NULL AND "voided_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_money_account_id_money_accounts_id_fk" FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_money_account_id_same_org_fk" FOREIGN KEY ("org_id", "money_account_id") REFERENCES "public"."money_accounts"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "public"."journal_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payments" ADD CONSTRAINT "statutory_payments_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_payments_posted_reference_unique" ON "statutory_payments" ("org_id", "agency", "reference_no") WHERE "status" = 'posted';
--> statement-breakpoint
CREATE INDEX "statutory_payments_org_agency_month_idx" ON "statutory_payments" ("org_id", "agency", "month");
--> statement-breakpoint
CREATE TABLE "statutory_payment_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statutory_payment_lines_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "statutory_payment_lines_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_payment_id_statutory_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."statutory_payments"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_payment_id_same_org_fk" FOREIGN KEY ("org_id", "payment_id") REFERENCES "public"."statutory_payments"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "statutory_payment_lines" ADD CONSTRAINT "statutory_payment_lines_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_payment_lines_payment_store_unique" ON "statutory_payment_lines" ("payment_id", "store_id");
--> statement-breakpoint
CREATE INDEX "statutory_payment_lines_org_store_idx" ON "statutory_payment_lines" ("org_id", "store_id");
--> statement-breakpoint
-- RLS: ENABLE + FORCE + one org_isolation policy each, the 0206 statutory_rates shape.
ALTER TABLE "statutory_employers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "statutory_employers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "statutory_employers_org_isolation" ON "statutory_employers" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "statutory_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "statutory_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "statutory_payments_org_isolation" ON "statutory_payments" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "statutory_payment_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "statutory_payment_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "statutory_payment_lines_org_isolation" ON "statutory_payment_lines" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
-- Grants (ADR-012 s5 4a): born SELECT + INSERT; only the void columns and the one-time entry link are updatable.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "statutory_employers", "statutory_payments", "statutory_payment_lines" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "statutory_employers", "statutory_payments", "statutory_payment_lines" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("journal_entry_id", "status", "void_reason", "voided_by", "voided_at") ON "statutory_payments" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("employer_no", "due_day", "updated_by", "updated_at") ON "statutory_employers" TO "shareat_app";
--> statement-breakpoint
-- History guard (history_guard / ENABLE ALWAYS): decides only from OLD and NEW of the same row.
CREATE FUNCTION "statutory_payments_guard_history"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'statutory payment % cannot be deleted', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	IF OLD.status = 'voided' THEN
		RAISE EXCEPTION 'voided statutory payment % is final', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	IF NEW.status NOT IN ('posted', 'voided') THEN
		RAISE EXCEPTION 'statutory payment % may only stay posted or become voided', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	IF OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
		RAISE EXCEPTION 'statutory payment % keeps its journal entry once set', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	IF (to_jsonb(NEW) - 'journal_entry_id' - 'status' - 'void_reason' - 'voided_by' - 'voided_at')
	   IS DISTINCT FROM (to_jsonb(OLD) - 'journal_entry_id' - 'status' - 'void_reason' - 'voided_by' - 'voided_at') THEN
		RAISE EXCEPTION 'statutory payment % is immutable except its void and its one journal link', OLD.id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payments_history_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "statutory_payments_guard_history"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "statutory_payments_history_guard" BEFORE UPDATE OR DELETE ON "statutory_payments"
	FOR EACH ROW EXECUTE FUNCTION "statutory_payments_guard_history"();
--> statement-breakpoint
ALTER TABLE "statutory_payments" ENABLE ALWAYS TRIGGER "statutory_payments_history_guard";
--> statement-breakpoint
-- Line freeze (validator / origin, R1): reads the PARENT row's current state.
CREATE FUNCTION "statutory_payment_lines_check_parent_open"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE p record;
BEGIN
	SELECT journal_entry_id, status INTO p FROM statutory_payments WHERE id = NEW.payment_id AND org_id = NEW.org_id;
	IF p.journal_entry_id IS NOT NULL OR p.status <> 'posted' THEN
		RAISE EXCEPTION 'statutory payment % is already posted or voided; its lines are final', NEW.payment_id
			USING ERRCODE = 'check_violation', CONSTRAINT = 'statutory_payment_lines_parent_open';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "statutory_payment_lines_check_parent_open"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "statutory_payment_lines_parent_open_trg" BEFORE INSERT ON "statutory_payment_lines"
	FOR EACH ROW EXECUTE FUNCTION "statutory_payment_lines_check_parent_open"();
--> statement-breakpoint
-- 6810 Penalties and surcharges (bible row 365 Q3) for every existing org; the 0065 shape.
INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '6810', 'Penalties and surcharges', 'expense', 'debit', h.id, true, true, false, 'active'
FROM "accounts" h
WHERE h.code = '6000'
  AND NOT EXISTS (SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '6810');
--> statement-breakpoint
-- T-398 S6 pin: the capability list inside log_break_glass_approval must equal CAPABILITIES; T-193 added remit_statutory. Body identical to 0220 otherwise (grants survive CREATE OR REPLACE).
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
		'view_franchise_sales', 'view_franchise_access_log'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
