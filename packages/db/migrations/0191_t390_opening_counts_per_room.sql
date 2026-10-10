-- 0191 - T-390 (DEF-623), docs/tasks/390-opening-stock-and-subledger-tieout.md R1/R2: an opening count belongs to a ROOM and a cost carries its SOURCE.
--
-- WHAT IT DOES:
--   1. opening_counts gains location_id (a room of the SAME store, NOT NULL after backfill), cost_source and cost_evidence.
--   2. Existing rows are backfilled to their store's single active default room. A store with counts and no default room, or more
--      than one, makes this migration RAISE with the store id and the number of default rooms (never a guessed room).
--   3. The unique key moves from (store_id, item_id) to (store_id, location_id, item_id).
--   4. cost_source is backfilled 'typed' where unit_cost is set; CHECKs: unit_cost and cost_source are null together or set
--      together (opening_counts_cost_source_pair_check), and a source is never blank (opening_counts_cost_source_not_blank_check).
--   5. Trigger opening_counts_room_in_store (BEFORE INSERT OR UPDATE OF location_id, store_id): the room must belong to the store.
--   RLS and grants are unchanged (the table is already registered, KEEP).
--
-- PRODUCTION PRECHECK (read-only, run as doadmin before apply, result recorded in the PR):
--   P0191a  SELECT count(*) FROM opening_counts;   -- EXPECTED 0. Not 0 is not a failure: step 2 backfills, or RAISEs loudly.
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "opening_counts" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "opening_counts" ADD COLUMN "cost_source" text;--> statement-breakpoint
ALTER TABLE "opening_counts" ADD COLUMN "cost_evidence" text;--> statement-breakpoint
DO $$
DECLARE
	r record;
BEGIN
	FOR r IN
		SELECT oc.store_id,
		       (SELECT count(*) FROM stock_locations sl
		         WHERE sl.store_id = oc.store_id AND sl.is_default AND sl.status = 'active') AS defaults
		  FROM (SELECT DISTINCT store_id FROM opening_counts) oc
	LOOP
		IF r.defaults <> 1 THEN
			RAISE EXCEPTION 'T-390: store % has opening counts but % active default rooms (need exactly 1); fix the rooms, then re-run', r.store_id, r.defaults;
		END IF;
	END LOOP;
END $$;--> statement-breakpoint
UPDATE "opening_counts" oc SET "location_id" = (
	SELECT sl.id FROM stock_locations sl
	 WHERE sl.store_id = oc.store_id AND sl.is_default AND sl.status = 'active');--> statement-breakpoint
ALTER TABLE "opening_counts" ALTER COLUMN "location_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_location_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
DROP INDEX "opening_counts_store_item_key";--> statement-breakpoint
CREATE UNIQUE INDEX "opening_counts_store_location_item_key" ON "opening_counts" USING btree ("store_id","location_id","item_id");--> statement-breakpoint
CREATE INDEX "opening_counts_location_idx" ON "opening_counts" USING btree ("location_id");--> statement-breakpoint
UPDATE "opening_counts" SET "cost_source" = 'typed' WHERE "unit_cost" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_cost_source_pair_check"
	CHECK (("unit_cost" IS NULL) = ("cost_source" IS NULL));--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_cost_source_not_blank_check"
	CHECK ("cost_source" IS NULL OR length(trim("cost_source")) > 0);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "opening_counts_check_room_in_store"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM stock_locations sl WHERE sl.id = NEW.location_id AND sl.store_id = NEW.store_id) THEN
		RAISE EXCEPTION 'room % is not a room of store %', NEW.location_id, NEW.store_id
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "opening_counts_room_in_store"
	BEFORE INSERT OR UPDATE OF location_id, store_id ON "opening_counts"
	FOR EACH ROW EXECUTE FUNCTION "opening_counts_check_room_in_store"();
