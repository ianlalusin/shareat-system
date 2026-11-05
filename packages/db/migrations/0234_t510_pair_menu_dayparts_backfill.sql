-- 0234 -- T-510 S2: the owner BACKFILL for `pair_menu_dayparts` (and a CREATE OR REPLACE of log_break_glass_approval so its capability list gains it, T-398 S6 pin), the eighth super-admin-only capability (docs/tasks/510-menu-dayparts.md R8; Ian 2026-11-05: which offer
-- belongs to which daypart, or all day, is super admin only). No schema change: SUPER_ADMIN_ONLY_CAPABILITIES is materialised as `person_grants` once, at createFirstAdmin
-- (new organisations get the new grant by themselves), so an organisation created before today holds seven and would silently lose "super admin may pair a price with a
-- daypart" the day the capability lands. Same shape and reasoning as the B0196 block in 0196 (add_menu_item), 0188 and 0187: every existing OWNER (an active admin holding all
-- SEVEN current super-admin-only grants) is granted the eighth. An admin who is not an owner is untouched. Idempotent: a person who already holds it live is skipped.
-- Test: packages/db/tests/integration/t510-s2-pair-backfill.test.ts runs the block between the B0234 markers in a transaction that is always rolled back.
-- LOCK BUDGET: one INSERT ... SELECT on person_grants (a handful of owners). RLS is switched off for the statement as 0196 did (a migration reads every organisation) and back on after.
-- B0234:begin
SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source")
SELECT g."person_id", 'pair_menu_dayparts', NULL, 'owner'
  FROM "person_grants" g
 WHERE g."revoked_at" IS NULL
   AND g."grant_name" IN ('approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales', 'unlink_store_from_pos', 'verify_own_sales_day', 'add_menu_item')
   AND EXISTS (SELECT 1 FROM "person_roles" r
                WHERE r."person_id" = g."person_id" AND r."role" = 'admin' AND r."revoked_at" IS NULL)
   AND NOT EXISTS (SELECT 1 FROM "person_grants" u
                    WHERE u."person_id" = g."person_id" AND u."grant_name" = 'pair_menu_dayparts'
                      AND u."revoked_at" IS NULL AND u."store_id" IS NULL)
 GROUP BY g."person_id"
HAVING count(DISTINCT g."grant_name") = 7;
--> statement-breakpoint
SET LOCAL row_security = on;
-- B0234:end
--> statement-breakpoint
-- T-398 S6 pin: the capability list inside log_break_glass_approval must equal CAPABILITIES; T-510 S2 adds pair_menu_dayparts. Body identical to 0228 otherwise (grants survive CREATE OR REPLACE).
-- OUTSIDE the B0234 block on purpose: the backfill test runs only the block above.
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
		'upload_settlement_files', 'edit_platform_store_code', 'edit_loan_repayment_amount', 'pair_menu_dayparts'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
