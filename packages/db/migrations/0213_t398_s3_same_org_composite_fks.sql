-- 0213 - T-398 S3 / DEF-491: every remaining org->org foreign key gets a composite same-org twin.
-- docs/tasks/398-padre-garcia-franchise-org.md S3, A1, A11, B6, C2, D2, D7, D8. Hand-authored per ADR-012 s5.
--
-- WHY. Same mechanism as 0194 (persons/stores) and 0171 (DEF-490): as shareat_app with app.org_id = A,
-- an INSERT/UPDATE pointing an org-A row at an org-B parent is ACCEPTED, because RLS checks only the row's
-- own org_id and the FK check runs as the table owner without consulting RLS on the parent. Padre Garcia
-- becomes a second org, so every parent that is itself org-scoped needs the database to refuse it.
--
-- SHAPE (0194's, unchanged). UNIQUE (org_id, id) on each parent that does not already have one (trivially
-- true: id alone is unique; it exists so a composite FK has a real unique target), then for each FK below
-- FOREIGN KEY (org_id, "<col>") REFERENCES <parent> (org_id, id), MATCH SIMPLE (a NULL <col> skips the check,
-- so every nullable column stays nullable), named <table>_<col>_same_org_fk (all 63 characters or fewer).
-- The single-column FKs are KEPT unedited. ON DELETE follows the single-column FK it twins: RESTRICT for 136,
-- CASCADE for 6 (missed_month_adjustments.journal_entry_id, period_overrides.entry_id,
-- price_list_items.price_list_id, recurring_expense_drafts.recurring_expense_id, trade_order_lines.order_id,
-- trade_order_messages.order_id), and SET NULL ("<col>") for 3 (recurring_expense_drafts.expense_id,
-- recurring_expense_drafts.supplier_invoice_id, recurring_expenses.last_drafted_expense_id) - the column-list
-- form, so org_id (NOT NULL) is never nulled. A blanket RESTRICT would have silently turned those nine
-- parent deletes from "cascade / clear" into "refused". The four reference gaps are RESTRICT (new FKs).
--
-- COUNTS (D2). 145 composite FKs = 141 bare single-column org->org FKs read from pg_constraint + 4 reference
-- gaps (A11: payslips.journal_entry_id, separations.journal_entry_id, thirteenth_month_payouts.journal_entry_id,
-- owner_drawing_closes.adjustment_entry_id - uuid columns that had NO FK at all). 38 new UNIQUE (org_id, id):
-- the 145 FKs point at 45 parents and 7 of them already carry one (B6; the query decides, not a hand list).
-- pos_v1_day_feeds.batch_id is NOT one of the four: it has no parent (a minted grouping id; D2).
--
-- THE LIST COMES FROM THIS QUERY (B6), run on the schema as of 0211, never typed by hand:
--   SELECT cr.relname AS child, a.attname AS col, pr.relname AS parent
--   FROM pg_constraint con
--   JOIN pg_class cr ON cr.oid = con.conrelid
--   JOIN pg_class pr ON pr.oid = con.confrelid
--   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
--   WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace AND cardinality(con.conkey) = 1
--     AND pr.relname NOT IN ('organizations', 'persons', 'stores')
--     AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = con.conrelid AND x.attname = 'org_id' AND NOT x.attisdropped)
--     AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = con.confrelid AND x.attname = 'org_id' AND NOT x.attisdropped)
--     AND NOT EXISTS (SELECT 1 FROM pg_constraint t WHERE t.contype = 'f' AND t.conrelid = con.conrelid
--       AND t.confrelid = con.confrelid AND cardinality(t.conkey) = 2 AND t.oid <> con.oid
--       AND (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = t.conkey[1]) = 'org_id'
--       AND (SELECT attname FROM pg_attribute WHERE attrelid = con.conrelid AND attnum = t.conkey[2]) = a.attname)
--   ORDER BY 1, 2;                                                          -- 141 rows (+ the 4 reference gaps = 145)
-- and the parents that still need the unique key (the parent set of the 145, minus those that have one):
--   SELECT p FROM (SELECT DISTINCT pr.relname AS p ...the list above plus journal_entries...) s
--   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint u WHERE u.conrelid = s.p::regclass AND u.contype IN ('u', 'p')
--     AND cardinality(u.conkey) = 2 AND (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
--       WHERE attrelid = u.conrelid AND attnum = ANY (u.conkey)) = ARRAY['id', 'org_id']);   -- 38 rows
--
-- PRE-FLIGHT, fail closed. The first DO block counts, per FK below, rows whose <col> is non-NULL and whose
-- parent is missing or carries a different org_id, and RAISEs naming every non-zero FK and its count with
-- "DEF-491 ... No silent fix; each row needs a human decision". A dangling value in one of the four
-- reference-gap columns would otherwise surface as a bare 23503 from the first ADD FOREIGN KEY. It changes nothing.
-- The whole migration runs in one transaction (drizzle-orm pg-core dialect.js:60), so a RAISE leaves no
-- constraint behind. The migrator role bypasses RLS, so the count sees every org.
--
-- LOCK BUDGET (A1, D7, D8).
--   * First statement: SET LOCAL lock_timeout = '5s' - fail fast rather than queue behind live traffic; it
--     resets at commit. A deploy that hits it is simply re-run, never edited.
--   * Lock mode: each ADD FOREIGN KEY takes SHARE ROW EXCLUSIVE on the child AND on the parent (SHARE ROW
--     EXCLUSIVE conflicts with writes, not with reads); each UNIQUE (org_id, id) takes SHARE on the parent.
--     drizzle applies every pending migration in ONE transaction, so NOT VALID then VALIDATE here would gain
--     nothing (every lock is held until COMMIT) and each FK is added plainly, as 0194 did. The 45 parents and
--     the children are locked against writes for the whole run; reads are never blocked.
--   * Budget: 5.8 s end to end (drizzle migrate, all 183 statements, one transaction) on a local PG 18 scratch database at the full 0211 schema (every child table present), empty tables: the cost is per-statement overhead (about 30 ms each) and each ADD FOREIGN KEY adds one scan of its child, so production (one org, a few thousand rows at most) should land in the 10-20 s band, well under the 60 s ceiling below. Re-time on a restore before the deploy (D8) if row counts grew.
--   * The rule is a 60 s ceiling (D8): if a production-size run exceeds it, the FKs move to ADD ... NOT VALID
--     in this deploy and VALIDATE CONSTRAINT to a later migration and deploy. Do not deploy 05:30-07:00 Manila
--     (the T-396 POS import locks sales_days / pos_v1_day_feeds).
--
-- PRODUCTION PRE-CHECK (READ ONLY - Ian runs it as doadmin before the deploy, D8). The scripts live OUTSIDE
-- the repo, in C:\Users\ianla\shareat-master-data\2026-10-22\: P0212a_cross_org_count_per_fk.sql (145 rows,
-- expect every count 0) and P0212b_org_count.sql (expect 1). See docs/ops/README.md.
--
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
	r record;
	n integer;
	total integer := 0;
	bad_lines text[] := ARRAY[]::text[];
BEGIN
	FOR r IN SELECT * FROM (VALUES
		('accounts', 'parent_id', 'accounts'),
		('ap_payments', 'cash_request_id', 'cash_requests'),
		('ap_payments', 'journal_entry_id', 'journal_entries'),
		('ap_payments', 'supplier_id', 'suppliers'),
		('ar_charges', 'customer_id', 'customers'),
		('ar_charges', 'journal_entry_id', 'journal_entries'),
		('ar_collections', 'customer_id', 'customers'),
		('ar_collections', 'journal_entry_id', 'journal_entries'),
		('ar_collections', 'receipt_file_id', 'stored_files'),
		('ar_write_offs', 'ar_charge_id', 'ar_charges'),
		('ar_write_offs', 'journal_entry_id', 'journal_entries'),
		('attendance_adjustments', 'employment_id', 'employments'),
		('attendance_adjustments', 'superseded_by_adjustment_id', 'attendance_adjustments'),
		('attendance_credentials', 'employment_id', 'employments'),
		('attendance_days', 'attendance_config_id', 'store_attendance_config'),
		('attendance_days', 'employment_id', 'employments'),
		('attendance_days', 'first_in_punch_id', 'attendance_punches'),
		('attendance_days', 'frozen_by_pay_run_id', 'pay_runs'),
		('attendance_days', 'last_out_punch_id', 'attendance_punches'),
		('attendance_punches', 'employment_id', 'employments'),
		('attendance_punches', 'supersedes_punch_id', 'attendance_punches'),
		('channel_settlements', 'channel_id', 'sales_channels'),
		('channel_settlements', 'journal_entry_id', 'journal_entries'),
		('channel_settlements', 'loan_id', 'loans'),
		('channel_settlements', 'sales_day_id', 'sales_days'),
		('channel_settlements', 'withholding_certificate_file_id', 'stored_files'),
		('commissary_item_map', 'branch_item_id', 'items'),
		('commissary_item_map', 'commissary_item_id', 'items'),
		('commissary_item_map', 'expense_category_id', 'expense_categories'),
		('commissary_item_offerings', 'item_id', 'items'),
		('count_sessions', 'journal_entry_id', 'journal_entries'),
		('customer_returns', 'customer_id', 'customers'),
		('customer_returns', 'journal_entry_id', 'journal_entries'),
		('customer_returns', 'trade_order_id', 'trade_orders'),
		('customers', 'price_list_id', 'price_lists'),
		('deliveries', 'proof_file_id', 'stored_files'),
		('deliveries', 'supplier_id', 'suppliers'),
		('employments', 'photo_file_id', 'stored_files'),
		('expense_budgets', 'category_id', 'expense_categories'),
		('expense_budgets', 'reissued_from_id', 'expense_budgets'),
		('expenses', 'category_id', 'expense_categories'),
		('expenses', 'journal_entry_id', 'journal_entries'),
		('expenses', 'owner_id', 'owners'),
		('expenses', 'supplier_id', 'suppliers'),
		('expenses', 'supplier_invoice_id', 'supplier_invoices'),
		('fixed_assets', 'source_expense_id', 'expenses'),
		('inbox_quarantine', 'device_id', 'clock_terminals'),
		('item_pricing', 'item_id', 'items'),
		('item_requests', 'created_item_id', 'items'),
		('items', 'cost_basis_item_id', 'items'),
		('items', 'merged_into_id', 'items'),
		('items', 'parent_slab_item_id', 'items'),
		('journal_entries', 'period_id', 'fiscal_periods'),
		('journal_entries', 'reversal_of_entry_id', 'journal_entries'),
		('loans', 'lender_id', 'suppliers'),
		('missed_month_adjustments', 'fixed_asset_id', 'fixed_assets'),
		('missed_month_adjustments', 'journal_entry_id', 'journal_entries'),
		('missed_month_adjustments', 'prepaid_item_id', 'prepaid_items'),
		('money_transfers', 'journal_entry_id', 'journal_entries'),
		('opening_counts', 'item_id', 'items'),
		('opening_counts', 'location_id', 'stock_locations'),
		('order_wastages', 'channel_id', 'sales_channels'),
		('order_wastages', 'journal_entry_id', 'journal_entries'),
		('order_wastages', 'sales_day_id', 'sales_days'),
		('order_wastages', 'settlement_id', 'channel_settlements'),
		('owner_drawing_closes', 'adjustment_entry_id', 'journal_entries'),
		('owner_drawing_closes', 'owner_id', 'owners'),
		('pay_rates', 'employment_id', 'employments'),
		('payslips', 'employment_id', 'employments'),
		('payslips', 'journal_entry_id', 'journal_entries'),
		('payslips', 'pay_rate_id', 'pay_rates'),
		('payslips', 'run_id', 'pay_runs'),
		('period_overrides', 'entry_id', 'journal_entries'),
		('period_overrides', 'period_id', 'fiscal_periods'),
		('pos_item_maps', 'item_id', 'items'),
		('pos_item_maps', 'location_id', 'stock_locations'),
		('pos_item_maps', 'recipe_id', 'production_recipes'),
		('pos_usage_pulls', 'location_id', 'stock_locations'),
		('pos_usage_pulls', 'pos_v1_day_feed_id', 'pos_v1_day_feeds'),
		('pos_usage_pulls', 'sales_day_id', 'sales_days'),
		('pos_v1_store_links', 'sales_channel_id', 'sales_channels'),
		('position_capability_defaults', 'position_id', 'positions'),
		('prepaid_items', 'source_expense_id', 'expenses'),
		('price_list_items', 'item_id', 'items'),
		('price_list_items', 'price_list_id', 'price_lists'),
		('production_recipes', 'output_item_id', 'items'),
		('production_records', 'journal_entry_id', 'journal_entries'),
		('production_records', 'location_id', 'stock_locations'),
		('production_records', 'recipe_id', 'production_recipes'),
		('recurring_expense_drafts', 'expense_id', 'expenses'),
		('recurring_expense_drafts', 'recurring_expense_id', 'recurring_expenses'),
		('recurring_expense_drafts', 'supplier_invoice_id', 'supplier_invoices'),
		('recurring_expenses', 'category_id', 'expense_categories'),
		('recurring_expenses', 'last_drafted_expense_id', 'expenses'),
		('recurring_expenses', 'supplier_id', 'suppliers'),
		('remittance_variances', 'journal_entry_id', 'journal_entries'),
		('remittance_variances', 'remittance_id', 'remittances'),
		('remittance_variances', 'sales_day_id', 'sales_days'),
		('sales_day_pos_corrections', 'from_feed_id', 'pos_v1_day_feeds'),
		('sales_day_pos_corrections', 'journal_entry_id', 'journal_entries'),
		('sales_day_pos_corrections', 'sales_day_id', 'sales_days'),
		('sales_day_pos_corrections', 'to_feed_id', 'pos_v1_day_feeds'),
		('sales_days', 'journal_entry_id', 'journal_entries'),
		('sales_days', 'pos_v1_day_feed_id', 'pos_v1_day_feeds'),
		('separations', 'employment_id', 'employments'),
		('separations', 'journal_entry_id', 'journal_entries'),
		('stock_layer_consumptions', 'layer_id', 'stock_layers'),
		('stock_layer_consumptions', 'movement_id', 'stock_movements'),
		('stock_layer_consumptions', 'reversed_by_movement_id', 'stock_movements'),
		('stock_layers', 'item_id', 'items'),
		('stock_layers', 'movement_id', 'stock_movements'),
		('stock_locations', 'type_id', 'location_types'),
		('stock_movements', 'item_id', 'items'),
		('stock_movements', 'journal_entry_id', 'journal_entries'),
		('stock_movements', 'location_id', 'stock_locations'),
		('stock_movements', 'reversal_of_id', 'stock_movements'),
		('stock_reservations', 'item_id', 'items'),
		('stock_reservations', 'transfer_id', 'stock_transfers'),
		('stock_usage_records', 'department_id', 'departments'),
		('stock_usage_records', 'location_id', 'stock_locations'),
		('store_item_sellability', 'item_id', 'items'),
		('store_item_thresholds', 'item_id', 'items'),
		('supplier_invoices', 'receipt_file_id', 'stored_files'),
		('supplier_invoices', 'supplier_id', 'suppliers'),
		('supplier_items', 'item_id', 'items'),
		('supplier_items', 'supplier_id', 'suppliers'),
		('supplier_returns', 'delivery_id', 'deliveries'),
		('supplier_returns', 'journal_entry_id', 'journal_entries'),
		('supplier_returns', 'supplier_id', 'suppliers'),
		('thirteenth_month_payouts', 'employment_id', 'employments'),
		('thirteenth_month_payouts', 'journal_entry_id', 'journal_entries'),
		('thirteenth_month_payouts', 'run_id', 'thirteenth_month_runs'),
		('till_custody_shifts', 'attendance_day_id', 'attendance_days'),
		('till_custody_shifts', 'prev_shift_id', 'till_custody_shifts'),
		('trade_discrepancies', 'journal_entry_id', 'journal_entries'),
		('trade_discrepancies', 'order_id', 'trade_orders'),
		('trade_discrepancies', 'order_line_id', 'trade_order_lines'),
		('trade_order_lines', 'expense_category_id', 'expense_categories'),
		('trade_order_lines', 'item_id', 'items'),
		('trade_order_lines', 'order_id', 'trade_orders'),
		('trade_order_lines', 'source_location_id', 'stock_locations'),
		('trade_order_messages', 'order_id', 'trade_orders'),
		('trade_orders', 'ar_charge_id', 'ar_charges'),
		('trade_orders', 'customer_id', 'customers'),
		('trade_orders', 'journal_entry_id', 'journal_entries')
	) AS v (child, col, parent) LOOP
		EXECUTE format('SELECT count(*) FROM %I t LEFT JOIN %I m ON m."id" = t.%I WHERE t.%I IS NOT NULL AND (m."id" IS NULL OR t."org_id" <> m."org_id")', r.child, r.parent, r.col, r.col) INTO n;
		IF n > 0 THEN
			total := total + n;
			bad_lines := bad_lines || format('%s.%s -> %s: %s', r.child, r.col, r.parent, n);
		END IF;
	END LOOP;
	IF total > 0 THEN
		RAISE EXCEPTION
			'DEF-491: % cross-org (or dangling) reference(s) found - %. No silent fix; each row needs a human decision.',
			total, array_to_string(bad_lines, ', ')
			USING ERRCODE = 'raise_exception';
	END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "clock_terminals" ADD CONSTRAINT "clock_terminals_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "location_types" ADD CONSTRAINT "location_types_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "pos_v1_day_feeds" ADD CONSTRAINT "pos_v1_day_feeds_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "thirteenth_month_runs" ADD CONSTRAINT "thirteenth_month_runs_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "till_custody_shifts" ADD CONSTRAINT "till_custody_shifts_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_same_org_fk" FOREIGN KEY ("org_id", "parent_id") REFERENCES "accounts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_cash_request_id_same_org_fk" FOREIGN KEY ("org_id", "cash_request_id") REFERENCES "cash_requests" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_supplier_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "suppliers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_customer_id_same_org_fk" FOREIGN KEY ("org_id", "customer_id") REFERENCES "customers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_customer_id_same_org_fk" FOREIGN KEY ("org_id", "customer_id") REFERENCES "customers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_receipt_file_id_same_org_fk" FOREIGN KEY ("org_id", "receipt_file_id") REFERENCES "stored_files" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_write_offs" ADD CONSTRAINT "ar_write_offs_ar_charge_id_same_org_fk" FOREIGN KEY ("org_id", "ar_charge_id") REFERENCES "ar_charges" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_write_offs" ADD CONSTRAINT "ar_write_offs_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_superseded_by_adjustment_id_same_org_fk" FOREIGN KEY ("org_id", "superseded_by_adjustment_id") REFERENCES "attendance_adjustments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_credentials" ADD CONSTRAINT "attendance_credentials_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_attendance_config_id_same_org_fk" FOREIGN KEY ("org_id", "attendance_config_id") REFERENCES "store_attendance_config" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_first_in_punch_id_same_org_fk" FOREIGN KEY ("org_id", "first_in_punch_id") REFERENCES "attendance_punches" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_frozen_by_pay_run_id_same_org_fk" FOREIGN KEY ("org_id", "frozen_by_pay_run_id") REFERENCES "pay_runs" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_last_out_punch_id_same_org_fk" FOREIGN KEY ("org_id", "last_out_punch_id") REFERENCES "attendance_punches" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_supersedes_punch_id_same_org_fk" FOREIGN KEY ("org_id", "supersedes_punch_id") REFERENCES "attendance_punches" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_channel_id_same_org_fk" FOREIGN KEY ("org_id", "channel_id") REFERENCES "sales_channels" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_loan_id_same_org_fk" FOREIGN KEY ("org_id", "loan_id") REFERENCES "loans" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_sales_day_id_same_org_fk" FOREIGN KEY ("org_id", "sales_day_id") REFERENCES "sales_days" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_withholding_certificate_file_id_same_org_fk" FOREIGN KEY ("org_id", "withholding_certificate_file_id") REFERENCES "stored_files" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_branch_item_id_same_org_fk" FOREIGN KEY ("org_id", "branch_item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_commissary_item_id_same_org_fk" FOREIGN KEY ("org_id", "commissary_item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_expense_category_id_same_org_fk" FOREIGN KEY ("org_id", "expense_category_id") REFERENCES "expense_categories" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" ADD CONSTRAINT "commissary_item_offerings_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_customer_id_same_org_fk" FOREIGN KEY ("org_id", "customer_id") REFERENCES "customers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_trade_order_id_same_org_fk" FOREIGN KEY ("org_id", "trade_order_id") REFERENCES "trade_orders" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_price_list_id_same_org_fk" FOREIGN KEY ("org_id", "price_list_id") REFERENCES "price_lists" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_proof_file_id_same_org_fk" FOREIGN KEY ("org_id", "proof_file_id") REFERENCES "stored_files" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_supplier_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "suppliers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_photo_file_id_same_org_fk" FOREIGN KEY ("org_id", "photo_file_id") REFERENCES "stored_files" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_category_id_same_org_fk" FOREIGN KEY ("org_id", "category_id") REFERENCES "expense_categories" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_reissued_from_id_same_org_fk" FOREIGN KEY ("org_id", "reissued_from_id") REFERENCES "expense_budgets" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_same_org_fk" FOREIGN KEY ("org_id", "category_id") REFERENCES "expense_categories" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_owner_id_same_org_fk" FOREIGN KEY ("org_id", "owner_id") REFERENCES "owners" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "suppliers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_invoice_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_invoice_id") REFERENCES "supplier_invoices" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_source_expense_id_same_org_fk" FOREIGN KEY ("org_id", "source_expense_id") REFERENCES "expenses" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "inbox_quarantine" ADD CONSTRAINT "inbox_quarantine_device_id_same_org_fk" FOREIGN KEY ("org_id", "device_id") REFERENCES "clock_terminals" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_created_item_id_same_org_fk" FOREIGN KEY ("org_id", "created_item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_cost_basis_item_id_same_org_fk" FOREIGN KEY ("org_id", "cost_basis_item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_merged_into_id_same_org_fk" FOREIGN KEY ("org_id", "merged_into_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_parent_slab_item_id_same_org_fk" FOREIGN KEY ("org_id", "parent_slab_item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_same_org_fk" FOREIGN KEY ("org_id", "period_id") REFERENCES "fiscal_periods" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_entry_id_same_org_fk" FOREIGN KEY ("org_id", "reversal_of_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_lender_id_same_org_fk" FOREIGN KEY ("org_id", "lender_id") REFERENCES "suppliers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_fixed_asset_id_same_org_fk" FOREIGN KEY ("org_id", "fixed_asset_id") REFERENCES "fixed_assets" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_prepaid_item_id_same_org_fk" FOREIGN KEY ("org_id", "prepaid_item_id") REFERENCES "prepaid_items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_location_id_same_org_fk" FOREIGN KEY ("org_id", "location_id") REFERENCES "stock_locations" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_channel_id_same_org_fk" FOREIGN KEY ("org_id", "channel_id") REFERENCES "sales_channels" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_sales_day_id_same_org_fk" FOREIGN KEY ("org_id", "sales_day_id") REFERENCES "sales_days" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_settlement_id_same_org_fk" FOREIGN KEY ("org_id", "settlement_id") REFERENCES "channel_settlements" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_adjustment_entry_id_same_org_fk" FOREIGN KEY ("org_id", "adjustment_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_owner_id_same_org_fk" FOREIGN KEY ("org_id", "owner_id") REFERENCES "owners" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pay_rate_id_same_org_fk" FOREIGN KEY ("org_id", "pay_rate_id") REFERENCES "pay_rates" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_same_org_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "pay_runs" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "period_overrides" ADD CONSTRAINT "period_overrides_entry_id_same_org_fk" FOREIGN KEY ("org_id", "entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "period_overrides" ADD CONSTRAINT "period_overrides_period_id_same_org_fk" FOREIGN KEY ("org_id", "period_id") REFERENCES "fiscal_periods" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_location_id_same_org_fk" FOREIGN KEY ("org_id", "location_id") REFERENCES "stock_locations" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_recipe_id_same_org_fk" FOREIGN KEY ("org_id", "recipe_id") REFERENCES "production_recipes" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_location_id_same_org_fk" FOREIGN KEY ("org_id", "location_id") REFERENCES "stock_locations" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_pos_v1_day_feed_id_same_org_fk" FOREIGN KEY ("org_id", "pos_v1_day_feed_id") REFERENCES "pos_v1_day_feeds" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_sales_day_id_same_org_fk" FOREIGN KEY ("org_id", "sales_day_id") REFERENCES "sales_days" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_sales_channel_id_same_org_fk" FOREIGN KEY ("org_id", "sales_channel_id") REFERENCES "sales_channels" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_position_id_same_org_fk" FOREIGN KEY ("org_id", "position_id") REFERENCES "positions" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_source_expense_id_same_org_fk" FOREIGN KEY ("org_id", "source_expense_id") REFERENCES "expenses" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_same_org_fk" FOREIGN KEY ("org_id", "price_list_id") REFERENCES "price_lists" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_output_item_id_same_org_fk" FOREIGN KEY ("org_id", "output_item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_location_id_same_org_fk" FOREIGN KEY ("org_id", "location_id") REFERENCES "stock_locations" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_recipe_id_same_org_fk" FOREIGN KEY ("org_id", "recipe_id") REFERENCES "production_recipes" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "recurring_expense_drafts" ADD CONSTRAINT "recurring_expense_drafts_expense_id_same_org_fk" FOREIGN KEY ("org_id", "expense_id") REFERENCES "expenses" ("org_id", "id") ON DELETE SET NULL ("expense_id");
--> statement-breakpoint
ALTER TABLE "recurring_expense_drafts" ADD CONSTRAINT "recurring_expense_drafts_recurring_expense_id_same_org_fk" FOREIGN KEY ("org_id", "recurring_expense_id") REFERENCES "recurring_expenses" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "recurring_expense_drafts" ADD CONSTRAINT "recurring_expense_drafts_supplier_invoice_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_invoice_id") REFERENCES "supplier_invoices" ("org_id", "id") ON DELETE SET NULL ("supplier_invoice_id");
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_category_id_same_org_fk" FOREIGN KEY ("org_id", "category_id") REFERENCES "expense_categories" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_last_drafted_expense_id_same_org_fk" FOREIGN KEY ("org_id", "last_drafted_expense_id") REFERENCES "expenses" ("org_id", "id") ON DELETE SET NULL ("last_drafted_expense_id");
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_supplier_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "suppliers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_remittance_id_same_org_fk" FOREIGN KEY ("org_id", "remittance_id") REFERENCES "remittances" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_sales_day_id_same_org_fk" FOREIGN KEY ("org_id", "sales_day_id") REFERENCES "sales_days" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_from_feed_id_same_org_fk" FOREIGN KEY ("org_id", "from_feed_id") REFERENCES "pos_v1_day_feeds" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_sales_day_id_same_org_fk" FOREIGN KEY ("org_id", "sales_day_id") REFERENCES "sales_days" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_to_feed_id_same_org_fk" FOREIGN KEY ("org_id", "to_feed_id") REFERENCES "pos_v1_day_feeds" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_pos_v1_day_feed_id_same_org_fk" FOREIGN KEY ("org_id", "pos_v1_day_feed_id") REFERENCES "pos_v1_day_feeds" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_layer_id_same_org_fk" FOREIGN KEY ("org_id", "layer_id") REFERENCES "stock_layers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_movement_id_same_org_fk" FOREIGN KEY ("org_id", "movement_id") REFERENCES "stock_movements" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_reversed_by_movement_id_same_org_fk" FOREIGN KEY ("org_id", "reversed_by_movement_id") REFERENCES "stock_movements" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_movement_id_same_org_fk" FOREIGN KEY ("org_id", "movement_id") REFERENCES "stock_movements" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_type_id_same_org_fk" FOREIGN KEY ("org_id", "type_id") REFERENCES "location_types" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_same_org_fk" FOREIGN KEY ("org_id", "location_id") REFERENCES "stock_locations" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reversal_of_id_same_org_fk" FOREIGN KEY ("org_id", "reversal_of_id") REFERENCES "stock_movements" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_transfer_id_same_org_fk" FOREIGN KEY ("org_id", "transfer_id") REFERENCES "stock_transfers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_department_id_same_org_fk" FOREIGN KEY ("org_id", "department_id") REFERENCES "departments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_location_id_same_org_fk" FOREIGN KEY ("org_id", "location_id") REFERENCES "stock_locations" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_item_sellability" ADD CONSTRAINT "store_item_sellability_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_item_thresholds" ADD CONSTRAINT "store_item_thresholds_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_receipt_file_id_same_org_fk" FOREIGN KEY ("org_id", "receipt_file_id") REFERENCES "stored_files" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "suppliers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_supplier_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "suppliers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_delivery_id_same_org_fk" FOREIGN KEY ("org_id", "delivery_id") REFERENCES "deliveries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_supplier_id_same_org_fk" FOREIGN KEY ("org_id", "supplier_id") REFERENCES "suppliers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_employment_id_same_org_fk" FOREIGN KEY ("org_id", "employment_id") REFERENCES "employments" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_run_id_same_org_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "thirteenth_month_runs" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "till_custody_shifts" ADD CONSTRAINT "till_custody_shifts_attendance_day_id_same_org_fk" FOREIGN KEY ("org_id", "attendance_day_id") REFERENCES "attendance_days" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "till_custody_shifts" ADD CONSTRAINT "till_custody_shifts_prev_shift_id_same_org_fk" FOREIGN KEY ("org_id", "prev_shift_id") REFERENCES "till_custody_shifts" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_order_id_same_org_fk" FOREIGN KEY ("org_id", "order_id") REFERENCES "trade_orders" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_order_line_id_same_org_fk" FOREIGN KEY ("org_id", "order_line_id") REFERENCES "trade_order_lines" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_expense_category_id_same_org_fk" FOREIGN KEY ("org_id", "expense_category_id") REFERENCES "expense_categories" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_item_id_same_org_fk" FOREIGN KEY ("org_id", "item_id") REFERENCES "items" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_order_id_same_org_fk" FOREIGN KEY ("org_id", "order_id") REFERENCES "trade_orders" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_source_location_id_same_org_fk" FOREIGN KEY ("org_id", "source_location_id") REFERENCES "stock_locations" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_order_messages" ADD CONSTRAINT "trade_order_messages_order_id_same_org_fk" FOREIGN KEY ("org_id", "order_id") REFERENCES "trade_orders" ("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_ar_charge_id_same_org_fk" FOREIGN KEY ("org_id", "ar_charge_id") REFERENCES "ar_charges" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_customer_id_same_org_fk" FOREIGN KEY ("org_id", "customer_id") REFERENCES "customers" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_journal_entry_id_same_org_fk" FOREIGN KEY ("org_id", "journal_entry_id") REFERENCES "journal_entries" ("org_id", "id") ON DELETE RESTRICT;
