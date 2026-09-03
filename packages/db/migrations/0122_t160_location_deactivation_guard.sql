-- 0122 — T-160 invariant 5: a room holding stock cannot be deactivated.
--
-- HAND-WRITTEN, like 0020-0121 (DEF-073 — never `db:generate` on this repo).
--
-- ⭐ The service layer (`packages/domain/src/stock-locations/service.ts`'s `deactivateLocation`)
-- pre-checks this and throws a readable sentence naming the room — but bible §6.3 holds: the
-- database enforces the rule, not the service. This trigger is the control; the service's own
-- check exists only to produce a better sentence before the write is even attempted.
--
-- Fires on the SAME transition `stock_locations_single_room_guard_trg` (0062) watches the opposite
-- side of: that one refuses a room turning ACTIVE when the store cannot hold it; this one refuses
-- a room turning INACTIVE while it still holds stock. Both are BEFORE UPDATE, both read
-- `stock_movements`/`stores` to answer a question a plain CHECK constraint cannot reach.
CREATE OR REPLACE FUNCTION "stock_locations_deactivation_guard"() RETURNS trigger AS $$
DECLARE
	holds boolean;
BEGIN
	-- Only the active -> inactive transition is in play. Every other UPDATE (rename, re-type,
	-- re-role, reactivate, or a no-op status write) passes straight through.
	IF OLD."status" = 'active' AND NEW."status" = 'inactive' THEN
		-- ⭐ Grouped by item, not a flat SUM: a location whose movements happen to net to zero
		-- ACROSS every item (one fully consumed, another still sitting there) must still be
		-- refused. A location "holds stock" if ANY single item's balance there is non-zero.
		SELECT EXISTS (
			SELECT 1 FROM "stock_movements"
			WHERE "location_id" = NEW."id"
			GROUP BY "item_id"
			HAVING sum("quantity") <> 0
		) INTO holds;

		IF holds THEN
			RAISE EXCEPTION 'location % holds stock and cannot be deactivated', NEW."id";
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "stock_locations_deactivation_guard_trg"
	BEFORE UPDATE ON "stock_locations"
	FOR EACH ROW EXECUTE FUNCTION "stock_locations_deactivation_guard"();--> statement-breakpoint
