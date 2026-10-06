-- 0186 - T-378 S2 (DEF-598, DEF-599), docs/tasks/378-item-unit-editable.md rulings R2 and R7, REV-1..REV-5.
--
-- (1) R2: an item's unit is fixed once it has history. `items_unit_history_exists(p_item)` is the ONE definition of
--     "has history" (I2): one EXISTS per blocking reference to items(id) (26 legs per REV-1: 23 FK columns on 22 other
--     tables, 3 self-references), plus REV-2's outgoing leg (this item's own cost_basis_item_id). Exempt (a declaration,
--     three booleans, provenance): supplier_items, store_item_sellability, item_requests.created_item_id.
--     Written as an early-return ladder, indexed tables first, scans last (REV-5); no index is added.
--     SECURITY INVOKER (no definer, the 0185 convention). With no org context and a role that cannot bypass RLS it
--     returns TRUE (locked): RLS would otherwise hide every referencing row and answer "no history" (REV-4).
--     Trigger `items_base_unit_fixed` (BEFORE UPDATE OF base_unit, only when the value changes) first takes
--     `FOR UPDATE` on the item row (REV-3: the UPDATE's FOR NO KEY UPDATE does not conflict with a concurrent first
--     stock insert's FOR KEY SHARE) and then asks the function in a SEPARATE statement (fresh snapshot). It also
--     closes the 0125 gap: a slab with sliced children can no longer change unit (invariant 7, parent side).
--     Refusal: ERRCODE 23514, CONSTRAINT items_base_unit_fixed (apps/erp/src/lib/constraint-messages.ts).
-- (2) R7: item_requests carries the three flags (is_purchasable true, sellable_retail false, sellable_wholesale false),
--     NOT NULL with the item defaults. A constant default is a metadata-only ADD COLUMN.
--
-- PRECHECKS (informational, any count is fine; Ian reads them off READ ONLY, `BEGIN READ ONLY; ... ROLLBACK;`):
--   P0186a: SELECT count(*) FROM item_requests WHERE status = 'requested';
--           (these pending rows get true/false/false; the approver confirms each on the approve form)
--   P0186b-pre (run BEFORE the push; the same list as the function, pasted; after the migration use
--           SELECT i.name, i.base_unit, i.status, items_unit_history_exists(i.id) AS has_history FROM items i
--           ORDER BY has_history, i.name):
-- P0186b-pre:begin
-- SELECT i.name, i.base_unit, i.status,
--   (EXISTS (SELECT 1 FROM stock_movements WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM supplier_invoice_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM delivery_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM trade_order_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM stock_usage_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM stock_transfer_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM stock_reservations WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM supplier_return_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM customer_return_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM production_recipe_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM production_record_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM pos_item_maps WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM pos_usage_pull_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM item_pricing WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM items WHERE parent_slab_item_id = i.id)
--    OR EXISTS (SELECT 1 FROM stock_layers WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM count_lines WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM opening_counts WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM store_item_thresholds WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM price_list_items WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM commissary_item_offerings WHERE item_id = i.id)
--    OR EXISTS (SELECT 1 FROM commissary_item_map WHERE commissary_item_id = i.id)
--    OR EXISTS (SELECT 1 FROM commissary_item_map WHERE branch_item_id = i.id)
--    OR EXISTS (SELECT 1 FROM production_recipes WHERE output_item_id = i.id)
--    OR EXISTS (SELECT 1 FROM items WHERE cost_basis_item_id = i.id)
--    OR EXISTS (SELECT 1 FROM items WHERE merged_into_id = i.id)
--    OR EXISTS (SELECT 1 FROM items x WHERE x.id = i.id AND x.cost_basis_item_id IS NOT NULL)) AS has_history
-- FROM items i ORDER BY has_history, i.name;
-- P0186b-pre:end
--
-- No row can violate 0186 at apply time: the trigger guards only future UPDATEs, and the new columns have defaults.
-- No GRANT: items UPDATE and item_requests INSERT/UPDATE are already granted. No table is added, so no RLS registry or
-- classification change. Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE FUNCTION "items_unit_history_exists"(p_item uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
	bypass boolean;
BEGIN
	IF app_current_org() IS NULL THEN
		SELECT coalesce(rolsuper OR rolbypassrls, false) INTO bypass FROM pg_roles WHERE rolname = current_user;
		IF NOT coalesce(bypass, false) THEN
			RETURN true;
		END IF;
	END IF;
	IF EXISTS (SELECT 1 FROM stock_movements WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM supplier_invoice_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM delivery_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM trade_order_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM stock_usage_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM stock_transfer_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM stock_reservations WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM supplier_return_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM customer_return_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM production_recipe_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM production_record_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM pos_item_maps WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM pos_usage_pull_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM item_pricing WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM items WHERE parent_slab_item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM stock_layers WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM count_lines WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM opening_counts WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM store_item_thresholds WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM price_list_items WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM commissary_item_offerings WHERE item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM commissary_item_map WHERE commissary_item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM commissary_item_map WHERE branch_item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM production_recipes WHERE output_item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM items WHERE cost_basis_item_id = p_item) THEN RETURN true; END IF;
	IF EXISTS (SELECT 1 FROM items WHERE merged_into_id = p_item) THEN RETURN true; END IF;
	-- REV-2: this item's OWN cost basis (it prices off another item per its current unit).
	IF EXISTS (SELECT 1 FROM items WHERE id = p_item AND cost_basis_item_id IS NOT NULL) THEN RETURN true; END IF;
	RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "items_check_base_unit_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	-- REV-3: FOR UPDATE conflicts with a concurrent first stock insert's FOR KEY SHARE, so this waits for it.
	PERFORM 1 FROM items WHERE id = OLD.id FOR UPDATE;
	-- A separate statement: under READ COMMITTED it takes a fresh snapshot and sees what the waited-for tx committed.
	IF "items_unit_history_exists"(OLD.id) THEN
		RAISE EXCEPTION 'This item''s unit can no longer change: it already has stock, counts, invoices, recipes, prices or orders recorded in its current unit, and changing it would re-read every one of them in the new unit.'
			USING ERRCODE = '23514', CONSTRAINT = 'items_base_unit_fixed';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "items_base_unit_fixed" BEFORE UPDATE OF "base_unit" ON "items"
	FOR EACH ROW WHEN (OLD."base_unit" IS DISTINCT FROM NEW."base_unit")
	EXECUTE FUNCTION "items_check_base_unit_fixed"();
--> statement-breakpoint
ALTER TABLE "item_requests" ADD COLUMN "is_purchasable" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD COLUMN "sellable_retail" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD COLUMN "sellable_wholesale" boolean DEFAULT false NOT NULL;
