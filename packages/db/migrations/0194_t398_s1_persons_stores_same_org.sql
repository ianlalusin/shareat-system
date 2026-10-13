-- 0194 - T-398 S1 / DEF-491 part 1: persons and stores get composite same-org foreign keys.
-- docs/tasks/398-padre-garcia-franchise-org.md S1, R1, R2, A1, A8. Hand-authored per ADR-012 s5.
--
-- WHY. Every org-scoped table that points at persons(id) or stores(id) did so with a single-column
-- FK. As shareat_app with app.org_id = A, an INSERT/UPDATE pointing an org-A row at org B's person
-- or store was ACCEPTED: RLS checks only the row's own org_id and the FK check runs as the table
-- owner without consulting RLS on the parent (the DEF-490 mechanism, 0171). Padre Garcia becomes a
-- second org, so the domain's org-scoped getById was the only defence. This migration makes the
-- database refuse it.
--
-- SHAPE (0171's, unchanged). UNIQUE (org_id, id) on persons and stores (trivially true: id alone
-- is already unique; it exists so a composite FK has a real unique target), then for each of the
-- 229 FKs below FOREIGN KEY (org_id, "<col>") REFERENCES <parent> (org_id, id) ON DELETE
-- RESTRICT, MATCH SIMPLE (a NULL <col> skips the check, so every nullable column stays nullable),
-- named <table>_<col>_same_org_fk (longest is 63 chars or fewer; none needed shortening). The
-- single-column FKs are KEPT unedited. All 229 children carry org_id NOT NULL (checked from the
-- catalog), so a non-NULL <col> is always compared. 153 reference persons, 76 reference stores.
-- Out of scope here: org-less etl_* tables (listed, not fixed), derived-scope children (S4's
-- trigger), and five reference-gap columns (S3's).
--
-- PRE-FLIGHT, fail closed. The first DO block counts, per FK, rows whose <col> is non-NULL and
-- whose parent's org_id differs from the row's own, and RAISEs naming every non-zero FK and its
-- count with "DEF-491 ... No silent fix; each row needs a human decision". It changes nothing. The
-- whole migration runs in one transaction (drizzle-orm pg-core dialect.js:60), so a RAISE leaves
-- no constraint behind. The migrator role bypasses RLS, so the count sees every org.
--
-- LOCK BUDGET (A1).
--   * First statement: SET LOCAL lock_timeout = '5s' - fail fast rather than queue behind live
--     traffic; it resets at commit.
--   * Each ADD FOREIGN KEY takes SHARE ROW EXCLUSIVE on the child AND on the parent (persons or
--     stores); each UNIQUE (org_id, id) takes SHARE on persons / stores. drizzle applies every
--     pending migration in ONE transaction, so NOT VALID then VALIDATE in this file gains nothing:
--     every one of these locks is held until COMMIT. persons and stores are therefore locked
--     against writes for the whole run; reads are never blocked.
--   * Measured time: 12.5 s end to end (drizzle migrate, all 233 statements, one transaction) on a local
--     Postgres, schema at full 0193 size (all 93 child tables), 720 rows across the affected
--     tables (largest 450), 90 orgs of fixtures. Cost is per-statement overhead (about 50 ms each),
--     not row count: each ADD FOREIGN KEY validates by one scan of the child, so production, which is
--     tiny today (one org, a few thousand rows at most), lands in the same 10-20 s band, well
--     under the 60 s ceiling below. Re-time on a restore before the deploy if row counts grew.
--   * The rule is a 60 s ceiling: if a production-size run exceeds it, VALIDATE CONSTRAINT moves
--     to a separate later migration and deploy. Apply in a night window, never 05:30-07:00 Manila
--     (the T-396 timer).
--
-- PRODUCTION PRE-CHECK (READ ONLY - run by Ian or the operator before the deploy, Q9). Expected:
-- ZERO rows from every query, because production holds one org so no cross-org row can exist.
--   -- 1. one row per org-pair mismatch, any of the 229 FKs (example for two of them; the
--   --    migration's own DO block runs the full list and is the authoritative check):
--   SELECT count(*) FROM suppliers t JOIN persons m ON m.id = t.created_by WHERE t.org_id <> m.org_id;   -- expect 0
--   SELECT count(*) FROM sales_channels t JOIN stores m ON m.id = t.store_id WHERE t.org_id <> m.org_id; -- expect 0
--   -- 2. production holds a single org:
--   SELECT count(*) FROM organizations;                                                                 -- expect 1
--   -- 3. no pending lock holders on the two parents:
--   SELECT pid, state, wait_event_type, left(query, 80) FROM pg_stat_activity
--     WHERE state <> 'idle' AND query ~* '(persons|stores)' AND pid <> pg_backend_pid();                -- expect 0 rows
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
		('ap_payments', 'created_by', 'persons'),
		('ap_payments', 'store_id', 'stores'),
		('ap_payments', 'voided_by', 'persons'),
		('ar_charges', 'created_by', 'persons'),
		('ar_charges', 'store_id', 'stores'),
		('ar_charges', 'voided_by', 'persons'),
		('ar_collections', 'created_by', 'persons'),
		('ar_collections', 'store_id', 'stores'),
		('ar_collections', 'voided_by', 'persons'),
		('ar_write_offs', 'written_off_by', 'persons'),
		('attendance_adjustments', 'decided_by_person_id', 'persons'),
		('attendance_adjustments', 'store_id', 'stores'),
		('attendance_credentials', 'enrolled_by', 'persons'),
		('attendance_credentials', 'revoked_by', 'persons'),
		('attendance_credentials', 'store_id', 'stores'),
		('attendance_days', 'person_id', 'persons'),
		('attendance_days', 'store_id', 'stores'),
		('attendance_punches', 'created_by', 'persons'),
		('attendance_punches', 'person_id', 'persons'),
		('attendance_punches', 'store_id', 'stores'),
		('audit_log', 'actor_person_id', 'persons'),
		('cash_requests', 'approved_by', 'persons'),
		('cash_requests', 'created_by', 'persons'),
		('cash_requests', 'released_by', 'persons'),
		('cash_requests', 'requested_for', 'persons'),
		('cash_requests', 'store_id', 'stores'),
		('channel_settlements', 'created_by', 'persons'),
		('channel_settlements', 'loan_owner_store_id', 'stores'),
		('channel_settlements', 'posted_by', 'persons'),
		('channel_settlements', 'store_id', 'stores'),
		('channel_settlements', 'voided_by', 'persons'),
		('clock_terminals', 'provisioned_by', 'persons'),
		('clock_terminals', 'revoked_by', 'persons'),
		('clock_terminals', 'store_id', 'stores'),
		('commissary_item_map', 'branch_store_id', 'stores'),
		('commissary_item_map', 'commissary_store_id', 'stores'),
		('commissary_item_map', 'created_by', 'persons'),
		('commissary_item_offerings', 'commissary_store_id', 'stores'),
		('commissary_item_offerings', 'created_by', 'persons'),
		('commissary_links', 'branch_store_id', 'stores'),
		('commissary_links', 'commissary_store_id', 'stores'),
		('commissary_links', 'created_by', 'persons'),
		('count_sessions', 'closed_by', 'persons'),
		('count_sessions', 'opened_by', 'persons'),
		('count_sessions', 'store_id', 'stores'),
		('customer_returns', 'created_by', 'persons'),
		('customer_returns', 'store_id', 'stores'),
		('customer_returns', 'voided_by', 'persons'),
		('customers', 'counterparty_store_id', 'stores'),
		('customers', 'created_by', 'persons'),
		('customers', 'reconciled_by', 'persons'),
		('cutover_steps', 'completed_by', 'persons'),
		('cutover_steps', 'store_id', 'stores'),
		('deliveries', 'created_by', 'persons'),
		('deliveries', 'received_by', 'persons'),
		('deliveries', 'store_id', 'stores'),
		('deliveries', 'voided_by', 'persons'),
		('employments', 'created_by', 'persons'),
		('employments', 'person_id', 'persons'),
		('employments', 'store_id', 'stores'),
		('expense_budgets', 'created_by', 'persons'),
		('expense_budgets', 'store_id', 'stores'),
		('expenses', 'approved_by', 'persons'),
		('expenses', 'created_by', 'persons'),
		('expenses', 'store_id', 'stores'),
		('expenses', 'voided_by', 'persons'),
		('finding_acknowledgements', 'acknowledged_by', 'persons'),
		('finding_acknowledgements', 'store_id', 'stores'),
		('finding_occurrences', 'store_id', 'stores'),
		('finding_views', 'person_id', 'persons'),
		('fiscal_periods', 'closed_by', 'persons'),
		('fiscal_periods', 'created_by', 'persons'),
		('fixed_assets', 'created_by', 'persons'),
		('fixed_assets', 'disposed_by', 'persons'),
		('fixed_assets', 'store_id', 'stores'),
		('inbox_quarantine', 'resolved_by', 'persons'),
		('inbox_quarantine', 'store_id', 'stores'),
		('item_pricing', 'set_by', 'persons'),
		('item_requests', 'decided_by', 'persons'),
		('item_requests', 'requested_by', 'persons'),
		('items', 'created_by', 'persons'),
		('journal_entries', 'posted_by', 'persons'),
		('liabilities', 'created_by', 'persons'),
		('liabilities', 'store_id', 'stores'),
		('loans', 'created_by', 'persons'),
		('loans', 'store_id', 'stores'),
		('mirror_outbox', 'store_id', 'stores'),
		('missed_month_adjustments', 'booked_by', 'persons'),
		('money_accounts', 'store_id', 'stores'),
		('money_transfers', 'created_by', 'persons'),
		('money_transfers', 'store_id', 'stores'),
		('money_transfers', 'voided_by', 'persons'),
		('opening_counts', 'counted_by', 'persons'),
		('opening_counts', 'store_id', 'stores'),
		('order_wastages', 'created_by', 'persons'),
		('order_wastages', 'resolved_by', 'persons'),
		('order_wastages', 'store_id', 'stores'),
		('owner_drawing_closes', 'closed_by', 'persons'),
		('owner_drawing_closes', 'store_id', 'stores'),
		('owners', 'created_by', 'persons'),
		('owners', 'person_id', 'persons'),
		('owners', 'store_id', 'stores'),
		('pay_rates', 'created_by', 'persons'),
		('pay_runs', 'created_by', 'persons'),
		('pay_runs', 'posted_by', 'persons'),
		('pay_runs', 'store_id', 'stores'),
		('pay_runs', 'voided_by', 'persons'),
		('payslips', 'person_id', 'persons'),
		('period_overrides', 'actor_person_id', 'persons'),
		('person_roles', 'granted_by', 'persons'),
		('person_roles', 'person_id', 'persons'),
		('pin_attempt_throttle', 'reopened_by', 'persons'),
		('pin_attempt_throttle', 'store_id', 'stores'),
		('pos_item_maps', 'created_by', 'persons'),
		('pos_item_maps', 'store_id', 'stores'),
		('pos_map_requests', 'decided_by', 'persons'),
		('pos_map_requests', 'requested_by', 'persons'),
		('pos_map_requests', 'store_id', 'stores'),
		('pos_usage_pulls', 'finalized_by', 'persons'),
		('pos_usage_pulls', 'store_id', 'stores'),
		('pos_usage_pulls', 'voided_by', 'persons'),
		('pos_v1_day_feeds', 'fetched_by', 'persons'),
		('pos_v1_day_feeds', 'store_id', 'stores'),
		('pos_v1_store_links', 'created_by', 'persons'),
		('pos_v1_store_links', 'store_id', 'stores'),
		('pos_v1_store_links', 'unlinked_by', 'persons'),
		('pos_v1_store_links', 'updated_by', 'persons'),
		('position_capability_defaults', 'revoked_by', 'persons'),
		('position_capability_defaults', 'set_by', 'persons'),
		('position_capability_defaults', 'store_id', 'stores'),
		('positions', 'created_by', 'persons'),
		('positions', 'store_id', 'stores'),
		('prepaid_items', 'created_by', 'persons'),
		('prepaid_items', 'store_id', 'stores'),
		('prepaid_items', 'written_off_by', 'persons'),
		('prerequisite_refusals', 'actor_person_id', 'persons'),
		('prerequisite_refusals', 'store_id', 'stores'),
		('price_lists', 'created_by', 'persons'),
		('production_recipes', 'created_by', 'persons'),
		('production_records', 'created_by', 'persons'),
		('production_records', 'posted_by', 'persons'),
		('production_records', 'store_id', 'stores'),
		('production_records', 'voided_by', 'persons'),
		('recurring_expenses', 'created_by', 'persons'),
		('recurring_expenses', 'store_id', 'stores'),
		('remittance_variances', 'charged_to_person_id', 'persons'),
		('remittance_variances', 'resolved_by', 'persons'),
		('remittances', 'accepted_by', 'persons'),
		('remittances', 'created_by', 'persons'),
		('remittances', 'store_id', 'stores'),
		('sales_channels', 'store_id', 'stores'),
		('sales_day_pos_corrections', 'posted_by', 'persons'),
		('sales_day_pos_corrections', 'store_id', 'stores'),
		('sales_days', 'created_by', 'persons'),
		('sales_days', 'store_id', 'stores'),
		('sales_days', 'submitted_by', 'persons'),
		('sales_days', 'verified_by', 'persons'),
		('sales_days', 'voided_by', 'persons'),
		('separations', 'clearance_confirmed_by', 'persons'),
		('separations', 'created_by', 'persons'),
		('separations', 'person_id', 'persons'),
		('separations', 'posted_by', 'persons'),
		('separations', 'store_id', 'stores'),
		('separations', 'voided_by', 'persons'),
		('sign_in_attempts', 'device_id', 'persons'),
		('sign_in_attempts', 'store_id', 'stores'),
		('statutory_discount_records', 'recorded_by', 'persons'),
		('statutory_discount_records', 'store_id', 'stores'),
		('statutory_discount_records', 'voided_by', 'persons'),
		('stock_layers', 'store_id', 'stores'),
		('stock_locations', 'created_by', 'persons'),
		('stock_locations', 'store_id', 'stores'),
		('stock_movements', 'created_by', 'persons'),
		('stock_movements', 'store_id', 'stores'),
		('stock_reservations', 'store_id', 'stores'),
		('stock_transfers', 'created_by', 'persons'),
		('stock_transfers', 'dispatched_by', 'persons'),
		('stock_transfers', 'received_by', 'persons'),
		('stock_transfers', 'store_id', 'stores'),
		('stock_transfers', 'voided_by', 'persons'),
		('stock_usage_records', 'charge_person_id', 'persons'),
		('stock_usage_records', 'created_by', 'persons'),
		('stock_usage_records', 'posted_by', 'persons'),
		('stock_usage_records', 'store_id', 'stores'),
		('stock_usage_records', 'voided_by', 'persons'),
		('store_attendance_config', 'created_by', 'persons'),
		('store_attendance_config', 'store_id', 'stores'),
		('store_item_sellability', 'set_by', 'persons'),
		('store_item_sellability', 'store_id', 'stores'),
		('store_item_thresholds', 'set_by', 'persons'),
		('store_item_thresholds', 'store_id', 'stores'),
		('stored_files', 'store_id', 'stores'),
		('stored_files', 'uploaded_by', 'persons'),
		('stores', 'wastage_monitor_person_id', 'persons'),
		('supplier_invoices', 'created_by', 'persons'),
		('supplier_invoices', 'store_id', 'stores'),
		('supplier_invoices', 'verified_by', 'persons'),
		('supplier_invoices', 'voided_by', 'persons'),
		('supplier_items', 'created_by', 'persons'),
		('supplier_returns', 'created_by', 'persons'),
		('supplier_returns', 'store_id', 'stores'),
		('supplier_returns', 'voided_by', 'persons'),
		('suppliers', 'counterparty_store_id', 'stores'),
		('suppliers', 'created_by', 'persons'),
		('suppliers', 'reconciled_by', 'persons'),
		('tenders', 'store_id', 'stores'),
		('thirteenth_month_payouts', 'person_id', 'persons'),
		('thirteenth_month_runs', 'created_by', 'persons'),
		('thirteenth_month_runs', 'posted_by', 'persons'),
		('thirteenth_month_runs', 'store_id', 'stores'),
		('thirteenth_month_runs', 'voided_by', 'persons'),
		('till_custody_shifts', 'closed_by', 'persons'),
		('till_custody_shifts', 'opened_by', 'persons'),
		('till_custody_shifts', 'store_id', 'stores'),
		('trade_discrepancies', 'charge_person_id', 'persons'),
		('trade_discrepancies', 'resolved_by', 'persons'),
		('trade_discrepancies', 'store_id', 'stores'),
		('trade_order_messages', 'author_id', 'persons'),
		('trade_orders', 'accepted_by', 'persons'),
		('trade_orders', 'created_by', 'persons'),
		('trade_orders', 'credit_override_by', 'persons'),
		('trade_orders', 'dispatched_by', 'persons'),
		('trade_orders', 'ready_by', 'persons'),
		('trade_orders', 'received_by', 'persons'),
		('trade_orders', 'rejected_by', 'persons'),
		('trade_orders', 'requested_by_store_id', 'stores'),
		('trade_orders', 'store_id', 'stores'),
		('trade_orders', 'voided_by', 'persons'),
		('v1_master_links', 'created_by', 'persons')
	) AS v (child, col, parent) LOOP
		EXECUTE format('SELECT count(*) FROM %I t JOIN %I m ON m."id" = t.%I WHERE t.%I IS NOT NULL AND t."org_id" <> m."org_id"', r.child, r.parent, r.col, r.col) INTO n;
		IF n > 0 THEN
			total := total + n;
			bad_lines := bad_lines || format('%s.%s -> %s: %s', r.child, r.col, r.parent, n);
		END IF;
	END LOOP;
	IF total > 0 THEN
		RAISE EXCEPTION
			'DEF-491: % cross-org persons/stores reference(s) found - %. No silent fix; each row needs a human decision.',
			total, array_to_string(bad_lines, ', ')
			USING ERRCODE = 'raise_exception';
	END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ar_write_offs" ADD CONSTRAINT "ar_write_offs_written_off_by_same_org_fk" FOREIGN KEY ("org_id", "written_off_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_decided_by_person_id_same_org_fk" FOREIGN KEY ("org_id", "decided_by_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_credentials" ADD CONSTRAINT "attendance_credentials_enrolled_by_same_org_fk" FOREIGN KEY ("org_id", "enrolled_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_credentials" ADD CONSTRAINT "attendance_credentials_revoked_by_same_org_fk" FOREIGN KEY ("org_id", "revoked_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_credentials" ADD CONSTRAINT "attendance_credentials_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_person_id_same_org_fk" FOREIGN KEY ("org_id", "actor_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_approved_by_same_org_fk" FOREIGN KEY ("org_id", "approved_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_released_by_same_org_fk" FOREIGN KEY ("org_id", "released_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_requested_for_same_org_fk" FOREIGN KEY ("org_id", "requested_for") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_loan_owner_store_id_same_org_fk" FOREIGN KEY ("org_id", "loan_owner_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "clock_terminals" ADD CONSTRAINT "clock_terminals_provisioned_by_same_org_fk" FOREIGN KEY ("org_id", "provisioned_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "clock_terminals" ADD CONSTRAINT "clock_terminals_revoked_by_same_org_fk" FOREIGN KEY ("org_id", "revoked_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "clock_terminals" ADD CONSTRAINT "clock_terminals_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_branch_store_id_same_org_fk" FOREIGN KEY ("org_id", "branch_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_commissary_store_id_same_org_fk" FOREIGN KEY ("org_id", "commissary_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" ADD CONSTRAINT "commissary_item_offerings_commissary_store_id_same_org_fk" FOREIGN KEY ("org_id", "commissary_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" ADD CONSTRAINT "commissary_item_offerings_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_links" ADD CONSTRAINT "commissary_links_branch_store_id_same_org_fk" FOREIGN KEY ("org_id", "branch_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_links" ADD CONSTRAINT "commissary_links_commissary_store_id_same_org_fk" FOREIGN KEY ("org_id", "commissary_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "commissary_links" ADD CONSTRAINT "commissary_links_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_closed_by_same_org_fk" FOREIGN KEY ("org_id", "closed_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_opened_by_same_org_fk" FOREIGN KEY ("org_id", "opened_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_counterparty_store_id_same_org_fk" FOREIGN KEY ("org_id", "counterparty_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_reconciled_by_same_org_fk" FOREIGN KEY ("org_id", "reconciled_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "cutover_steps" ADD CONSTRAINT "cutover_steps_completed_by_same_org_fk" FOREIGN KEY ("org_id", "completed_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "cutover_steps" ADD CONSTRAINT "cutover_steps_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_received_by_same_org_fk" FOREIGN KEY ("org_id", "received_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_same_org_fk" FOREIGN KEY ("org_id", "approved_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "finding_acknowledgements" ADD CONSTRAINT "finding_acknowledgements_acknowledged_by_same_org_fk" FOREIGN KEY ("org_id", "acknowledged_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "finding_acknowledgements" ADD CONSTRAINT "finding_acknowledgements_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "finding_views" ADD CONSTRAINT "finding_views_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_same_org_fk" FOREIGN KEY ("org_id", "closed_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposed_by_same_org_fk" FOREIGN KEY ("org_id", "disposed_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "inbox_quarantine" ADD CONSTRAINT "inbox_quarantine_resolved_by_same_org_fk" FOREIGN KEY ("org_id", "resolved_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "inbox_quarantine" ADD CONSTRAINT "inbox_quarantine_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_set_by_same_org_fk" FOREIGN KEY ("org_id", "set_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_decided_by_same_org_fk" FOREIGN KEY ("org_id", "decided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_requested_by_same_org_fk" FOREIGN KEY ("org_id", "requested_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "mirror_outbox" ADD CONSTRAINT "mirror_outbox_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_booked_by_same_org_fk" FOREIGN KEY ("org_id", "booked_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_counted_by_same_org_fk" FOREIGN KEY ("org_id", "counted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_resolved_by_same_org_fk" FOREIGN KEY ("org_id", "resolved_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_closed_by_same_org_fk" FOREIGN KEY ("org_id", "closed_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "period_overrides" ADD CONSTRAINT "period_overrides_actor_person_id_same_org_fk" FOREIGN KEY ("org_id", "actor_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_granted_by_same_org_fk" FOREIGN KEY ("org_id", "granted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_reopened_by_same_org_fk" FOREIGN KEY ("org_id", "reopened_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_map_requests" ADD CONSTRAINT "pos_map_requests_decided_by_same_org_fk" FOREIGN KEY ("org_id", "decided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_map_requests" ADD CONSTRAINT "pos_map_requests_requested_by_same_org_fk" FOREIGN KEY ("org_id", "requested_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_map_requests" ADD CONSTRAINT "pos_map_requests_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_finalized_by_same_org_fk" FOREIGN KEY ("org_id", "finalized_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_v1_day_feeds" ADD CONSTRAINT "pos_v1_day_feeds_fetched_by_same_org_fk" FOREIGN KEY ("org_id", "fetched_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_v1_day_feeds" ADD CONSTRAINT "pos_v1_day_feeds_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_unlinked_by_same_org_fk" FOREIGN KEY ("org_id", "unlinked_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_updated_by_same_org_fk" FOREIGN KEY ("org_id", "updated_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_revoked_by_same_org_fk" FOREIGN KEY ("org_id", "revoked_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_set_by_same_org_fk" FOREIGN KEY ("org_id", "set_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_written_off_by_same_org_fk" FOREIGN KEY ("org_id", "written_off_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "prerequisite_refusals" ADD CONSTRAINT "prerequisite_refusals_actor_person_id_same_org_fk" FOREIGN KEY ("org_id", "actor_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "prerequisite_refusals" ADD CONSTRAINT "prerequisite_refusals_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_charged_to_person_id_same_org_fk" FOREIGN KEY ("org_id", "charged_to_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_resolved_by_same_org_fk" FOREIGN KEY ("org_id", "resolved_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_accepted_by_same_org_fk" FOREIGN KEY ("org_id", "accepted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_day_pos_corrections" ADD CONSTRAINT "sales_day_pos_corrections_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_submitted_by_same_org_fk" FOREIGN KEY ("org_id", "submitted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_verified_by_same_org_fk" FOREIGN KEY ("org_id", "verified_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_clearance_confirmed_by_same_org_fk" FOREIGN KEY ("org_id", "clearance_confirmed_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_device_id_same_org_fk" FOREIGN KEY ("org_id", "device_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_recorded_by_same_org_fk" FOREIGN KEY ("org_id", "recorded_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dispatched_by_same_org_fk" FOREIGN KEY ("org_id", "dispatched_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_same_org_fk" FOREIGN KEY ("org_id", "received_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_charge_person_id_same_org_fk" FOREIGN KEY ("org_id", "charge_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_item_sellability" ADD CONSTRAINT "store_item_sellability_set_by_same_org_fk" FOREIGN KEY ("org_id", "set_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_item_sellability" ADD CONSTRAINT "store_item_sellability_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_item_thresholds" ADD CONSTRAINT "store_item_thresholds_set_by_same_org_fk" FOREIGN KEY ("org_id", "set_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_item_thresholds" ADD CONSTRAINT "store_item_thresholds_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploaded_by_same_org_fk" FOREIGN KEY ("org_id", "uploaded_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_wastage_monitor_person_id_same_org_fk" FOREIGN KEY ("org_id", "wastage_monitor_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_verified_by_same_org_fk" FOREIGN KEY ("org_id", "verified_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_counterparty_store_id_same_org_fk" FOREIGN KEY ("org_id", "counterparty_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_reconciled_by_same_org_fk" FOREIGN KEY ("org_id", "reconciled_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_person_id_same_org_fk" FOREIGN KEY ("org_id", "person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_runs" ADD CONSTRAINT "thirteenth_month_runs_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_runs" ADD CONSTRAINT "thirteenth_month_runs_posted_by_same_org_fk" FOREIGN KEY ("org_id", "posted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_runs" ADD CONSTRAINT "thirteenth_month_runs_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "thirteenth_month_runs" ADD CONSTRAINT "thirteenth_month_runs_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "till_custody_shifts" ADD CONSTRAINT "till_custody_shifts_closed_by_same_org_fk" FOREIGN KEY ("org_id", "closed_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "till_custody_shifts" ADD CONSTRAINT "till_custody_shifts_opened_by_same_org_fk" FOREIGN KEY ("org_id", "opened_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "till_custody_shifts" ADD CONSTRAINT "till_custody_shifts_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_charge_person_id_same_org_fk" FOREIGN KEY ("org_id", "charge_person_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_resolved_by_same_org_fk" FOREIGN KEY ("org_id", "resolved_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_order_messages" ADD CONSTRAINT "trade_order_messages_author_id_same_org_fk" FOREIGN KEY ("org_id", "author_id") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_accepted_by_same_org_fk" FOREIGN KEY ("org_id", "accepted_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_credit_override_by_same_org_fk" FOREIGN KEY ("org_id", "credit_override_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_dispatched_by_same_org_fk" FOREIGN KEY ("org_id", "dispatched_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_ready_by_same_org_fk" FOREIGN KEY ("org_id", "ready_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_received_by_same_org_fk" FOREIGN KEY ("org_id", "received_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_rejected_by_same_org_fk" FOREIGN KEY ("org_id", "rejected_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_requested_by_store_id_same_org_fk" FOREIGN KEY ("org_id", "requested_by_store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "v1_master_links" ADD CONSTRAINT "v1_master_links_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
-- Audit 2026-10-12: SET LOCAL lasts to COMMIT, and drizzle applies every pending migration in ONE transaction, so undo it here.
RESET lock_timeout;
