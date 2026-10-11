-- 0193 - T-391 S1: an item-level buying unit, and the v1 -> v2 master-data link table.
-- docs/tasks/391-production-master-data-load.md (Migration).
--
--   1. items.purchase_unit / purchase_factor - a DEFAULT buying unit and its ratio to the base unit
--      (box of 24 pcs = 'box' / 24). Both or neither. Invoice and delivery lines still snapshot their own factor.
--   2. v1_master_links - one row per v1 record the load has created or matched: (org, entity, v1 store, v1 id) -> v2 id.
--      org_column table; SELECT and INSERT only (a link is a fact about the load: no UPDATE, no DELETE).
--
-- Hand-authored per ADR-012 section 5 - db:generate is retired (DEF-242).
--
-- READ ONLY production precheck (run before applying; this migration is additive and needs no data change):
--   select count(*) from information_schema.columns
--     where table_name = 'items' and column_name in ('purchase_unit', 'purchase_factor');   -- expected 0
--   select to_regclass('v1_master_links');                                                  -- expected NULL
--   select count(*) from pg_constraint
--     where conname in ('items_purchase_pair_check', 'items_purchase_unit_check', 'items_purchase_factor_check');  -- expected 0
-- Existing rows get NULL / NULL, which satisfies every new CHECK, so the ADD CONSTRAINTs cannot fail on live data.

ALTER TABLE "items" ADD COLUMN "purchase_unit" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "purchase_factor" numeric(14,6);--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_purchase_pair_check"
	CHECK (("purchase_unit" IS NULL) = ("purchase_factor" IS NULL));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_purchase_unit_check"
	CHECK ("purchase_unit" IS NULL OR ("purchase_unit" in ('pcs','kg','g','ltr','ml','roll','box','pack','case','sack','tray','dozen')
	       AND "purchase_unit" <> "base_unit"));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_purchase_factor_check"
	CHECK ("purchase_factor" IS NULL OR ("purchase_factor" > 0 AND "purchase_factor" < 'Infinity'::numeric));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_purchase_factor_finite_check"
	CHECK ("purchase_factor" > '-Infinity'::numeric and "purchase_factor" < 'Infinity'::numeric);--> statement-breakpoint

CREATE TABLE "v1_master_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"v1_store_id" text NOT NULL,
	"v1_id" text NOT NULL,
	"v2_id" uuid NOT NULL,
	"v1_unit" text,
	"factor_to_base" numeric(14,6),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v1_master_links_entity_check" CHECK ("entity" in ('item','supplier','customer','person','employment','position')),
	CONSTRAINT "v1_master_links_v1_id_not_blank_check" CHECK (btrim("v1_id") <> ''),
	CONSTRAINT "v1_master_links_factor_to_base_finite_check" CHECK ("factor_to_base" > '-Infinity'::numeric and "factor_to_base" < 'Infinity'::numeric),
	CONSTRAINT "v1_master_links_item_factor_check" CHECK (
		("entity" = 'item' AND "factor_to_base" IS NOT NULL AND "factor_to_base" > 0 AND "factor_to_base" < 'Infinity'::numeric AND "v1_unit" IS NOT NULL)
		OR ("entity" <> 'item' AND "factor_to_base" IS NULL AND "v1_unit" IS NULL))
);--> statement-breakpoint

ALTER TABLE "v1_master_links" ADD CONSTRAINT "v1_master_links_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "v1_master_links" ADD CONSTRAINT "v1_master_links_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "v1_master_links_key" ON "v1_master_links" ("org_id","entity","v1_store_id","v1_id");--> statement-breakpoint
CREATE INDEX "v1_master_links_v2_idx" ON "v1_master_links" ("org_id","entity","v2_id");--> statement-breakpoint

ALTER TABLE "v1_master_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "v1_master_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "v1_master_links_org_isolation" ON "v1_master_links"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

GRANT SELECT, INSERT ON "v1_master_links" TO "shareat_app";
