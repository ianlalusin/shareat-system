-- 0284 - T-640: the AI hub. docs/tasks/640-ai-hub.md; hand-authored per ADR-012 s5.
-- Journal idx 284: 0282 and 0283 are reserved by other branches (the journal test allows a gap); "when" = 0281's + 86400000 x 3 (one day per index).
--
-- WHAT IT ADDS
--   ai_provider_keys   one row per organisation and provider: the key ENCRYPTED (AES-256-GCM, master key from the server env, never here) and its last 4 characters. KEEP.
--   ai_models          a model from the list in code + the result of its last Test call. Active only after a test passed (CHECK); active exactly when it has a priority (CHECK). KEEP.
--   ai_settings        one row per organisation: on/off, monthly cap in pesos (default 1000), daily questions per person (30), peso rate (58.00), warning percent (80). KEEP. No seed: no row means the defaults in code.
--   ai_store_switches  a store switched off (or back on) for AI features. No row means on. KEEP.
--   ai_calls           APPEND-ONLY log of every model call attempt: prompt SHA-256 (never the text), tokens, cost in micro-pesos (a whole number: no numeric column), latency, tool calls, ok / error code. PURGE (pilot activity).
--   capability manage_ai_hub: super admin only (the ninth). Owner BACKFILL below, and log_break_glass_approval re-created with the capability list (T-398 S6 pin).
--
-- NO SECRET IS EVER STORED IN CLEAR: key_envelope holds v1.<iv>.<tag>.<ciphertext>; the master key lives only in /srv/shareat-shared/.env.local. No trigger: ai_calls is append-only by GRANT (SELECT, INSERT only; no UPDATE, no DELETE).
-- GRANTS (ADR-012 s5 4a): ai_provider_keys UPDATE (key_envelope, key_last4, set_by, updated_at) + DELETE (a key can be removed); ai_models UPDATE (test and activation columns) + DELETE (removed with their key);
-- ai_settings and ai_store_switches UPDATE (their value columns). RLS ENABLE + FORCE and one org_isolation policy through app_current_org() on every table. LOCK BUDGET: lock_timeout 5s first; five new tables and one
-- INSERT ... SELECT into person_grants (a handful of owners). Nothing existing is altered.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "ai_provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"key_envelope" text NOT NULL,
	"key_last4" text NOT NULL,
	"set_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ai_provider_keys_org_provider_unique" UNIQUE ("org_id", "provider"),
	CONSTRAINT "ai_provider_keys_provider_check" CHECK ("provider" IN ('anthropic', 'google', 'openai')),
	CONSTRAINT "ai_provider_keys_last4_check" CHECK (char_length("key_last4") = 4),
	CONSTRAINT "ai_provider_keys_envelope_check" CHECK ("key_envelope" LIKE 'v1.%' AND char_length("key_envelope") BETWEEN 20 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "ai_models" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tool_calling" boolean,
	"passed_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_at" timestamp with time zone,
	"last_test_latency_ms" integer,
	"last_test_note" text,
	"active" boolean DEFAULT false NOT NULL,
	"priority" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ai_models_org_provider_model_unique" UNIQUE ("org_id", "provider", "model"),
	CONSTRAINT "ai_models_model_check" CHECK (char_length("model") BETWEEN 1 AND 80),
	CONSTRAINT "ai_models_active_needs_passed_test_check" CHECK (NOT "active" OR "passed_at" IS NOT NULL),
	CONSTRAINT "ai_models_priority_iff_active_check" CHECK (("active" AND "priority" IS NOT NULL AND "priority" >= 1) OR (NOT "active" AND "priority" IS NULL)),
	CONSTRAINT "ai_models_note_check" CHECK ("last_test_note" IS NULL OR char_length("last_test_note") <= 300),
	CONSTRAINT "ai_models_latency_check" CHECK ("last_test_latency_ms" IS NULL OR "last_test_latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"monthly_cap_pesos" integer DEFAULT 1000 NOT NULL,
	"daily_limit_per_person" integer DEFAULT 30 NOT NULL,
	"pesos_per_usd_hundredths" integer DEFAULT 5800 NOT NULL,
	"warn_at_percent" integer DEFAULT 80 NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" uuid,
	CONSTRAINT "ai_settings_org_unique" UNIQUE ("org_id"),
	CONSTRAINT "ai_settings_cap_check" CHECK ("monthly_cap_pesos" BETWEEN 0 AND 1000000),
	CONSTRAINT "ai_settings_daily_check" CHECK ("daily_limit_per_person" BETWEEN 0 AND 10000),
	CONSTRAINT "ai_settings_rate_check" CHECK ("pesos_per_usd_hundredths" BETWEEN 1000 AND 30000),
	CONSTRAINT "ai_settings_warn_check" CHECK ("warn_at_percent" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "ai_store_switches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" uuid,
	CONSTRAINT "ai_store_switches_store_unique" UNIQUE ("store_id")
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid,
	"person_id" uuid,
	"feature" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_micro_php" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"prompt_sha256" text NOT NULL,
	"group_ref" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_calls_provider_check" CHECK ("provider" IN ('anthropic', 'google', 'openai')),
	CONSTRAINT "ai_calls_feature_check" CHECK ("feature" ~ '^[a-z][a-z0-9_.]{0,59}$'),
	CONSTRAINT "ai_calls_sha256_check" CHECK ("prompt_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_calls_counts_check" CHECK ("tokens_in" >= 0 AND "tokens_out" >= 0 AND "cost_micro_php" >= 0 AND "latency_ms" >= 0 AND "tool_calls" >= 0),
	CONSTRAINT "ai_calls_ok_error_check" CHECK (("ok" AND "error_code" IS NULL) OR (NOT "ok" AND "error_code" IS NOT NULL AND char_length("error_code") <= 60))
);
--> statement-breakpoint
ALTER TABLE "ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_set_by_persons_id_fk" FOREIGN KEY ("set_by") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_set_by_same_org_fk" FOREIGN KEY ("org_id", "set_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider_key_fk" FOREIGN KEY ("org_id", "provider") REFERENCES "ai_provider_keys" ("org_id", "provider") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updated_by_same_org_fk" FOREIGN KEY ("org_id", "updated_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_store_switches" ADD CONSTRAINT "ai_store_switches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_store_switches" ADD CONSTRAINT "ai_store_switches_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_store_switches" ADD CONSTRAINT "ai_store_switches_updated_by_persons_id_fk" FOREIGN KEY ("updated_by") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_store_switches" ADD CONSTRAINT "ai_store_switches_store_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_store_switches" ADD CONSTRAINT "ai_store_switches_updated_by_same_org_fk" FOREIGN KEY ("org_id", "updated_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "persons" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_store_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_person_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "ai_models_org_active_idx" ON "ai_models" ("org_id", "active", "priority");
--> statement-breakpoint
CREATE INDEX "ai_calls_org_created_idx" ON "ai_calls" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX "ai_calls_org_person_created_idx" ON "ai_calls" ("org_id", "person_id", "created_at");
--> statement-breakpoint
ALTER TABLE "ai_provider_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_provider_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_provider_keys_org_isolation" ON "ai_provider_keys" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "ai_models" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_models" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_models_org_isolation" ON "ai_models" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "ai_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_settings_org_isolation" ON "ai_settings" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "ai_store_switches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_store_switches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_store_switches_org_isolation" ON "ai_store_switches" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_calls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ai_calls_org_isolation" ON "ai_calls" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
GRANT UPDATE ("key_envelope", "key_last4", "set_by", "updated_at") ON "ai_provider_keys" TO "shareat_app";
--> statement-breakpoint
GRANT DELETE ON "ai_provider_keys" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("tool_calling", "passed_at", "last_test_ok", "last_test_at", "last_test_latency_ms", "last_test_note", "active", "priority", "updated_at") ON "ai_models" TO "shareat_app";
--> statement-breakpoint
GRANT DELETE ON "ai_models" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("enabled", "monthly_cap_pesos", "daily_limit_per_person", "pesos_per_usd_hundredths", "warn_at_percent", "updated_at", "updated_by") ON "ai_settings" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("enabled", "updated_at", "updated_by") ON "ai_store_switches" TO "shareat_app";
--> statement-breakpoint
-- The owner BACKFILL for manage_ai_hub, the ninth super-admin-only capability (same shape and reasoning as B0234 / B0196 / B0188 / B0187): SUPER_ADMIN_ONLY_CAPABILITIES is materialised as person_grants once,
-- at createFirstAdmin, so an organisation created before today holds eight. Every existing OWNER (an active admin holding all EIGHT current super-admin-only grants) is granted the ninth. An admin who is not an
-- owner is untouched. Idempotent: a person who already holds it live is skipped. Test: packages/db/tests/integration/t640-ai-hub-backfill.test.ts runs the block between the B0284 markers in a rolled-back transaction.
-- B0284:begin
SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source")
SELECT g."person_id", 'manage_ai_hub', NULL, 'owner'
  FROM "person_grants" g
 WHERE g."revoked_at" IS NULL
   AND g."grant_name" IN ('approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales', 'unlink_store_from_pos', 'verify_own_sales_day', 'add_menu_item', 'pair_menu_dayparts')
   AND EXISTS (SELECT 1 FROM "person_roles" r
                WHERE r."person_id" = g."person_id" AND r."role" = 'admin' AND r."revoked_at" IS NULL)
   AND NOT EXISTS (SELECT 1 FROM "person_grants" u
                    WHERE u."person_id" = g."person_id" AND u."grant_name" = 'manage_ai_hub'
                      AND u."revoked_at" IS NULL AND u."store_id" IS NULL)
 GROUP BY g."person_id"
HAVING count(DISTINCT g."grant_name") = 8;
--> statement-breakpoint
SET LOCAL row_security = on;
-- B0284:end
--> statement-breakpoint
-- T-398 S6 pin: the capability list inside log_break_glass_approval must equal CAPABILITIES; T-640 adds manage_ai_hub. Body identical to 0259 otherwise (grants survive CREATE OR REPLACE). OUTSIDE the B0284 block on purpose:
-- the backfill test runs only the block above. Whichever migration that re-creates this function merges LAST must list EVERY capability: re-copy the list, do not just keep this file's.
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
		'manage_document_templates', 'issue_documents', 'view_documents',
		'manage_ai_hub'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
