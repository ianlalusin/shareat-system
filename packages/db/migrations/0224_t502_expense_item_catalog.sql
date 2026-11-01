-- 0224 - T-502 S1 + S2: the expense item catalog (one list for everything bought).
-- docs/tasks/502-expense-item-catalog.md section 4 S1/S2 and section 10 rulings R1-R7, C; hand-authored per ADR-012 s5. Journal idx 224.
--
-- WHY. Ian, 31 Oct 2026: one item list for everything bought (food, supplies, SERVICES such as rent and power); each item has an
-- expense category so cost drivers show; two cashiers never file the same thing under different names (chili / sili / siling pula).
--
-- SHAPE.
--   items_kind_check, item_requests_kind_check   widened with 'service'.
--   service shape (items AND item_requests)       a service is base_unit 'pcs', purchasable, never sold (R6): three CHECKs each.
--   items.expense_category_id / item_requests.expense_category_id   nullable, same-org composite FK to expense_categories
--                                                 (target expense_categories_org_id_id_unique, 0213). Required at APPROVAL by the domain.
--   item_aliases                                  other names for an item. Unique (org_id, lower(trim(alias))). RLS + FORCE.
--                                                 SELECT, INSERT, DELETE for the app (an alias is added or removed, never edited).
--   item_aliases_name_guard / items_name_alias_guard   BOTH WAYS (R5): an alias may not equal an item name, and an item may not be
--                                                 created or renamed to a name an alias holds. Plain triggers (no SECURITY DEFINER): the
--                                                 lookups are same-org and the app role reads both tables. Serialised per org by an
--                                                 advisory lock so two concurrent inserts cannot both pass.
--   service_item_never_stocked                    (C): a service item is refused on stock_movements, delivery_lines, stock_usage_lines,
--                                                 production_recipe_lines (item_id) and production_recipes (output_item_id).
--   service_item_never_stocked, widened (audit A1-A3)  the same trigger on 17 more item_id tables (listed at its CREATE TRIGGERs).
--   items_service_not_variation_check / item_requests_service_not_variation_check   (audit A6) a service is never a variation.
--   log_break_glass_approval                      its capability list must equal CAPABILITIES (0220/0222 pin): + approve_item_request.
--
-- No existing row is read or changed: the new columns are NULL, no service item exists yet.

ALTER TABLE "items" DROP CONSTRAINT "items_kind_check";
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_kind_check" CHECK ("kind" in ('raw_material','supply','retail','meat_slab','meat_sliced','service'));
--> statement-breakpoint
ALTER TABLE "item_requests" DROP CONSTRAINT "item_requests_kind_check";
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_kind_check" CHECK ("kind" in ('raw_material','supply','retail','meat_slab','meat_sliced','service'));
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_service_unit_check" CHECK ("kind" <> 'service' OR "base_unit" = 'pcs');
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_service_never_sold_check" CHECK ("kind" <> 'service' OR (NOT "sellable_retail" AND NOT "sellable_wholesale"));
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_service_purchasable_check" CHECK ("kind" <> 'service' OR "is_purchasable");
--> statement-breakpoint
-- Audit ruling A6: a service is never a variation (a variation is a size/brand of a stocked thing). The parent side needs no rule of its
-- own: items_variant_guard (0210) makes a variation the same kind as its parent, so a service parent could only have service children.
ALTER TABLE "items" ADD CONSTRAINT "items_service_not_variation_check" CHECK ("kind" <> 'service' OR "variant_of_item_id" IS NULL);
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_service_unit_check" CHECK ("kind" <> 'service' OR "base_unit" = 'pcs');
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_service_never_sold_check" CHECK ("kind" <> 'service' OR (NOT "sellable_retail" AND NOT "sellable_wholesale"));
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_service_purchasable_check" CHECK ("kind" <> 'service' OR "is_purchasable");
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_service_not_variation_check" CHECK ("kind" <> 'service' OR "variant_of_item_id" IS NULL);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- the expense category on an item and on a request
ALTER TABLE "items" ADD COLUMN "expense_category_id" uuid;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_expense_category_same_org_fk" FOREIGN KEY ("org_id", "expense_category_id") REFERENCES "public"."expense_categories"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "items_expense_category_idx" ON "items" ("org_id", "expense_category_id") WHERE "expense_category_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD COLUMN "expense_category_id" uuid;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_expense_category_same_org_fk" FOREIGN KEY ("org_id", "expense_category_id") REFERENCES "public"."expense_categories"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- item_aliases
CREATE TABLE "item_aliases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_aliases_alias_not_blank_check" CHECK (length(trim("alias")) > 0)
);
--> statement-breakpoint
ALTER TABLE "item_aliases" ADD CONSTRAINT "item_aliases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_aliases" ADD CONSTRAINT "item_aliases_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "public"."items"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_aliases" ADD CONSTRAINT "item_aliases_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "item_aliases_org_alias_key" ON "item_aliases" ("org_id", lower(trim("alias")));
--> statement-breakpoint
CREATE INDEX "item_aliases_item_idx" ON "item_aliases" ("org_id", "item_id");
--> statement-breakpoint
ALTER TABLE "item_aliases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_aliases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "item_aliases_org_isolation" ON "item_aliases"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "item_aliases" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "item_aliases" TO "shareat_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- R5: an alias and an item name never collide, in either direction.
CREATE FUNCTION "item_aliases_check_name_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	clash RECORD;
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('item_name_space:' || NEW."org_id"::text, 0));
	SELECT i."name", i."code" INTO clash FROM "items" i
	WHERE i."org_id" = NEW."org_id" AND i."status" <> 'merged' AND lower(trim(i."name")) = lower(trim(NEW."alias")) LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION '"%" is already the name of the item % (%). An other-name cannot repeat an official name.', trim(NEW."alias"), clash."name", clash."code"
			USING ERRCODE = '23514', CONSTRAINT = 'item_aliases_name_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "item_aliases_name_guard" BEFORE INSERT OR UPDATE OF "alias", "item_id" ON "item_aliases"
	FOR EACH ROW EXECUTE FUNCTION "item_aliases_check_name_guard"();
--> statement-breakpoint
CREATE FUNCTION "items_check_name_alias_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	clash RECORD;
BEGIN
	PERFORM pg_advisory_xact_lock(hashtextextended('item_name_space:' || NEW."org_id"::text, 0));
	SELECT i."name", i."code" INTO clash FROM "item_aliases" a JOIN "items" i ON i."id" = a."item_id"
	WHERE a."org_id" = NEW."org_id" AND lower(trim(a."alias")) = lower(trim(NEW."name")) LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION '"%" is already another name for the item % (%). Use that item, or choose a different name.', trim(NEW."name"), clash."name", clash."code"
			USING ERRCODE = '23514', CONSTRAINT = 'items_name_alias_guard';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "items_name_alias_guard" BEFORE INSERT OR UPDATE OF "name" ON "items"
	FOR EACH ROW EXECUTE FUNCTION "items_check_name_alias_guard"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- C: a service item is never stocked, counted, costed by recipe or delivered.
-- F38: the guards lock the item row FOR SHARE so a concurrent kind UPDATE (row lock) serialises against them, and vice versa: the
-- history trigger below runs inside the UPDATE that holds the row lock, so a guard that already holds FOR SHARE blocks that UPDATE until it commits.
CREATE FUNCTION "items_refuse_service_item"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	item_kind text;
BEGIN
	SELECT i."kind" INTO item_kind FROM "items" i WHERE i."id" = NEW."item_id" FOR SHARE;
	IF item_kind = 'service' THEN
		RAISE EXCEPTION 'A service item (rent, power, water...) is never stocked, counted, delivered or used in a recipe.'
			USING ERRCODE = '23514', CONSTRAINT = 'service_item_never_stocked';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "items_refuse_service_recipe_output"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	item_kind text;
BEGIN
	SELECT i."kind" INTO item_kind FROM "items" i WHERE i."id" = NEW."output_item_id" FOR SHARE;
	IF item_kind = 'service' THEN
		RAISE EXCEPTION 'A service item (rent, power, water...) can never be the product of a recipe.'
			USING ERRCODE = '23514', CONSTRAINT = 'service_item_never_stocked';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "stock_movements_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "stock_movements"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "delivery_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "delivery_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "stock_usage_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "stock_usage_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "production_recipe_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "production_recipe_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "production_recipes_service_output_guard" BEFORE INSERT OR UPDATE OF "output_item_id" ON "production_recipes"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_recipe_output"();
--> statement-breakpoint

-- Audit rulings A1-A3 (section 13): the same refusal on every other table that carries stock, a count, a threshold or a selling claim
-- by item_id. Covered: count_lines, stock_transfer_lines, stock_reservations, trade_order_lines, supplier_return_lines, customer_return_lines, stock_layers, store_item_thresholds, opening_counts, store_item_sellability, production_record_lines, menu_depletion_rules, commissary_item_offerings, price_list_items, item_pricing, pos_item_maps, pos_usage_pull_lines.
-- Deliberately NOT covered (a service may legitimately appear there): supplier_invoice_lines (the one thing a service has),
-- supplier_items (what a supplier charges: a service is bought), item_aliases and item_duplicate_dismissals (names only),
-- commissary_item_map (maps two items that commissary_item_offerings already guards), menu_package_refills (refill_item_id is a menu item).
CREATE TRIGGER "count_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "count_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "stock_transfer_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "stock_transfer_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "stock_reservations_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "stock_reservations"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "trade_order_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "trade_order_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "supplier_return_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "supplier_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "customer_return_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "customer_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "stock_layers_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "stock_layers"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "store_item_thresholds_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "store_item_thresholds"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "opening_counts_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "opening_counts"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "store_item_sellability_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "store_item_sellability"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "production_record_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "production_record_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "menu_depletion_rules_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "menu_depletion_rules"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "commissary_item_offerings_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "commissary_item_offerings"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "price_list_items_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "price_list_items"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "item_pricing_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "item_pricing"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "pos_item_maps_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "pos_item_maps"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint
CREATE TRIGGER "pos_usage_pull_lines_service_item_guard" BEFORE INSERT OR UPDATE OF "item_id" ON "pos_usage_pull_lines"
	FOR EACH ROW EXECUTE FUNCTION "items_refuse_service_item"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Section 11 (Ian, 1 Nov): sub-categories, set on the ITEM (never typed by a cashier). A middle level that groups items for reports
-- (Meat -> Pork -> belly) without v1's free-text harm: names are an admin-managed list, vague names are refused, retire never delete.
--   expense_subcategories      unique (org_id, category_id, lower(trim(name))); same-org FKs; RLS + FORCE; SELECT, INSERT, UPDATE (no DELETE).
--   items / item_requests      .expense_subcategory_id nullable, same-org FK; trigger *_subcategory_matches_category refuses a sub-category
--                              whose category is not the row's expense_category_id.
CREATE TABLE "expense_subcategories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "expense_subcategories_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "expense_subcategories_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "expense_subcategories_name_not_vague_check" CHECK (lower(trim("name")) NOT IN ('please specify', 'specify', 'other', 'others'))
);
--> statement-breakpoint
ALTER TABLE "expense_subcategories" ADD CONSTRAINT "expense_subcategories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "expense_subcategories" ADD CONSTRAINT "expense_subcategories_category_same_org_fk" FOREIGN KEY ("org_id", "category_id") REFERENCES "public"."expense_categories"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "expense_subcategories" ADD CONSTRAINT "expense_subcategories_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "expense_subcategories_org_name_key" ON "expense_subcategories" ("org_id", "category_id", lower(trim("name")));
--> statement-breakpoint
ALTER TABLE "expense_subcategories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "expense_subcategories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "expense_subcategories_org_isolation" ON "expense_subcategories"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE TRUNCATE, REFERENCES, TRIGGER, DELETE ON "expense_subcategories" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "expense_subcategories" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "expense_subcategory_id" uuid;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_expense_subcategory_same_org_fk" FOREIGN KEY ("org_id", "expense_subcategory_id") REFERENCES "public"."expense_subcategories"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD COLUMN "expense_subcategory_id" uuid;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_expense_subcategory_same_org_fk" FOREIGN KEY ("org_id", "expense_subcategory_id") REFERENCES "public"."expense_subcategories"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "items_check_subcategory_matches_category"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."expense_subcategory_id" IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM "expense_subcategories" s
		WHERE s."id" = NEW."expense_subcategory_id" AND s."category_id" IS NOT DISTINCT FROM NEW."expense_category_id"
	) THEN
		RAISE EXCEPTION 'That sub-category does not belong to the expense category chosen for this item.'
			USING ERRCODE = '23514', CONSTRAINT = 'items_subcategory_matches_category';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "items_subcategory_matches_category" BEFORE INSERT OR UPDATE OF "expense_category_id", "expense_subcategory_id" ON "items"
	FOR EACH ROW EXECUTE FUNCTION "items_check_subcategory_matches_category"();
--> statement-breakpoint
CREATE TRIGGER "item_requests_subcategory_matches_category" BEFORE INSERT OR UPDATE OF "expense_category_id", "expense_subcategory_id" ON "item_requests"
	FOR EACH ROW EXECUTE FUNCTION "items_check_subcategory_matches_category"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Gap 4 note: the alias-vs-name guard above ignores MERGED items. A merge keeps the loser row (with its name) and adds that name as an
-- alias of the winner, so the old spelling still finds the survivor; the loser's name is already refused for any new item by items_org_name_key.
--
-- Gap 5: an item's kind cannot cross the service line (to OR from 'service') once it has history. A service is never stocked, so
-- history on a non-service item (stock, deliveries, usage, recipes) must not be re-labelled a service, and invoice lines (the one thing a
-- service may have) must not be re-labelled stock.
CREATE FUNCTION "items_check_service_kind_history"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF (OLD."kind" = 'service') IS DISTINCT FROM (NEW."kind" = 'service') AND (
		EXISTS (SELECT 1 FROM "stock_movements" x WHERE x."item_id" = NEW."id")
		OR EXISTS (SELECT 1 FROM "delivery_lines" x WHERE x."item_id" = NEW."id")
		OR EXISTS (SELECT 1 FROM "stock_usage_lines" x WHERE x."item_id" = NEW."id")
		OR EXISTS (SELECT 1 FROM "production_recipe_lines" x WHERE x."item_id" = NEW."id")
		OR EXISTS (SELECT 1 FROM "production_recipes" x WHERE x."output_item_id" = NEW."id")
		OR EXISTS (SELECT 1 FROM "supplier_invoice_lines" x WHERE x."item_id" = NEW."id")
	) THEN
		RAISE EXCEPTION 'This item already has stock, delivery, usage, recipe or invoice history, so it cannot be changed to or from a service.'
			USING ERRCODE = '23514', CONSTRAINT = 'items_service_kind_has_history';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "items_service_kind_has_history" BEFORE UPDATE OF "kind" ON "items"
	FOR EACH ROW EXECUTE FUNCTION "items_check_service_kind_history"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- T-398 S6 pin: the capability list inside log_break_glass_approval must equal CAPABILITIES; T-502 S2 adds approve_item_request. Body identical to 0222 otherwise (grants survive CREATE OR REPLACE).
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
		'view_franchise_sales', 'view_franchise_access_log', 'approve_item_request'])) THEN
		RAISE EXCEPTION 'That is not a known capability, so no approval was logged.' USING ERRCODE = '22023';
	END IF;
	SELECT p."display_name" INTO v_name FROM "persons" p WHERE p."id" = p_person AND p."org_id" = v_org;
	SELECT s."id" INTO v_store FROM "stores" s WHERE s."id" = p_store AND s."org_id" = v_org;
	INSERT INTO "franchise_access_log" ("org_id", "franchisor_org_id", "agreement_id", "what", "franchisee_person_id", "person_name", "store_id", "capability")
	VALUES (v_org, v_franchisor, v_agreement, 'break_glass_approval', p_person, v_name, v_store, p_capability);
	RETURN true;
END;
$$;
