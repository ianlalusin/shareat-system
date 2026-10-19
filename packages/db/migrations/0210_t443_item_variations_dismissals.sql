-- 0210 - T-443: item variations, "not a duplicate" dismissals, and the open-request duplicate backstop.
-- docs/tasks/443-item-variations-dismiss-guards.md R1, R2, R4; hand-authored per ADR-012 s5. Journal idx 210.
--
-- WHY. Ian, 2026-10-18: Kimchi must be able to exist as 250g / 500g / 10kg (R-A: each size is its OWN item, grouped under a parent,
-- not pack sizes of one pool); a look-alike pair that is really two products (Samyang Cheese / Samyang 4 Cheese) must be dismissible;
-- and a request for a name that is already waiting must be refused rather than queued twice.
--
-- SHAPE.
--   items.variant_of_item_id            nullable same-org FK to items; NOT itself; index. Trigger items_variant_guard (below).
--   item_requests.variant_of_item_id    nullable same-org FK to items (the requester's optional "variation of"; copied at approval).
--   item_requests_open_name_key         partial unique index (org, lower(name)) WHERE status = 'requested'. Existing duplicate open
--                                        requests are set to 'rejected' first (the later ones), so the index can be built; expected 0.
--   item_duplicate_dismissals           the pairs a super-admin said are different items. RLS + FORCE; SELECT, INSERT, DELETE (Undo).
-- items_org_id_id_unique already exists (0196), so no new unique on items is needed.
--
-- THE TRIGGER (items_variant_guard), BEFORE INSERT OR UPDATE OF variant_of_item_id, kind, status ON items. One definition of the rules,
-- in the database (RULES 6.3); the domain mirrors them only to speak in plain words:
--   1. one level   - the parent has no parent of its own, and an item that HAS variations cannot become a variation;
--   2. the parent is not 'merged' (an inactive parent is allowed: retiring a family header must not orphan anything);
--   3. same kind as the parent;
--   4. a parent cannot change kind, or become 'merged', while it still has variations.
-- Refusal: ERRCODE 23514, CONSTRAINT items_variant_guard (apps/erp/src/lib/constraint-messages.ts).
--
-- No existing item row is read or changed (the new column is NULL everywhere). Grants: SELECT, INSERT, DELETE on the new table only.

ALTER TABLE "items" ADD COLUMN "variant_of_item_id" uuid;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_variant_of_same_org_fk" FOREIGN KEY ("org_id", "variant_of_item_id") REFERENCES "public"."items"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_variant_not_self_check" CHECK ("variant_of_item_id" IS NULL OR "variant_of_item_id" <> "id");
--> statement-breakpoint
CREATE INDEX "items_variant_of_idx" ON "items" ("variant_of_item_id") WHERE "variant_of_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "items_check_variant_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	parent_row RECORD;
BEGIN
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
--> statement-breakpoint
CREATE TRIGGER "items_variant_guard" BEFORE INSERT OR UPDATE OF "variant_of_item_id", "kind", "status" ON "items"
	FOR EACH ROW EXECUTE FUNCTION "items_check_variant_guard"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- item_requests: the optional parent, and the open-name backstop
ALTER TABLE "item_requests" ADD COLUMN "variant_of_item_id" uuid;
--> statement-breakpoint
ALTER TABLE "item_requests" ADD CONSTRAINT "item_requests_variant_of_same_org_fk" FOREIGN KEY ("org_id", "variant_of_item_id") REFERENCES "public"."items"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Existing duplicate OPEN requests (same org, same name ignoring case): keep the earliest, reject the rest so the unique index can be
-- built. A decision is a three-part fact (item_requests_decision_shape_check), so the rejected one names its own requester and now().
-- Expected 0 rows; the build agent counted them on the scratch and dev databases (docs/tasks/443 hand-back).
UPDATE "item_requests" r
SET "status" = 'rejected', "decided_by" = r."requested_by", "decided_at" = now(),
    "decision_note" = 'T-443: duplicate of an earlier open request'
WHERE r."status" = 'requested'
  AND EXISTS (
    SELECT 1 FROM "item_requests" e
    WHERE e."org_id" = r."org_id" AND e."status" = 'requested' AND lower(e."name") = lower(r."name")
      AND (e."requested_at", e."id") < (r."requested_at", r."id")
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "item_requests_open_name_key" ON "item_requests" ("org_id", lower("name")) WHERE "status" = 'requested';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- item_duplicate_dismissals
CREATE TABLE "item_duplicate_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_a_id" uuid NOT NULL,
	"item_b_id" uuid NOT NULL,
	"note" text,
	"dismissed_by" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_duplicate_dismissals_order_check" CHECK ("item_a_id" < "item_b_id")
);
--> statement-breakpoint
ALTER TABLE "item_duplicate_dismissals" ADD CONSTRAINT "item_duplicate_dismissals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_duplicate_dismissals" ADD CONSTRAINT "item_duplicate_dismissals_item_a_same_org_fk" FOREIGN KEY ("org_id", "item_a_id") REFERENCES "public"."items"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_duplicate_dismissals" ADD CONSTRAINT "item_duplicate_dismissals_item_b_same_org_fk" FOREIGN KEY ("org_id", "item_b_id") REFERENCES "public"."items"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_duplicate_dismissals" ADD CONSTRAINT "item_duplicate_dismissals_dismissed_by_same_org_fk" FOREIGN KEY ("org_id", "dismissed_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "item_duplicate_dismissals_pair_key" ON "item_duplicate_dismissals" ("org_id", "item_a_id", "item_b_id");
--> statement-breakpoint
ALTER TABLE "item_duplicate_dismissals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_duplicate_dismissals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "item_duplicate_dismissals_org_isolation" ON "item_duplicate_dismissals"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "item_duplicate_dismissals" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "item_duplicate_dismissals" TO "shareat_app";
