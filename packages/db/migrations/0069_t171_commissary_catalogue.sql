-- 0069 — T-171: the commissary catalogue and the cross-store item map.
--
-- HAND-WRITTEN, like 0020-0068. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ Most of T-171 was already built. T-145 gave ONE org-level items table, T-149 per-store
-- sellability, T-151 the pricing with a basis DERIVED from invoice history rather than stored —
-- which is the fix for the bug that froze a chopstick branch price at ₱1,458 instead of ₱1.46 and
-- could not self-heal because the `max(prior, new)` rule made the poison sticky.
--
-- ⛔ So there is NO `commissary_item_config` table here. v1 has one per store holding pricing mode
-- and a rolling lastReceivedCost; recreating it would be a per-store item master by another name,
-- which is how v1 ended up with 842 item records for 385 real products.

CREATE TABLE "commissary_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"commissary_store_id" uuid NOT NULL,
	"branch_store_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commissary_links_status_check" CHECK ("status" IN ('active','inactive')),
	CONSTRAINT "commissary_links_not_self_check" CHECK ("commissary_store_id" <> "branch_store_id")
);--> statement-breakpoint

ALTER TABLE "commissary_links" ADD CONSTRAINT "commissary_links_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_links" ADD CONSTRAINT "commissary_links_commissary_store_id_stores_id_fk"
	FOREIGN KEY ("commissary_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_links" ADD CONSTRAINT "commissary_links_branch_store_id_stores_id_fk"
	FOREIGN KEY ("branch_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_links" ADD CONSTRAINT "commissary_links_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "commissary_links_pair_key" ON "commissary_links" ("commissary_store_id", "branch_store_id");--> statement-breakpoint
CREATE INDEX "commissary_links_branch_idx" ON "commissary_links" ("branch_store_id", "status");--> statement-breakpoint

CREATE TABLE "commissary_item_offerings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"commissary_store_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	-- ⭐ Tier 3 of the basis fallback: a slab link first, then the item's own landed history, then
	-- this. ⛔ Nothing prices at a silent zero — with all three empty the catalogue line comes back
	-- unpriced and the order form refuses it. A ₱0 line becomes a ₱0 order becomes a ₱0
	-- receivable, and nobody notices until the month closes.
	"manual_cost" numeric(14, 4),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "commissary_item_offerings_status_check" CHECK ("status" IN ('active','inactive')),
	CONSTRAINT "commissary_item_offerings_manual_cost_check" CHECK ("manual_cost" IS NULL OR "manual_cost" >= 0)
);--> statement-breakpoint

ALTER TABLE "commissary_item_offerings" ADD CONSTRAINT "commissary_item_offerings_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" ADD CONSTRAINT "commissary_item_offerings_store_id_stores_id_fk"
	FOREIGN KEY ("commissary_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" ADD CONSTRAINT "commissary_item_offerings_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" ADD CONSTRAINT "commissary_item_offerings_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "commissary_item_offerings_key" ON "commissary_item_offerings" ("commissary_store_id", "item_id");--> statement-breakpoint
CREATE INDEX "commissary_item_offerings_org_idx" ON "commissary_item_offerings" ("org_id");--> statement-breakpoint

CREATE TABLE "commissary_item_map" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"commissary_store_id" uuid NOT NULL,
	"branch_store_id" uuid NOT NULL,
	"commissary_item_id" uuid NOT NULL,
	-- ⛔ NOT NULL, unlike v1. v1 allows null with TWO different meanings — "not mapped yet" and
	-- "deliberately ledger-only" — which 01-data-model.md:245 already flags as a hazard. The
	-- deliberate decision gets its own column; an overloaded null is not a decision, it is two
	-- decisions nobody can tell apart.
	"branch_item_id" uuid NOT NULL,
	"is_ledger_only" boolean DEFAULT false NOT NULL,
	-- ⭐ The SAME resolved category gates order submit and the receipt posting. v1 carries
	-- `hasFullCategory` for exactly this, shared by the submit block and the auto-book test; had
	-- they drifted, an order could pass submit while its lines were invisible to booking — the
	-- ₱12,184.71 failure by a second route.
	"expense_category_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commissary_item_map_not_self_check" CHECK ("commissary_store_id" <> "branch_store_id")
);--> statement-breakpoint

ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_commissary_store_id_stores_id_fk"
	FOREIGN KEY ("commissary_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_branch_store_id_stores_id_fk"
	FOREIGN KEY ("branch_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_commissary_item_id_items_id_fk"
	FOREIGN KEY ("commissary_item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_branch_item_id_items_id_fk"
	FOREIGN KEY ("branch_item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_expense_category_id_fk"
	FOREIGN KEY ("expense_category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commissary_item_map" ADD CONSTRAINT "commissary_item_map_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "commissary_item_map_key"
	ON "commissary_item_map" ("commissary_store_id", "branch_store_id", "commissary_item_id");--> statement-breakpoint
CREATE INDEX "commissary_item_map_branch_idx" ON "commissary_item_map" ("branch_store_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE (bible row 112).
ALTER TABLE "commissary_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commissary_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commissary_item_map" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commissary_item_map" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "commissary_links_org_isolation" ON "commissary_links"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "commissary_item_offerings_org_isolation" ON "commissary_item_offerings"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "commissary_item_map_org_isolation" ON "commissary_item_map"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
