-- 0239 - T-512 (T-511 S5c): the business rules an admin may change, as dated append-only rows.
-- docs/tasks/512-business-rules-s5c-spec.md "Table"; hand-authored per ADR-012 s5. Journal idx 237 (0235 was reserved, 0236 is already on main,
-- and the journal test needs idx to increase in array order).
--
-- WHY. Ian's standing rule (5 Nov): no business setting in the ERP may be hard-coded; each needs a screen. The settlement variance
-- floor and percent, the loan final tolerance, the withholding rate and the VAT percent were literals in code. This table holds their
-- numbers, one row per change, so a change is dated, explained and never overwritten. The closed list of keys lives in code
-- (packages/domain/src/business-rules/registry.ts); the table is generic so a later rule is a registry entry, not a migration.
--
-- SHAPE. The rule in force on a date is the row with the greatest (effective_from, created_at, id) among rows whose effective_from <= date.
-- No unique index: a same-day correction is a newer row. No effective_to: one fact, nothing to close (precedent pay_rates, 0105 and 0221).
--
-- THE LOCKS (the 0221 pattern; no layer is the only lock). A row is never rewritten or removed:
--   1. RLS ENABLE and FORCE, policy business_rule_values_org_isolation through app_current_org().
--   2. Trigger business_rule_values_append_only, BEFORE UPDATE OR DELETE FOR EACH ROW, refuses with SQLSTATE 23001 (restrict_violation);
--      ENABLE ALWAYS so it still fires under session_replication_role = replica.
--   3. The app role gets SELECT and INSERT only (UPDATE, DELETE, TRUNCATE revoked): a loud 42501 before RLS.
-- The app never updates or deletes a row: packages/db/src/repo/business-rules.ts only inserts and selects.
--
-- CHECKS. Every rule is a non-negative number with at most two decimals (money is exact in centavos, a percent exact in basis points), so the
-- table itself refuses -5 or 0.125 even if some later code path skips the writer. The per-key bounds stay in the registry.
--
-- SEED. One row per existing org per key, effective 2000-01-01, set_by NULL, so today's behaviour is unchanged on the day this lands.
-- Written BEFORE RLS is switched on so the owner role (FORCE RLS applies to it) can insert without a principal. A new org has no rows;
-- the reader falls back to the registry default. A test pins that these values equal the registry defaults.
--
-- It also re-creates log_break_glass_approval with the new capability in its list (the t511-s2 test pins that list to CAPABILITIES). Every statement is its own breakpoint, except the last.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE "business_rule_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" numeric(18,6) NOT NULL,
	"effective_from" date NOT NULL,
	"set_by" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_rule_values_reason_check" CHECK (length(trim("reason")) > 0),
	CONSTRAINT "business_rule_values_value_finite_check" CHECK ("value" > '-Infinity'::numeric AND "value" < 'Infinity'::numeric),
	CONSTRAINT "business_rule_values_value_nonneg_check" CHECK ("value" >= 0),
	CONSTRAINT "business_rule_values_value_two_decimals_check" CHECK ("value" = round("value", 2))
);
--> statement-breakpoint
ALTER TABLE "business_rule_values" ADD CONSTRAINT "business_rule_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_rule_values" ADD CONSTRAINT "business_rule_values_set_by_same_org_fk" FOREIGN KEY ("org_id", "set_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "business_rule_values_org_key_from_idx" ON "business_rule_values" ("org_id", "key", "effective_from");
--> statement-breakpoint

-- Seed: one starting row per existing org per key (values equal the registry defaults; see the header).
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", r."key", r."value", DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o
CROSS JOIN (VALUES
	('settlement.variance_floor_amount', 50.00::numeric),
	('settlement.variance_percent', 10::numeric),
	('settlement.loan_final_tolerance', 0.01::numeric),
	('tax.withholding_rate_percent', 0.5::numeric),
	('tax.vat_percent', 12::numeric)
) AS r("key", "value");
--> statement-breakpoint

ALTER TABLE "business_rule_values" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "business_rule_values" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "business_rule_values_org_isolation" ON "business_rule_values" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "business_rule_values_refuse_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A business rule row is never changed or removed (% on row % is refused). Enter a new value with an effective date instead.',
		TG_OP, COALESCE(OLD.id::text, '?')
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "business_rule_values_refuse_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "business_rule_values_append_only"
	BEFORE UPDATE OR DELETE ON "business_rule_values"
	FOR EACH ROW EXECUTE FUNCTION "business_rule_values_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "business_rule_values" ENABLE ALWAYS TRIGGER "business_rule_values_append_only";
--> statement-breakpoint

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "business_rule_values" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "business_rule_values" TO "shareat_app";
--> statement-breakpoint

-- T-398 S6 pin: the capability list inside log_break_glass_approval must equal CAPABILITIES. This slice adds manage_business_rules. Body identical to 0228 otherwise
-- (grants survive CREATE OR REPLACE). Whichever migration that re-creates this function merges LAST must list EVERY capability: re-copy the list, do not just keep this file's.
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
		'upload_settlement_files', 'edit_platform_store_code', 'edit_loan_repayment_amount',
		'pair_menu_dayparts', 'manage_business_rules'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
