-- 0117 — T-167: stock transfers between two rooms of one store.
-- docs/tasks/167-stock-transfers.md
--
-- HAND-WRITTEN, per DEF-073/DEF-121 (this repo's drizzle-kit snapshot chain is stale since
-- ~migration 0020; every migration since has been hand-written from schema.ts). Never edited
-- after apply.
--
-- ⭐ A transfer posts NO journal entry and consumes NO layer (T-162 invariant 6: a layer is per
-- STORE, not per location). Two signed stock_movements rows are the whole effect.
--
-- ⭐ The composite FKs on from_location_id/to_location_id and stock_reservations.location_id are
-- what makes "this location belongs to this store" a database fact rather than an application
-- check — invariant 1's "both DB checks" requirement. They need stock_locations to carry a
-- UNIQUE (id, store_id), added first below, additively — 0062 itself is never edited.

ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_id_store_id_key" UNIQUE ("id", "store_id");--> statement-breakpoint

CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"dispatched_at" timestamp with time zone,
	"dispatched_by" uuid,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_locations_differ_check" CHECK ("from_location_id" <> "to_location_id"),
	CONSTRAINT "stock_transfers_mode_check" CHECK ("mode" IN ('immediate','two_step')),
	CONSTRAINT "stock_transfers_status_check" CHECK ("status" IN ('draft','in_transit','received','void')),
	-- ⭐ Invariant 4 as a constraint: `immediate` mode is never observed sitting `in_transit`.
	CONSTRAINT "stock_transfers_immediate_never_in_transit_check"
		CHECK ("mode" <> 'immediate' OR "status" IN ('received','void')),
	CONSTRAINT "stock_transfers_dispatched_shape_check"
		CHECK (("dispatched_at" IS NULL) = ("dispatched_by" IS NULL)),
	CONSTRAINT "stock_transfers_received_shape_check"
		CHECK (("received_at" IS NULL) = ("received_by" IS NULL)),
	-- ⭐ A transfer sitting `in_transit` or `received` must actually carry the timestamp that got
	-- it there — same shape as `deliveries_received_shape_check`.
	CONSTRAINT "stock_transfers_dispatched_when_in_transit_check"
		CHECK ("status" NOT IN ('in_transit','received') OR "dispatched_at" IS NOT NULL),
	CONSTRAINT "stock_transfers_received_when_received_check"
		CHECK ("status" <> 'received' OR "received_at" IS NOT NULL),
	CONSTRAINT "stock_transfers_void_shape_check"
		CHECK ("status" <> 'void' OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- ⭐ Composite FKs — see this file's header.
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_location_store_fk"
	FOREIGN KEY ("from_location_id", "store_id") REFERENCES "stock_locations"("id", "store_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_location_store_fk"
	FOREIGN KEY ("to_location_id", "store_id") REFERENCES "stock_locations"("id", "store_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dispatched_by_persons_id_fk"
	FOREIGN KEY ("dispatched_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_persons_id_fk"
	FOREIGN KEY ("received_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_voided_by_persons_id_fk"
	FOREIGN KEY ("voided_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "stock_transfers_store_status_idx" ON "stock_transfers" ("store_id", "status");--> statement-breakpoint
CREATE INDEX "stock_transfers_org_idx" ON "stock_transfers" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"line_no" text NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"out_movement_id" uuid,
	"in_movement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfer_lines_quantity_positive_check" CHECK ("quantity" > 0)
);--> statement-breakpoint

ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_stock_transfers_id_fk"
	FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_out_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("out_movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_in_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("in_movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "stock_transfer_lines_transfer_line_key" ON "stock_transfer_lines" ("transfer_id", "line_no");--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_item_idx" ON "stock_transfer_lines" ("item_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⭐ Destination-side, dispatch-set, receive-or-void-resolved. NEVER queried by onHand — invariant
-- 6: "in the truck" is a separate, visible number, never netted into on-hand.
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"transfer_id" uuid NOT NULL,
	-- Set once, by receive OR by void, never both. A second release is a no-op UPDATE
	-- (`WHERE released_at IS NULL`), not an error — see packages/db/src/repo/stock-transfers.ts.
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_reservations_quantity_positive_check" CHECK ("quantity" > 0)
);--> statement-breakpoint

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_location_store_fk"
	FOREIGN KEY ("location_id", "store_id") REFERENCES "stock_locations"("id", "store_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_transfer_id_stock_transfers_id_fk"
	FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⭐ At most one live reservation per (transfer, item) — the row invariant 5's "set exactly once"
-- rests on.
CREATE UNIQUE INDEX "stock_reservations_transfer_item_key" ON "stock_reservations" ("transfer_id", "item_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_item_location_idx" ON "stock_reservations" ("item_id", "location_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_org_idx" ON "stock_reservations" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE, as the tables are created (bible row 112).
ALTER TABLE "stock_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_transfers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "stock_transfers_org_isolation" ON "stock_transfers"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ⚠️ DERIVED scoping: stock_transfer_lines carries no org_id of its own — reached only through
-- its transfer, same shape as delivery_lines through deliveries.
CREATE POLICY "stock_transfer_lines_org_isolation" ON "stock_transfer_lines"
	USING (EXISTS (SELECT 1 FROM "stock_transfers" t WHERE t."id" = "transfer_id" AND t."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "stock_transfers" t WHERE t."id" = "transfer_id" AND t."org_id" = app_current_org()));--> statement-breakpoint

CREATE POLICY "stock_reservations_org_isolation" ON "stock_reservations"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
