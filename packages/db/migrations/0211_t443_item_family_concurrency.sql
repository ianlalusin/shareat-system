-- T-443 audit, 2026-10-19: serialize family validation across concurrent writers.
-- Opposite assignments, parent-kind changes and parent merges previously passed against old snapshots.
-- Forward-only correction of 0210, already applied on development/scratch databases.
-- Keep the trigger name, grants, RLS and existing five shape checks; change only serialization.
-- Namespace 443001 is reserved for per-org item-family structure in repo/advisory-locks.ts.
CREATE OR REPLACE FUNCTION "items_check_variant_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	parent_row RECORD;
BEGIN
	-- One org's structural item writes are uncommon administrative operations. Serialize BEFORE
	-- reading parent/children so a second transaction sees the first one's committed shape.
	-- The two-int4 key space is separate from the existing bigint locks (advisory-locks.ts).
	PERFORM pg_advisory_xact_lock(443001::int4, hashtext(NEW."org_id"::text));
	IF NEW."variant_of_item_id" IS NOT NULL THEN
		SELECT "variant_of_item_id", "status", "kind", "name" INTO parent_row FROM "items" WHERE "id" = NEW."variant_of_item_id";
		IF NOT FOUND THEN
			RAISE EXCEPTION 'The item this one is a variation of does not exist.'
				USING ERRCODE = '23514', CONSTRAINT = 'items_variant_guard';
		END IF;
		IF parent_row."variant_of_item_id" IS NOT NULL THEN
			RAISE EXCEPTION 'A variation cannot have variations of its own: "%" is already a variation. Pick its top-level item instead.', parent_row."name"
				USING ERRCODE = '23514', CONSTRAINT = 'items_variant_guard';
		END IF;
		IF parent_row."status" = 'merged' THEN
			RAISE EXCEPTION '"%" was merged into another item, so it cannot have variations. Use the item it was merged into.', parent_row."name"
				USING ERRCODE = '23514', CONSTRAINT = 'items_variant_guard';
		END IF;
		IF parent_row."kind" <> NEW."kind" THEN
			RAISE EXCEPTION 'A variation must be the same kind as "%" (%), not %.', parent_row."name", parent_row."kind", NEW."kind"
				USING ERRCODE = '23514', CONSTRAINT = 'items_variant_guard';
		END IF;
		-- An item that has variations cannot itself become a variation. (An INSERT has none yet.)
		IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "items" WHERE "variant_of_item_id" = NEW."id") THEN
			RAISE EXCEPTION 'This item already has variations of its own, so it cannot become a variation. Move or detach its variations first.'
				USING ERRCODE = '23514', CONSTRAINT = 'items_variant_guard';
		END IF;
	END IF;
	IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM "items" WHERE "variant_of_item_id" = NEW."id") THEN
		IF NEW."kind" <> OLD."kind" THEN
			RAISE EXCEPTION 'The kind cannot change while this item has variations: every variation must stay the same kind as its parent.'
				USING ERRCODE = '23514', CONSTRAINT = 'items_variant_guard';
		END IF;
		IF NEW."status" = 'merged' AND OLD."status" <> 'merged' THEN
			RAISE EXCEPTION 'This item has variations, so it cannot be merged into another. Move or detach its variations first.'
				USING ERRCODE = '23514', CONSTRAINT = 'items_variant_guard';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
