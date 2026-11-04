-- 0232 -- T-508 S1: kitchen stations and kitchen routes. docs/tasks/508-kitchen-stations-and-menu-to-pos.md R1 (two tables, store-scoped), R2 (route per item), R3 (retire, never delete).
--
-- WHY. The practice POS refused to open a table ("Package ... does not have a kitchen location assigned") because no screen in the ERP can say which kitchen cooks
-- which dish. Bible row 307 puts master data, kitchen routing included, in the ERP only. These two tables hold it: the stations of a store, and one route per menu item
-- per store. Nothing here reads or writes them yet (the repo is packages/db/src/repo/kitchen.ts; the screens and the projection are S2 and S3).
--
-- THE TWO RULES THE DATABASE KEEPS ON ITS OWN (no trigger, so no trigger-registry row):
--   * same store: kitchen_routes_station_same_store_active_fk is FOREIGN KEY (store_id, station_id, station_status) -> kitchen_stations (store_id, id, status).
--     A route can only name a station of its own store.
--   * retire never strands a route (R3): station_status is pinned to 'active' by a CHECK, and the FK above is ON UPDATE NO ACTION, so setting a station to 'retired'
--     while any route still names it fails with 23503. The same FK means a route can never be created against a retired station. The repo counts the routes first
--     and says how many; this is the backstop.
-- station_id has no single-column FK and no (org_id, station_id) twin: the three-column FK above carries store, org (through stores) and status, and a twin would
-- break the generic same-org census, which re-points a column at a station of another store.
-- Also: same-org composite twins on every store / person / menu item reference (the DEF-491 census), case-insensitive unique ACTIVE name per store, SLA 1-240.
--
-- RLS (0011 / 0196 pattern): ENABLE + FORCE, one policy per table through app_current_org(), never raw current_setting (DEF-077). Store scoping is the repo's filter
-- plus the composite FKs; the policy is the org backstop, as for the menu tables.
-- GRANTS (ADR-012 s5 4a): shareat_app gets SELECT, INSERT and a COLUMN-LEVEL UPDATE (name, sort_order, sla_minutes, print_on_outage, status, updated_at; never store_id/org_id) on kitchen_stations, and SELECT, INSERT, DELETE plus UPDATE (station_id, updated_at) on kitchen_routes
-- (setRoute upserts with ON CONFLICT DO UPDATE; clearRoute deletes). Stations are never deleted, so no DELETE on them.
--
-- LOCK BUDGET. Two new empty tables; the only statements touching an existing table are the CREATE of FKs (a brief SHARE ROW EXCLUSIVE on stores, persons, menu_items;
-- no rows are scanned in the existing tables). First statement SET LOCAL lock_timeout = '5s' (resets at commit). No rewrite, no backfill.
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE "kitchen_stations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"sla_minutes" integer DEFAULT 10 NOT NULL,
	"print_on_outage" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "kitchen_stations_store_id_id_status_unique" UNIQUE ("store_id","id","status"),
	CONSTRAINT "kitchen_stations_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "kitchen_stations_status_check" CHECK ("status" in ('active','retired')),
	CONSTRAINT "kitchen_stations_sla_minutes_check" CHECK ("sla_minutes" between 1 and 240)
);
--> statement-breakpoint

CREATE TABLE "kitchen_routes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"station_status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "kitchen_routes_store_item_unique" UNIQUE ("store_id","menu_item_id"),
	CONSTRAINT "kitchen_routes_station_status_check" CHECK ("station_status" = 'active')
);
--> statement-breakpoint

ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_menu_item_id_fk"
	FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_menu_item_id_same_org_fk"
	FOREIGN KEY ("org_id","menu_item_id") REFERENCES "menu_items"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_station_same_store_active_fk"
	FOREIGN KEY ("store_id","station_id","station_status") REFERENCES "kitchen_stations"("store_id","id","status") ON DELETE RESTRICT ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" ADD CONSTRAINT "kitchen_routes_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint

CREATE UNIQUE INDEX "kitchen_stations_store_active_name_key" ON "kitchen_stations" ("store_id", lower("name")) WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "kitchen_stations_org_store_idx" ON "kitchen_stations" ("org_id","store_id");
--> statement-breakpoint
CREATE INDEX "kitchen_routes_station_idx" ON "kitchen_routes" ("station_id");
--> statement-breakpoint

ALTER TABLE "kitchen_stations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kitchen_stations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kitchen_routes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "kitchen_stations_org_isolation" ON "kitchen_stations"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "kitchen_routes_org_isolation" ON "kitchen_routes"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

GRANT SELECT, INSERT ON "kitchen_stations" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("name", "sort_order", "sla_minutes", "print_on_outage", "status", "updated_at") ON "kitchen_stations" TO "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "kitchen_routes" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("station_id", "updated_at") ON "kitchen_routes" TO "shareat_app";
