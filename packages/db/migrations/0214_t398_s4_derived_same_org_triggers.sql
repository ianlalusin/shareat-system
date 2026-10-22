-- 0214 - T-398 S4 / DEF-491 part 3: the same-org validator trigger on every derived-scope foreign key.
-- docs/tasks/398-padre-garcia-franchise-org.md S4, A1, A2, A11, C2, D3, D4, D7, D8. Hand-authored per ADR-012 s5.
--
-- WHY. Same hole as 0194 / 0213, for the tables that carry NO org_id of their own (their organisation is their
-- header's: remittance_lines belongs to a remittance, count_lines to a count session ...). As shareat_app with
-- app.org_id = A, an INSERT/UPDATE that points an org-A child at an org-B money account, item or person is
-- ACCEPTED: RLS checks the child's header, and the FK check runs as the table owner without consulting RLS on the
-- target. A composite (org_id, col) FK cannot help - the child has no org_id to put in it. So a BEFORE trigger
-- decides instead.
--
-- THE 82 (A11) = 77 derived->org + 3 org->derived (stock_layers.invoice_line_id, attendance_punches.captured_by_session_id,
-- attendance_adjustments.decided_by_session_id) + 2 derived->derived (sessions.credential_id,
-- supplier_return_lines.delivery_line_id), read from pg_constraint. 27 of them are the table's OWN RLS 'via' header
-- (rls/registry.ts): the policy WITH CHECK already forces that FK to a header of the caller's org, so they are guarded
-- by construction and carry NO trigger (D3; pinned as VIA_HEADER_GUARDED in same-org-fk-exemptions.ts). The other 55
-- get one trigger each, so OPEN_DEF_491 ends empty.
--
-- THE FUNCTION assert_same_org_via_parent() (SECURITY INVOKER, EXECUTE revoked from PUBLIC; a trigger needs no EXECUTE
-- grant to fire). TG_ARGV = (fk column, header table, header column, target table). It resolves BOTH sides' organisation:
-- the child's (its header's org_id, or its own org_id when the header table is '' - the 3 org->derived FKs) and the
-- target's (its own org_id, or, for the four derived targets sessions / person_credentials / delivery_lines /
-- supplier_invoice_lines, its header's). A NULL FK value passes. Anything that does not resolve on either side is
-- REFUSED, never passed (D4): under shareat_app + FORCE RLS a row of another organisation reads as absent, so "I cannot
-- see it" and "it does not exist" are both a refusal, SQLSTATE 23503, message starting 'DEF-491'. (0185's helper returns
-- true when the row is absent; that is fail-open and is deliberately not copied.)
--
-- THE TRIGGERS: BEFORE INSERT OR UPDATE OF <fk col>, <header col> (or <fk col>, org_id for the 3 org->derived FKs) FOR EACH ROW, named <child>_<col>_same_org_trg
-- (57 characters at most). UPDATE OF means an unrelated column update never runs the function; naming the header
-- column (or org_id) re-checks the target when a row is moved to another header or organisation. The function also pins
-- search_path = public, pg_temp, and the pre-flight schema-qualifies every name, so a same-named table in another schema cannot forge an org. 55 entries join triggers/registry.ts
-- (validator, origin: they decide from OTHER rows' current state, bible T-354), which grows 100 -> 155.
--
-- PRE-FLIGHT, fail closed. The first DO block counts, per FK, the rows already violating (cross-org or dangling) and
-- RAISEs naming DEF-491 and every FK with its count, before any trigger exists. It changes nothing; each row needs a
-- human decision. The migrator role bypasses RLS, so it sees every organisation.
--
-- LOCK BUDGET (A1, D7, D8).
--   * First statement: SET LOCAL lock_timeout = '5s' (resets at commit). A deploy that hits it is re-run, never edited.
--   * Lock mode: each trigger statement takes SHARE ROW EXCLUSIVE on its child table (conflicts with writes, not with
--     reads); drizzle applies all pending migrations in ONE transaction (dialect.js:60), so the 55 children stay locked
--     against writes until COMMIT. Nothing is rewritten; the only table scans are the pre-flight's read-only counts.
--   * Budget: 0.95 s end to end (drizzle migrate of 0214 alone, one transaction) on a local PG 18 scratch database at the full 0213 schema with empty tables; only the pre-flight scans child tables, so production should land in the low single seconds, far under the 60 s ceiling below. RUN-TIME COST of the triggers (A/B on one database, 55 triggers enabled vs disabled, median of 5, domain functions): postEntry of a 10-line journal entry (2 journal_lines triggers per line) 14.7 ms -> 24.8 ms (about 1.7x, roughly 0.5 ms per trigger call); receiveDelivery of 50 lines 165 ms -> 217 ms (1.3x); a 50-line stock count (50 recordCount + commitCount) 777 ms -> 881 ms (1.1x). Re-time on a restore before the deploy (D8) if row counts grew.
--   * The rule is a 60 s ceiling (D8). Do not deploy 05:30-07:00 Manila (the T-396 POS import locks sales_days).
--
-- PRODUCTION PRE-CHECK (READ ONLY - Ian runs it as doadmin before the deploy, D8): P0214, one row per guarded FK
-- (55 rows, expect every count 0); the query lives in docs/ops/P0214-precheck.sql.
--
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
	r record;
	n bigint;
	total bigint := 0;
	child_org text;
	tgt_org text;
	bad_lines text[] := ARRAY[]::text[];
BEGIN
	FOR r IN SELECT * FROM (VALUES
		('ap_payment_allocations', 'expense_id', 'ap_payments', 'ap_payment_id', 'expenses'),
		('ar_collection_allocations', 'ar_charge_id', 'ar_collections', 'ar_collection_id', 'ar_charges'),
		('attendance_adjustments', 'decided_by_session_id', '', '', 'sessions'),
		('attendance_punches', 'captured_by_session_id', '', '', 'sessions'),
		('count_lines', 'counted_by', 'count_sessions', 'session_id', 'persons'),
		('count_lines', 'item_id', 'count_sessions', 'session_id', 'items'),
		('count_lines', 'location_id', 'count_sessions', 'session_id', 'stock_locations'),
		('count_lines', 'movement_id', 'count_sessions', 'session_id', 'stock_movements'),
		('count_session_locations', 'location_id', 'count_sessions', 'session_id', 'stock_locations'),
		('customer_return_lines', 'item_id', 'customer_returns', 'return_id', 'items'),
		('customer_return_lines', 'movement_id', 'customer_returns', 'return_id', 'stock_movements'),
		('customer_return_lines', 'trade_order_line_id', 'customer_returns', 'return_id', 'trade_order_lines'),
		('delivery_lines', 'item_id', 'deliveries', 'delivery_id', 'items'),
		('delivery_lines', 'location_id', 'deliveries', 'delivery_id', 'stock_locations'),
		('employment_positions', 'position_id', 'employments', 'employment_id', 'positions'),
		('expense_payments', 'cash_request_id', 'expenses', 'expense_id', 'cash_requests'),
		('expense_payments', 'money_account_id', 'expenses', 'expense_id', 'money_accounts'),
		('expense_payments', 'staff_id', 'expenses', 'expense_id', 'persons'),
		('journal_lines', 'account_id', 'journal_entries', 'entry_id', 'accounts'),
		('journal_lines', 'store_id', 'journal_entries', 'entry_id', 'stores'),
		('order_wastage_allocations', 'person_id', 'order_wastages', 'wastage_id', 'persons'),
		('person_credentials', 'revoked_by', 'persons', 'person_id', 'persons'),
		('person_credentials', 'store_id', 'persons', 'person_id', 'stores'),
		('person_grants', 'granted_by', 'persons', 'person_id', 'persons'),
		('person_grants', 'source_ref', 'persons', 'person_id', 'position_capability_defaults'),
		('person_grants', 'store_id', 'persons', 'person_id', 'stores'),
		('person_store_scope', 'granted_by', 'persons', 'person_id', 'persons'),
		('person_store_scope', 'store_id', 'persons', 'person_id', 'stores'),
		('pos_usage_pull_lines', 'item_id', 'pos_usage_pulls', 'pull_id', 'items'),
		('pos_usage_pull_lines', 'location_id', 'pos_usage_pulls', 'pull_id', 'stock_locations'),
		('pos_usage_pull_lines', 'usage_record_id', 'pos_usage_pulls', 'pull_id', 'stock_usage_records'),
		('production_recipe_lines', 'item_id', 'production_recipes', 'recipe_id', 'items'),
		('production_record_lines', 'item_id', 'production_records', 'record_id', 'items'),
		('production_record_lines', 'movement_id', 'production_records', 'record_id', 'stock_movements'),
		('remittance_allocations', 'sales_day_id', 'remittances', 'remittance_id', 'sales_days'),
		('remittance_lines', 'from_money_account_id', 'remittances', 'remittance_id', 'money_accounts'),
		('remittance_lines', 'money_transfer_id', 'remittances', 'remittance_id', 'money_transfers'),
		('remittance_lines', 'to_money_account_id', 'remittances', 'remittance_id', 'money_accounts'),
		('sales_day_channels', 'channel_id', 'sales_days', 'sales_day_id', 'sales_channels'),
		('sales_day_tenders', 'money_account_id', 'sales_days', 'sales_day_id', 'money_accounts'),
		('sessions', 'credential_id', 'persons', 'person_id', 'person_credentials'),
		('sessions', 'store_id', 'persons', 'person_id', 'stores'),
		('stock_layers', 'invoice_line_id', '', '', 'supplier_invoice_lines'),
		('stock_transfer_lines', 'in_movement_id', 'stock_transfers', 'transfer_id', 'stock_movements'),
		('stock_transfer_lines', 'item_id', 'stock_transfers', 'transfer_id', 'items'),
		('stock_transfer_lines', 'out_movement_id', 'stock_transfers', 'transfer_id', 'stock_movements'),
		('stock_usage_lines', 'item_id', 'stock_usage_records', 'record_id', 'items'),
		('stock_usage_lines', 'movement_id', 'stock_usage_records', 'record_id', 'stock_movements'),
		('supplier_invoice_lines', 'item_id', 'supplier_invoices', 'supplier_invoice_id', 'items'),
		('supplier_return_lines', 'delivery_line_id', 'supplier_returns', 'return_id', 'delivery_lines'),
		('supplier_return_lines', 'item_id', 'supplier_returns', 'return_id', 'items'),
		('supplier_return_lines', 'location_id', 'supplier_returns', 'return_id', 'stock_locations'),
		('supplier_return_lines', 'movement_id', 'supplier_returns', 'return_id', 'stock_movements'),
		('till_count_lines', 'counted_by', 'till_custody_shifts', 'shift_id', 'persons'),
		('till_count_lines', 'money_account_id', 'till_custody_shifts', 'shift_id', 'money_accounts')
	) AS v (child, col, hdr_table, hdr_col, target) ORDER BY 1, 2 LOOP
		IF r.hdr_table = '' THEN
			child_org := 'c.org_id';
		ELSE
			child_org := format('(SELECT h.org_id FROM public.%I h WHERE h.id = c.%I)', r.hdr_table, r.hdr_col);
		END IF;
		IF r.target IN ('sessions', 'person_credentials') THEN
			tgt_org := format('(SELECT p.org_id FROM public.%I x JOIN public.persons p ON p.id = x.person_id WHERE x.id = c.%I)', r.target, r.col);
		ELSIF r.target = 'delivery_lines' THEN
			tgt_org := format('(SELECT p.org_id FROM public.%I x JOIN public.deliveries p ON p.id = x.delivery_id WHERE x.id = c.%I)', r.target, r.col);
		ELSIF r.target = 'supplier_invoice_lines' THEN
			tgt_org := format('(SELECT p.org_id FROM public.%I x JOIN public.supplier_invoices p ON p.id = x.supplier_invoice_id WHERE x.id = c.%I)', r.target, r.col);
		ELSE
			tgt_org := format('(SELECT t.org_id FROM public.%I t WHERE t.id = c.%I)', r.target, r.col);
		END IF;
		EXECUTE format('SELECT count(*) FROM public.%I c WHERE c.%I IS NOT NULL AND (%s IS NULL OR %s IS NULL OR %s <> %s)',
			r.child, r.col, child_org, tgt_org, child_org, tgt_org) INTO n;
		IF n > 0 THEN
			total := total + n;
			bad_lines := bad_lines || (r.child || '.' || r.col || ' -> ' || r.target || ': ' || n);
		END IF;
	END LOOP;
	IF total > 0 THEN
		RAISE EXCEPTION 'DEF-491: % row(s) already reference another organisation or a missing row; no trigger was created. No silent fix; each row needs a human decision: %', total, array_to_string(bad_lines, '; ')
			USING ERRCODE = '23503';
	END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "assert_same_org_via_parent"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
DECLARE
	fk_col text := TG_ARGV[0];
	hdr_table text := TG_ARGV[1];
	hdr_col text := TG_ARGV[2];
	tgt_table text := TG_ARGV[3];
	j jsonb := to_jsonb(NEW);
	tgt_id uuid := (j ->> fk_col)::uuid;
	hdr_id uuid;
	child_org uuid;
	target_org uuid;
BEGIN
	IF tgt_id IS NULL THEN
		RETURN NEW;
	END IF;

	-- the child's organisation: its own org_id, or its header's
	IF hdr_table = '' THEN
		child_org := (j ->> 'org_id')::uuid;
	ELSE
		hdr_id := (j ->> hdr_col)::uuid;
		IF hdr_id IS NOT NULL THEN
			EXECUTE format('SELECT org_id FROM public.%I WHERE id = $1', hdr_table) INTO child_org USING hdr_id;
		END IF;
	END IF;
	IF child_org IS NULL THEN
		RAISE EXCEPTION 'DEF-491: %.% - the organisation of this row could not be resolved (its header % is missing or not visible).', TG_TABLE_NAME, fk_col, coalesce(nullif(hdr_col, ''), 'org_id')
			USING ERRCODE = '23503', TABLE = TG_TABLE_NAME, COLUMN = fk_col;
	END IF;

	-- the target's organisation: its own org_id, or (a derived target) its header's
	IF tgt_table IN ('sessions', 'person_credentials') THEN
		EXECUTE format('SELECT p.org_id FROM public.%I x JOIN public.persons p ON p.id = x.person_id WHERE x.id = $1', tgt_table) INTO target_org USING tgt_id;
	ELSIF tgt_table = 'delivery_lines' THEN
		EXECUTE format('SELECT p.org_id FROM public.%I x JOIN public.deliveries p ON p.id = x.delivery_id WHERE x.id = $1', tgt_table) INTO target_org USING tgt_id;
	ELSIF tgt_table = 'supplier_invoice_lines' THEN
		EXECUTE format('SELECT p.org_id FROM public.%I x JOIN public.supplier_invoices p ON p.id = x.supplier_invoice_id WHERE x.id = $1', tgt_table) INTO target_org USING tgt_id;
	ELSE
		EXECUTE format('SELECT org_id FROM public.%I WHERE id = $1', tgt_table) INTO target_org USING tgt_id;
	END IF;

	IF target_org IS NULL OR target_org <> child_org THEN
		RAISE EXCEPTION 'DEF-491: %.% points at a % row of another organisation, or one that does not exist or is not visible.', TG_TABLE_NAME, fk_col, tgt_table
			USING ERRCODE = '23503', TABLE = TG_TABLE_NAME, COLUMN = fk_col;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ap_payment_allocations_expense_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "expense_id", "ap_payment_id" ON "ap_payment_allocations"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('expense_id', 'ap_payments', 'ap_payment_id', 'expenses');
--> statement-breakpoint
CREATE TRIGGER "ar_collection_allocations_ar_charge_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "ar_charge_id", "ar_collection_id" ON "ar_collection_allocations"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('ar_charge_id', 'ar_collections', 'ar_collection_id', 'ar_charges');
--> statement-breakpoint
CREATE TRIGGER "attendance_adjustments_decided_by_session_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "decided_by_session_id", "org_id" ON "attendance_adjustments"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('decided_by_session_id', '', '', 'sessions');
--> statement-breakpoint
CREATE TRIGGER "attendance_punches_captured_by_session_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "captured_by_session_id", "org_id" ON "attendance_punches"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('captured_by_session_id', '', '', 'sessions');
--> statement-breakpoint
CREATE TRIGGER "count_lines_counted_by_same_org_trg"
	BEFORE INSERT OR UPDATE OF "counted_by", "session_id" ON "count_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('counted_by', 'count_sessions', 'session_id', 'persons');
--> statement-breakpoint
CREATE TRIGGER "count_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "session_id" ON "count_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'count_sessions', 'session_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "count_lines_location_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "location_id", "session_id" ON "count_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('location_id', 'count_sessions', 'session_id', 'stock_locations');
--> statement-breakpoint
CREATE TRIGGER "count_lines_movement_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "movement_id", "session_id" ON "count_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('movement_id', 'count_sessions', 'session_id', 'stock_movements');
--> statement-breakpoint
CREATE TRIGGER "count_session_locations_location_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "location_id", "session_id" ON "count_session_locations"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('location_id', 'count_sessions', 'session_id', 'stock_locations');
--> statement-breakpoint
CREATE TRIGGER "customer_return_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "return_id" ON "customer_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'customer_returns', 'return_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "customer_return_lines_movement_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "movement_id", "return_id" ON "customer_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('movement_id', 'customer_returns', 'return_id', 'stock_movements');
--> statement-breakpoint
CREATE TRIGGER "customer_return_lines_trade_order_line_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "trade_order_line_id", "return_id" ON "customer_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('trade_order_line_id', 'customer_returns', 'return_id', 'trade_order_lines');
--> statement-breakpoint
CREATE TRIGGER "delivery_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "delivery_id" ON "delivery_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'deliveries', 'delivery_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "delivery_lines_location_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "location_id", "delivery_id" ON "delivery_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('location_id', 'deliveries', 'delivery_id', 'stock_locations');
--> statement-breakpoint
CREATE TRIGGER "employment_positions_position_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "position_id", "employment_id" ON "employment_positions"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('position_id', 'employments', 'employment_id', 'positions');
--> statement-breakpoint
CREATE TRIGGER "expense_payments_cash_request_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "cash_request_id", "expense_id" ON "expense_payments"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('cash_request_id', 'expenses', 'expense_id', 'cash_requests');
--> statement-breakpoint
CREATE TRIGGER "expense_payments_money_account_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "money_account_id", "expense_id" ON "expense_payments"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('money_account_id', 'expenses', 'expense_id', 'money_accounts');
--> statement-breakpoint
CREATE TRIGGER "expense_payments_staff_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "staff_id", "expense_id" ON "expense_payments"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('staff_id', 'expenses', 'expense_id', 'persons');
--> statement-breakpoint
CREATE TRIGGER "journal_lines_account_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "account_id", "entry_id" ON "journal_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('account_id', 'journal_entries', 'entry_id', 'accounts');
--> statement-breakpoint
CREATE TRIGGER "journal_lines_store_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "store_id", "entry_id" ON "journal_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('store_id', 'journal_entries', 'entry_id', 'stores');
--> statement-breakpoint
CREATE TRIGGER "order_wastage_allocations_person_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "person_id", "wastage_id" ON "order_wastage_allocations"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('person_id', 'order_wastages', 'wastage_id', 'persons');
--> statement-breakpoint
CREATE TRIGGER "person_credentials_revoked_by_same_org_trg"
	BEFORE INSERT OR UPDATE OF "revoked_by", "person_id" ON "person_credentials"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('revoked_by', 'persons', 'person_id', 'persons');
--> statement-breakpoint
CREATE TRIGGER "person_credentials_store_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "store_id", "person_id" ON "person_credentials"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('store_id', 'persons', 'person_id', 'stores');
--> statement-breakpoint
CREATE TRIGGER "person_grants_granted_by_same_org_trg"
	BEFORE INSERT OR UPDATE OF "granted_by", "person_id" ON "person_grants"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('granted_by', 'persons', 'person_id', 'persons');
--> statement-breakpoint
CREATE TRIGGER "person_grants_source_ref_same_org_trg"
	BEFORE INSERT OR UPDATE OF "source_ref", "person_id" ON "person_grants"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('source_ref', 'persons', 'person_id', 'position_capability_defaults');
--> statement-breakpoint
CREATE TRIGGER "person_grants_store_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "store_id", "person_id" ON "person_grants"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('store_id', 'persons', 'person_id', 'stores');
--> statement-breakpoint
CREATE TRIGGER "person_store_scope_granted_by_same_org_trg"
	BEFORE INSERT OR UPDATE OF "granted_by", "person_id" ON "person_store_scope"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('granted_by', 'persons', 'person_id', 'persons');
--> statement-breakpoint
CREATE TRIGGER "person_store_scope_store_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "store_id", "person_id" ON "person_store_scope"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('store_id', 'persons', 'person_id', 'stores');
--> statement-breakpoint
CREATE TRIGGER "pos_usage_pull_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "pull_id" ON "pos_usage_pull_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'pos_usage_pulls', 'pull_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "pos_usage_pull_lines_location_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "location_id", "pull_id" ON "pos_usage_pull_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('location_id', 'pos_usage_pulls', 'pull_id', 'stock_locations');
--> statement-breakpoint
CREATE TRIGGER "pos_usage_pull_lines_usage_record_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "usage_record_id", "pull_id" ON "pos_usage_pull_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('usage_record_id', 'pos_usage_pulls', 'pull_id', 'stock_usage_records');
--> statement-breakpoint
CREATE TRIGGER "production_recipe_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "recipe_id" ON "production_recipe_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'production_recipes', 'recipe_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "production_record_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "record_id" ON "production_record_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'production_records', 'record_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "production_record_lines_movement_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "movement_id", "record_id" ON "production_record_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('movement_id', 'production_records', 'record_id', 'stock_movements');
--> statement-breakpoint
CREATE TRIGGER "remittance_allocations_sales_day_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "sales_day_id", "remittance_id" ON "remittance_allocations"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('sales_day_id', 'remittances', 'remittance_id', 'sales_days');
--> statement-breakpoint
CREATE TRIGGER "remittance_lines_from_money_account_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "from_money_account_id", "remittance_id" ON "remittance_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('from_money_account_id', 'remittances', 'remittance_id', 'money_accounts');
--> statement-breakpoint
CREATE TRIGGER "remittance_lines_money_transfer_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "money_transfer_id", "remittance_id" ON "remittance_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('money_transfer_id', 'remittances', 'remittance_id', 'money_transfers');
--> statement-breakpoint
CREATE TRIGGER "remittance_lines_to_money_account_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "to_money_account_id", "remittance_id" ON "remittance_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('to_money_account_id', 'remittances', 'remittance_id', 'money_accounts');
--> statement-breakpoint
CREATE TRIGGER "sales_day_channels_channel_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "channel_id", "sales_day_id" ON "sales_day_channels"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('channel_id', 'sales_days', 'sales_day_id', 'sales_channels');
--> statement-breakpoint
CREATE TRIGGER "sales_day_tenders_money_account_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "money_account_id", "sales_day_id" ON "sales_day_tenders"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('money_account_id', 'sales_days', 'sales_day_id', 'money_accounts');
--> statement-breakpoint
CREATE TRIGGER "sessions_credential_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "credential_id", "person_id" ON "sessions"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('credential_id', 'persons', 'person_id', 'person_credentials');
--> statement-breakpoint
CREATE TRIGGER "sessions_store_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "store_id", "person_id" ON "sessions"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('store_id', 'persons', 'person_id', 'stores');
--> statement-breakpoint
CREATE TRIGGER "stock_layers_invoice_line_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "invoice_line_id", "org_id" ON "stock_layers"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('invoice_line_id', '', '', 'supplier_invoice_lines');
--> statement-breakpoint
CREATE TRIGGER "stock_transfer_lines_in_movement_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "in_movement_id", "transfer_id" ON "stock_transfer_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('in_movement_id', 'stock_transfers', 'transfer_id', 'stock_movements');
--> statement-breakpoint
CREATE TRIGGER "stock_transfer_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "transfer_id" ON "stock_transfer_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'stock_transfers', 'transfer_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "stock_transfer_lines_out_movement_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "out_movement_id", "transfer_id" ON "stock_transfer_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('out_movement_id', 'stock_transfers', 'transfer_id', 'stock_movements');
--> statement-breakpoint
CREATE TRIGGER "stock_usage_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "record_id" ON "stock_usage_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'stock_usage_records', 'record_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "stock_usage_lines_movement_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "movement_id", "record_id" ON "stock_usage_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('movement_id', 'stock_usage_records', 'record_id', 'stock_movements');
--> statement-breakpoint
CREATE TRIGGER "supplier_invoice_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "supplier_invoice_id" ON "supplier_invoice_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'supplier_invoices', 'supplier_invoice_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "supplier_return_lines_delivery_line_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "delivery_line_id", "return_id" ON "supplier_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('delivery_line_id', 'supplier_returns', 'return_id', 'delivery_lines');
--> statement-breakpoint
CREATE TRIGGER "supplier_return_lines_item_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "item_id", "return_id" ON "supplier_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('item_id', 'supplier_returns', 'return_id', 'items');
--> statement-breakpoint
CREATE TRIGGER "supplier_return_lines_location_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "location_id", "return_id" ON "supplier_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('location_id', 'supplier_returns', 'return_id', 'stock_locations');
--> statement-breakpoint
CREATE TRIGGER "supplier_return_lines_movement_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "movement_id", "return_id" ON "supplier_return_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('movement_id', 'supplier_returns', 'return_id', 'stock_movements');
--> statement-breakpoint
CREATE TRIGGER "till_count_lines_counted_by_same_org_trg"
	BEFORE INSERT OR UPDATE OF "counted_by", "shift_id" ON "till_count_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('counted_by', 'till_custody_shifts', 'shift_id', 'persons');
--> statement-breakpoint
CREATE TRIGGER "till_count_lines_money_account_id_same_org_trg"
	BEFORE INSERT OR UPDATE OF "money_account_id", "shift_id" ON "till_count_lines"
	FOR EACH ROW EXECUTE FUNCTION "assert_same_org_via_parent"('money_account_id', 'till_custody_shifts', 'shift_id', 'money_accounts');
--> statement-breakpoint
REVOKE ALL ON FUNCTION "assert_same_org_via_parent"() FROM PUBLIC;
