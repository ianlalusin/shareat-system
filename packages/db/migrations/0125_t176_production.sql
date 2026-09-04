-- 0125 — T-176: production — slab -> slice, recipe -> batch, and the payroll lock.
-- docs/tasks/176-production-and-prep-conversion.md
--
-- HAND-WRITTEN, per DEF-073/DEF-121 (this repo's drizzle-kit snapshot chain is stale since
-- ~migration 0020; every migration since has been hand-written from schema.ts). Never edited
-- after apply.
--
-- ⭐ A `slice`/`cook` record posts ONE journal entry and one set of movements (invariant 1).
-- ⭐ A `convert` record posts NO journal entry (invariant 5) — enforced below as a CHECK, not a
--    convention: `production_records_convert_no_journal_check`.
-- ⭐ Invariants 6 and 7 are database-level refusals on `items`, not application checks — see the
--    two trigger functions at the bottom of the `items` section.

-- ---------------------------------------------------------------------------------------------
-- items: parent_slab_item_id — a sliced product's source slab (§6's contract).
-- ⚠️ Self-referencing FK, declared BARE in schema.ts (no `.references()`) — same convention as
-- `items.merged_into_id` on the same table. The FK and CHECK are added here, in the migration.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "items" ADD COLUMN "parent_slab_item_id" uuid;--> statement-breakpoint

ALTER TABLE "items" ADD CONSTRAINT "items_parent_slab_item_id_items_id_fk"
	FOREIGN KEY ("parent_slab_item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⭐ Contract §6: `check (parent_slab_item_id is null or kind = 'meat_sliced')`.
ALTER TABLE "items" ADD CONSTRAINT "items_parent_slab_kind_check"
	CHECK ("parent_slab_item_id" IS NULL OR "kind" = 'meat_sliced');--> statement-breakpoint

CREATE INDEX "items_parent_slab_item_idx" ON "items" ("parent_slab_item_id")
	WHERE "parent_slab_item_id" IS NOT NULL;--> statement-breakpoint

-- ⭐ Invariant 6: an item's `kind` may not change AWAY FROM `meat_slab` while any item names it as
-- `parent_slab_item_id`. A database-level refusal (T-176 §8 invariant 6), never a warning.
CREATE OR REPLACE FUNCTION items_block_slab_recategorise() RETURNS trigger AS $$
BEGIN
	IF OLD."kind" = 'meat_slab' AND NEW."kind" <> 'meat_slab' THEN
		IF EXISTS (SELECT 1 FROM "items" WHERE "parent_slab_item_id" = OLD."id") THEN
			RAISE EXCEPTION 'items: cannot change kind of item % away from meat_slab while a sliced child names it as parent_slab_item_id (T-176 invariant 6)', OLD."id";
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER items_block_slab_recategorise_trg
	BEFORE UPDATE ON "items"
	FOR EACH ROW
	WHEN (OLD."kind" IS DISTINCT FROM NEW."kind")
	EXECUTE FUNCTION items_block_slab_recategorise();--> statement-breakpoint

-- ⭐ Invariant 7: a sliced child's `base_unit` must equal its parent slab's, and the parent must
-- actually BE a meat_slab (not merely non-null) — a plain CHECK cannot reach another row, so this
-- is a trigger, per this project's existing convention (bible row 104: the database enforces the
-- rule, not a second copy in TypeScript).
CREATE OR REPLACE FUNCTION items_check_parent_slab_unit() RETURNS trigger AS $$
DECLARE
	parent_kind text;
	parent_unit text;
BEGIN
	IF NEW."parent_slab_item_id" IS NOT NULL THEN
		SELECT "kind", "base_unit" INTO parent_kind, parent_unit FROM "items" WHERE "id" = NEW."parent_slab_item_id";
		IF parent_kind IS NULL THEN
			RAISE EXCEPTION 'items: parent_slab_item_id % does not exist', NEW."parent_slab_item_id";
		END IF;
		IF parent_kind <> 'meat_slab' THEN
			RAISE EXCEPTION 'items: parent_slab_item_id % is not a meat_slab (is %) (T-176 invariant 7)', NEW."parent_slab_item_id", parent_kind;
		END IF;
		IF parent_unit <> NEW."base_unit" THEN
			RAISE EXCEPTION 'items: sliced child % base_unit (%) must match its parent slab % base_unit (%) (T-176 invariant 7)', NEW."id", NEW."base_unit", NEW."parent_slab_item_id", parent_unit;
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER items_check_parent_slab_unit_trg
	BEFORE INSERT OR UPDATE ON "items"
	FOR EACH ROW
	EXECUTE FUNCTION items_check_parent_slab_unit();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- production_recipes / production_recipe_lines — the repeatable prep conversion. CONFIGURATION
-- (cutover: KEEP) — see classification.ts.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "production_recipes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"output_item_id" uuid NOT NULL,
	"output_quantity" numeric(14, 3) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "production_recipes_status_check" CHECK ("status" IN ('active','inactive')),
	CONSTRAINT "production_recipes_output_quantity_positive_check" CHECK ("output_quantity" > 0)
);--> statement-breakpoint

ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_output_item_id_items_id_fk"
	FOREIGN KEY ("output_item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "production_recipes_org_name_key" ON "production_recipes" ("org_id", lower("name"));--> statement-breakpoint
CREATE INDEX "production_recipes_org_idx" ON "production_recipes" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
CREATE TABLE "production_recipe_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_recipe_lines_quantity_positive_check" CHECK ("quantity" > 0)
);--> statement-breakpoint

ALTER TABLE "production_recipe_lines" ADD CONSTRAINT "production_recipe_lines_recipe_id_production_recipes_id_fk"
	FOREIGN KEY ("recipe_id") REFERENCES "production_recipes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "production_recipe_lines" ADD CONSTRAINT "production_recipe_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "production_recipe_lines_recipe_idx" ON "production_recipe_lines" ("recipe_id");--> statement-breakpoint
CREATE INDEX "production_recipe_lines_item_idx" ON "production_recipe_lines" ("item_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- production_records / production_record_lines — the posted conversion. OPERATIONAL (cutover:
-- PURGE) — see classification.ts. `revision` is the edit-in-place counter (invariant 8).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "production_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipe_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"produced_on" date NOT NULL,
	"soft_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labour_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_records_kind_check" CHECK ("kind" IN ('slice','cook','convert')),
	CONSTRAINT "production_records_status_check" CHECK ("status" IN ('draft','posted','void')),
	CONSTRAINT "production_records_revision_positive_check" CHECK ("revision" > 0),
	CONSTRAINT "production_records_labour_cost_non_negative_check" CHECK ("labour_cost" >= 0),
	CONSTRAINT "production_records_posted_shape_check"
		CHECK ("status" <> 'posted' OR ("posted_at" IS NOT NULL AND "posted_by" IS NOT NULL)),
	CONSTRAINT "production_records_void_shape_check"
		CHECK ("status" <> 'void' OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)),
	-- ⭐ Invariant 5, as a constraint: a `convert` record can never carry a journal entry.
	CONSTRAINT "production_records_convert_no_journal_check"
		CHECK ("kind" <> 'convert' OR "journal_entry_id" IS NULL)
);--> statement-breakpoint

ALTER TABLE "production_records" ADD CONSTRAINT "production_records_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_recipe_id_production_recipes_id_fk"
	FOREIGN KEY ("recipe_id") REFERENCES "production_recipes"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_journal_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_posted_by_persons_id_fk"
	FOREIGN KEY ("posted_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_voided_by_persons_id_fk"
	FOREIGN KEY ("voided_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "production_records_store_status_idx" ON "production_records" ("store_id", "status", "produced_on");--> statement-breakpoint
CREATE INDEX "production_records_org_idx" ON "production_records" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⚠️ `revision` mirrors the record's revision AT THE TIME this line was written — an edit inserts
-- NEW lines for the new revision rather than mutating the old ones, and `reversed_at` stamps the
-- old lines rather than deleting them (invariant 8: "the old legs remain visible and marked
-- reversed"). `movement_id` is null for a `convert` line's... no — a convert still moves stock
-- (invariant 5 is about the JOURNAL ENTRY only), so every posted line carries a movement.
CREATE TABLE "production_record_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"record_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	"movement_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_record_lines_direction_check" CHECK ("direction" IN ('in','out')),
	CONSTRAINT "production_record_lines_quantity_positive_check" CHECK ("quantity" > 0),
	CONSTRAINT "production_record_lines_revision_positive_check" CHECK ("revision" > 0)
);--> statement-breakpoint

ALTER TABLE "production_record_lines" ADD CONSTRAINT "production_record_lines_record_id_production_records_id_fk"
	FOREIGN KEY ("record_id") REFERENCES "production_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "production_record_lines" ADD CONSTRAINT "production_record_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "production_record_lines" ADD CONSTRAINT "production_record_lines_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "production_record_lines_record_idx" ON "production_record_lines" ("record_id");--> statement-breakpoint
CREATE INDEX "production_record_lines_item_idx" ON "production_record_lines" ("item_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE, as the tables are created (bible row 112).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "production_recipes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_recipes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_recipe_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_recipe_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_record_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_record_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "production_recipes_org_isolation" ON "production_recipes"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ⚠️ DERIVED scoping: production_recipe_lines carries no org_id of its own — reached only through
-- its recipe, same shape as stock_transfer_lines through stock_transfers.
CREATE POLICY "production_recipe_lines_org_isolation" ON "production_recipe_lines"
	USING (EXISTS (SELECT 1 FROM "production_recipes" r WHERE r."id" = "recipe_id" AND r."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "production_recipes" r WHERE r."id" = "recipe_id" AND r."org_id" = app_current_org()));--> statement-breakpoint

CREATE POLICY "production_records_org_isolation" ON "production_records"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

CREATE POLICY "production_record_lines_org_isolation" ON "production_record_lines"
	USING (EXISTS (SELECT 1 FROM "production_records" r WHERE r."id" = "record_id" AND r."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "production_records" r WHERE r."id" = "record_id" AND r."org_id" = app_current_org()));--> statement-breakpoint
