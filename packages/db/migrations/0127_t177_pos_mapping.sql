-- 0127 — T-177: POS item mapping and the daily usage pull.
-- docs/tasks/177-pos-item-mapping-and-usage-pull.md
--
-- HAND-WRITTEN, per DEF-073/DEF-121. Never edited after apply.
--
-- ⭐ Two additions beyond the task doc's own contract table — see packages/db/schema/pos-mapping.ts's
-- header for the full reasoning: `location_id` (both tables) and the three `*_finalized_at`
-- columns on `pos_usage_pulls`, plus a `where status <> 'void'` uniqueness rather than the literal
-- `where status = 'planned'` invariant 12 states.

-- ---------------------------------------------------------------------------------------------
-- pos_item_maps — CONFIGURATION (cutover: KEEP). See classification.ts.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "pos_item_maps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pos_item_key" text NOT NULL,
	"pos_item_name" text NOT NULL,
	"mode" text NOT NULL,
	"item_id" uuid,
	"recipe_id" uuid,
	"quantity_per_sale" numeric(14, 6),
	"location_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "pos_item_maps_mode_check" CHECK ("mode" IN ('direct','recipe','no_stock')),
	CONSTRAINT "pos_item_maps_status_check" CHECK ("status" IN ('active','inactive')),
	CONSTRAINT "pos_item_maps_pos_item_key_not_blank_check" CHECK (length(trim("pos_item_key")) > 0),
	CONSTRAINT "pos_item_maps_mode_shape_check" CHECK (
		("mode" = 'direct' AND "item_id" IS NOT NULL AND "quantity_per_sale" IS NOT NULL)
		OR ("mode" = 'recipe' AND "recipe_id" IS NOT NULL)
		OR ("mode" = 'no_stock' AND "item_id" IS NULL AND "recipe_id" IS NULL)
	),
	CONSTRAINT "pos_item_maps_quantity_per_sale_positive_check" CHECK ("quantity_per_sale" IS NULL OR "quantity_per_sale" > 0)
);--> statement-breakpoint

ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_recipe_id_production_recipes_id_fk"
	FOREIGN KEY ("recipe_id") REFERENCES "production_recipes"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "pos_item_maps_store_key_active_key" ON "pos_item_maps" ("store_id", "pos_item_key")
	WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "pos_item_maps_org_idx" ON "pos_item_maps" ("org_id");--> statement-breakpoint
CREATE INDEX "pos_item_maps_item_idx" ON "pos_item_maps" ("item_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- pos_map_requests — "this can't be mapped" -> manager decision. CONFIGURATION (cutover: KEEP).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "pos_map_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pos_item_key" text NOT NULL,
	"pos_item_name" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "pos_map_requests_status_check" CHECK ("status" IN ('requested','approved','rejected')),
	CONSTRAINT "pos_map_requests_decided_shape_check"
		CHECK ("status" = 'requested' OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "pos_map_requests" ADD CONSTRAINT "pos_map_requests_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_map_requests" ADD CONSTRAINT "pos_map_requests_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_map_requests" ADD CONSTRAINT "pos_map_requests_requested_by_persons_id_fk"
	FOREIGN KEY ("requested_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_map_requests" ADD CONSTRAINT "pos_map_requests_decided_by_persons_id_fk"
	FOREIGN KEY ("decided_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "pos_map_requests_store_key_requested_key" ON "pos_map_requests" ("store_id", "pos_item_key")
	WHERE "status" = 'requested';--> statement-breakpoint
CREATE INDEX "pos_map_requests_org_status_idx" ON "pos_map_requests" ("org_id", "status");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- pos_usage_pulls / pos_usage_pull_lines — OPERATIONAL (cutover: PURGE).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "pos_usage_pulls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"sales_day_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"snapshot_taken_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"direct_finalized_at" timestamp with time zone,
	"recipe_finalized_at" timestamp with time zone,
	"orphan_finalized_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"finalized_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_usage_pulls_status_check" CHECK ("status" IN ('planned','finalized','void')),
	CONSTRAINT "pos_usage_pulls_finalized_shape_check"
		CHECK ("status" <> 'finalized' OR ("finalized_at" IS NOT NULL AND "finalized_by" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_sales_day_id_sales_days_id_fk"
	FOREIGN KEY ("sales_day_id") REFERENCES "sales_days"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_finalized_by_persons_id_fk"
	FOREIGN KEY ("finalized_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⚠️ `WHERE status <> 'void'` — stricter than invariant 12's literal wording. See this file's
-- header and pos-mapping.ts's header comment.
CREATE UNIQUE INDEX "pos_usage_pulls_store_day_live_key" ON "pos_usage_pulls" ("store_id", "sales_day_id")
	WHERE "status" <> 'void';--> statement-breakpoint
CREATE INDEX "pos_usage_pulls_store_status_idx" ON "pos_usage_pulls" ("store_id", "status");--> statement-breakpoint
CREATE INDEX "pos_usage_pulls_org_idx" ON "pos_usage_pulls" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
CREATE TABLE "pos_usage_pull_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"pull_id" uuid NOT NULL,
	"section" text NOT NULL,
	"line_key" text NOT NULL,
	"pos_item_key" text NOT NULL,
	"pos_item_name" text NOT NULL,
	"item_id" uuid,
	"location_id" uuid,
	"quantity" numeric(14, 3),
	"usage_record_id" uuid,
	"blocked" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_usage_pull_lines_section_check" CHECK ("section" IN ('direct','recipe','orphan')),
	CONSTRAINT "pos_usage_pull_lines_quantity_positive_check" CHECK ("quantity" IS NULL OR "quantity" > 0)
);--> statement-breakpoint

ALTER TABLE "pos_usage_pull_lines" ADD CONSTRAINT "pos_usage_pull_lines_pull_id_pos_usage_pulls_id_fk"
	FOREIGN KEY ("pull_id") REFERENCES "pos_usage_pulls"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" ADD CONSTRAINT "pos_usage_pull_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" ADD CONSTRAINT "pos_usage_pull_lines_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" ADD CONSTRAINT "pos_usage_pull_lines_usage_record_id_stock_usage_records_id_fk"
	FOREIGN KEY ("usage_record_id") REFERENCES "stock_usage_records"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "pos_usage_pull_lines_pull_key_key" ON "pos_usage_pull_lines" ("pull_id", "line_key");--> statement-breakpoint
CREATE INDEX "pos_usage_pull_lines_pull_section_idx" ON "pos_usage_pull_lines" ("pull_id", "section");--> statement-breakpoint
CREATE INDEX "pos_usage_pull_lines_item_idx" ON "pos_usage_pull_lines" ("item_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE, as the tables are created (bible row 112).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "pos_item_maps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_item_maps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_map_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_map_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "pos_item_maps_org_isolation" ON "pos_item_maps"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

CREATE POLICY "pos_map_requests_org_isolation" ON "pos_map_requests"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

CREATE POLICY "pos_usage_pulls_org_isolation" ON "pos_usage_pulls"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ⚠️ DERIVED scoping: pos_usage_pull_lines carries no org_id of its own — reached only through its
-- pull, same shape as production_record_lines through production_records.
CREATE POLICY "pos_usage_pull_lines_org_isolation" ON "pos_usage_pull_lines"
	USING (EXISTS (SELECT 1 FROM "pos_usage_pulls" p WHERE p."id" = "pull_id" AND p."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "pos_usage_pulls" p WHERE p."id" = "pull_id" AND p."org_id" = app_current_org()));--> statement-breakpoint
