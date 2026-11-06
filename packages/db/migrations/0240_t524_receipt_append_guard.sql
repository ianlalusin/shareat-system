-- 0240 -- T-524: the sales-receipt append guard (R11) and the break-glass capability list. docs/tasks/524-pos-v2-domain.md R11, R2.
-- Hand-authored per ADR-012 s5. Journal head when written: 0238; `when` is on the one-day grid (0239 is T-511 S5c).
--
-- WHY. T-523 froze a sales receipt and its children against UPDATE and DELETE, but an INSERT of one more payment, line or line discount under
-- YESTERDAY'S receipt was still accepted. A sale is written once, by completeSale, in ONE transaction (parent first, then its children).
-- These three BEFORE INSERT triggers refuse (23001 restrict_violation) a child whose parent receipt row was NOT written by the current
-- transaction. The test is the parent's `xmin` against `pg_current_xact_id()::xid`: a receipt written in this transaction carries this
-- transaction's id, a receipt of any earlier transaction does not. (A discount's parent is its receipt LINE; the receipt is that line's receipt.)
-- A child whose parent does not exist at all is left to the foreign key. Caveat: a write made inside a SAVEPOINT carries the sub-transaction's
-- id, so completeSale must run in the top-level transaction (it does; the POS routes do not nest it).
--
-- All three are history guards (ENABLE ALWAYS, triggers/registry.ts), SET search_path = public, pg_temp, EXECUTE revoked from PUBLIC.
--
-- ALSO (audit F1, planner ruling 6 Nov): table_session_lines gains `bundle_heads smallint NULL CHECK (1..200)`: the heads a "(up to N)" bundle line covers,
-- written from the menu at order time, so no code has to read it back out of the line's NAME. NULL for every other line. The existing
-- table_session_lines_guard trigger already freezes every column but the three kitchen ones (it compares to_jsonb(NEW) minus those three), so the new
-- column is frozen from birth; the UPDATE grant is column-listed and is NOT widened. Nullable ADD COLUMN: no table rewrite.
--
-- ALSO (BOSS, 6 Nov): the position defaults for the three new capabilities are seeded through the existing position access-defaults rows (bible row 211,
-- the mechanism behind /admin/access-defaults), per organisation, idempotent, the block between the B0240 markers (tested by t524-position-defaults):
--   Cashier -> request_pos_refill, serve_pos_ticket, confirm_pos_heads;  Kitchen Staff -> serve_pos_ticket;  Server -> request_pos_refill, confirm_pos_heads.
--   ("Kitchen" in the ruling is the canonical position "Kitchen Staff". "Store manager" is not a position: a manager holds all three BY ROLE in the matrix.)
-- It writes one position_capability_defaults row per (canonical position x store of the same org) and the matching store-pinned person_grants for every open
-- employment holding that position (0152's steps 3 and 4). An organisation whose attribution person is not exactly one active super_admin (else exactly
-- one admin) gets no rows and the migration does not refuse (0152 refused; this block must never halt a deploy).
--
-- ALSO: T-524 adds three capabilities (request_pos_refill, serve_pos_ticket, confirm_pos_heads), and the T-398 S6 pin says the capability
-- list inside log_break_glass_approval must equal CAPABILITIES, so it is re-created below (CREATE OR REPLACE; grants survive).
-- NB for a rebase onto main: 0239 (T-511 S5c) adds manage_business_rules to that list; the array here must then carry it too.
ALTER TABLE "table_session_lines" ADD COLUMN "bundle_heads" smallint;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_bundle_heads_check" CHECK ("bundle_heads" BETWEEN 1 AND 200);
--> statement-breakpoint
CREATE FUNCTION "pos_sales_receipt_child_insert_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	rid uuid;
	parent_xmin xid;
	found_parent boolean;
BEGIN
	IF TG_TABLE_NAME = 'pos_sales_receipt_line_discounts' THEN
		SELECT l."receipt_id" INTO rid FROM "pos_sales_receipt_lines" l WHERE l."id" = NEW."receipt_line_id";
	ELSE
		rid := NEW."receipt_id";
	END IF;
	SELECT r."xmin", true INTO parent_xmin, found_parent FROM "pos_sales_receipts" r WHERE r."id" = rid;
	IF found_parent AND parent_xmin IS DISTINCT FROM pg_current_xact_id()::xid THEN
		RAISE EXCEPTION 'A sales receipt is written once: nothing may be added to receipt % after it was recorded (% refused).', rid, TG_TABLE_NAME
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_sales_receipt_child_insert_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipt_lines_append_guard" BEFORE INSERT ON "pos_sales_receipt_lines" FOR EACH ROW EXECUTE FUNCTION "pos_sales_receipt_child_insert_guard"();
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipt_payments_append_guard" BEFORE INSERT ON "pos_sales_receipt_payments" FOR EACH ROW EXECUTE FUNCTION "pos_sales_receipt_child_insert_guard"();
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipt_line_discounts_append_guard" BEFORE INSERT ON "pos_sales_receipt_line_discounts" FOR EACH ROW EXECUTE FUNCTION "pos_sales_receipt_child_insert_guard"();
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ENABLE ALWAYS TRIGGER "pos_sales_receipt_lines_append_guard";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ENABLE ALWAYS TRIGGER "pos_sales_receipt_payments_append_guard";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ENABLE ALWAYS TRIGGER "pos_sales_receipt_line_discounts_append_guard";
--> statement-breakpoint
-- B0240:begin
SET LOCAL row_security = off;
--> statement-breakpoint
WITH org_attribution AS (
	SELECT
		o."id" AS org_id,
		COALESCE(
			(SELECT pr."person_id" FROM "person_roles" pr
			 WHERE pr."org_id" = o."id" AND pr."role" = 'super_admin' AND pr."revoked_at" IS NULL
			 AND (SELECT count(*) FROM "person_roles" x WHERE x."org_id" = o."id" AND x."role" = 'super_admin' AND x."revoked_at" IS NULL) = 1),
			(SELECT pr."person_id" FROM "person_roles" pr
			 WHERE pr."org_id" = o."id" AND pr."role" = 'admin' AND pr."revoked_at" IS NULL
			 AND (SELECT count(*) FROM "person_roles" x WHERE x."org_id" = o."id" AND x."role" = 'super_admin' AND x."revoked_at" IS NULL) = 0
			 AND (SELECT count(*) FROM "person_roles" x WHERE x."org_id" = o."id" AND x."role" = 'admin' AND x."revoked_at" IS NULL) = 1)
		) AS set_by
	FROM "organizations" o
)
INSERT INTO "position_capability_defaults" ("org_id", "position_id", "store_id", "capability", "set_by")
SELECT s."org_id", p."id", s."id", d."capability", oa."set_by"
  FROM "stores" s
  JOIN "positions" p ON p."org_id" = s."org_id" AND p."store_id" IS NULL AND p."is_active" = true
  JOIN (VALUES
	('Cashier', 'request_pos_refill'), ('Cashier', 'serve_pos_ticket'), ('Cashier', 'confirm_pos_heads'),
	('Kitchen Staff', 'serve_pos_ticket'),
	('Server', 'request_pos_refill'), ('Server', 'confirm_pos_heads')
  ) AS d("position_name", "capability") ON d."position_name" = p."name"
  JOIN org_attribution oa ON oa."org_id" = s."org_id" AND oa."set_by" IS NOT NULL
ON CONFLICT ("position_id", "store_id", "capability") WHERE "revoked_at" IS NULL DO NOTHING;
--> statement-breakpoint
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source", "source_ref", "store_id")
SELECT DISTINCT ON (e."person_id", d."capability", e."store_id")
	e."person_id", d."capability", d."set_by", 'position', d."id", e."store_id"
  FROM "employments" e
  JOIN "employment_positions" ep ON ep."employment_id" = e."id"
  JOIN "positions" p ON p."id" = ep."position_id" AND p."is_active" = true
  JOIN "position_capability_defaults" d ON d."position_id" = p."id" AND d."store_id" = e."store_id" AND d."revoked_at" IS NULL
 WHERE e."ended_on" IS NULL AND d."capability" IN ('request_pos_refill', 'serve_pos_ticket', 'confirm_pos_heads')
 ORDER BY e."person_id", d."capability", e."store_id", d."set_at"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
SET LOCAL row_security = on;
-- B0240:end
--> statement-breakpoint
-- T-398 S6 pin: the capability list inside log_break_glass_approval must equal CAPABILITIES; T-524 adds request_pos_refill, serve_pos_ticket, confirm_pos_heads. Body identical to 0234 otherwise (grants survive CREATE OR REPLACE).
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
		'manage_business_rules'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
