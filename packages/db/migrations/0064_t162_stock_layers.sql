-- 0064 — T-162: FIFO cost layers, and the inventory subledger.
--
-- HAND-WRITTEN, like 0020-0063. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ Bible row 110 chose FIFO on physical grounds — food is perishable and actually moves
-- first-in-first-out — and ADR-009 then found that a delivery ALREADY IS a layer: quantity, unit
-- cost, one receipt. This maps v1's shape rather than replacing it.
--
-- ⚠️ TWO GRAINS, and confusing them is the trap this file exists to prevent:
--   a LAYER is per item per STORE; a MOVEMENT (0063) is per item per LOCATION.
-- Moving stock between two rooms of one store therefore consumes no layer and posts no cost.

-- ---------------------------------------------------------------------------------------------
-- 1. The layers.
CREATE TABLE "stock_layers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	-- The FIFO ordering key. Ties break by id, so the order is total and reproducible.
	"received_at" timestamp with time zone NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"remaining_quantity" numeric(14, 3) NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"is_provisional" boolean DEFAULT true NOT NULL,
	"invoice_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "stock_layers_quantity_positive_check" CHECK ("quantity" > 0),
	CONSTRAINT "stock_layers_unit_cost_non_negative_check" CHECK ("unit_cost" >= 0),
	CONSTRAINT "stock_layers_source_check" CHECK ("source" IN ('delivery','transfer_in','production','opening','count')),
	-- ⭐ A planner bug becomes a FAILED TRANSACTION rather than a wrong number.
	CONSTRAINT "stock_layers_remaining_within_bounds_check"
		CHECK ("remaining_quantity" >= 0 AND "remaining_quantity" <= "quantity"),
	-- `is_provisional` and `invoice_line_id` are two views of one fact and may not disagree.
	CONSTRAINT "stock_layers_provisional_matches_invoice_check"
		CHECK ("is_provisional" = ("invoice_line_id" IS NULL))
);--> statement-breakpoint

ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_invoice_line_id_supplier_invoice_lines_id_fk"
	FOREIGN KEY ("invoice_line_id") REFERENCES "supplier_invoice_lines"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- One layer per stock-in movement: a retried receipt cannot double the cost basis.
CREATE UNIQUE INDEX "stock_layers_movement_key" ON "stock_layers" ("movement_id");--> statement-breakpoint

-- The consumption query — open layers for an item in a store, oldest first.
CREATE INDEX "stock_layers_open_idx"
	ON "stock_layers" ("item_id", "store_id", "received_at") WHERE "remaining_quantity" > 0;--> statement-breakpoint
CREATE INDEX "stock_layers_org_idx" ON "stock_layers" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. The inventory subledger — which layer paid for which movement.
--
-- ⭐ Σ these rows is what the journal entry must equal, or invariant 6's inventory arm breaks.
-- That is why cost is rounded PER LINE and stored here: each row is real money at 2dp, and the
-- entry is what they sum to. Rounding the total instead would put the entry a centavo away from
-- its own detail.
CREATE TABLE "stock_layer_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"layer_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	-- SNAPSHOTTED. A cost used in a past transaction IS a fact (T-145's rule).
	"unit_cost" numeric(14, 4) NOT NULL,
	"cost" numeric(14, 2) NOT NULL,
	"reversed_by_movement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_layer_consumptions_quantity_positive_check" CHECK ("quantity" > 0)
);--> statement-breakpoint

ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_layer_id_stock_layers_id_fk"
	FOREIGN KEY ("layer_id") REFERENCES "stock_layers"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_reversed_by_stock_movements_id_fk"
	FOREIGN KEY ("reversed_by_movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- A retried consumption cannot double-relieve a layer.
CREATE UNIQUE INDEX "stock_layer_consumptions_layer_movement_key"
	ON "stock_layer_consumptions" ("layer_id", "movement_id");--> statement-breakpoint
CREATE INDEX "stock_layer_consumptions_movement_idx"
	ON "stock_layer_consumptions" ("movement_id");--> statement-breakpoint
-- T-179's query: what is still outstanding for a movement.
CREATE INDEX "stock_layer_consumptions_outstanding_idx"
	ON "stock_layer_consumptions" ("movement_id") WHERE "reversed_by_movement_id" IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. ⭐ The subledger ties to the layer — invariant 6's inventory arm, as a constraint.
--
-- Σ consumptions for a layer must equal (quantity − remaining_quantity). Without this the two
-- tables are free to disagree, and the disagreement is invisible: `remaining_quantity` looks
-- authoritative and the subledger looks complete, while only one of them is right.
--
-- ⚠️ DEFERRED to COMMIT, because a consumption is written and the layer decremented in the same
-- transaction and neither order should be forced on the caller.
--
-- ⛔ A REVERSED consumption is excluded from the sum: reversing gives quantity back to the layer,
-- so the row stops counting against it. That is what makes a void restore the layer exactly.
CREATE FUNCTION "stock_layers_subledger_ties"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	layer record;
	consumed numeric(14,3);
	target_layer uuid;
BEGIN
	target_layer := COALESCE(NEW."layer_id", OLD."layer_id");

	SELECT "quantity", "remaining_quantity" INTO layer
	FROM "stock_layers" WHERE "id" = target_layer;

	IF NOT FOUND THEN RETURN NULL; END IF;

	SELECT COALESCE(sum("quantity"), 0) INTO consumed
	FROM "stock_layer_consumptions"
	WHERE "layer_id" = target_layer AND "reversed_by_movement_id" IS NULL;

	IF layer."quantity" - layer."remaining_quantity" <> consumed THEN
		RAISE EXCEPTION 'layer % does not tie: quantity % minus remaining % is %, but its subledger sums to %',
			target_layer, layer."quantity", layer."remaining_quantity",
			layer."quantity" - layer."remaining_quantity", consumed;
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "stock_layer_consumptions_ties_trg"
	AFTER INSERT OR UPDATE ON "stock_layer_consumptions"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "stock_layers_subledger_ties"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. RLS — ENABLE and FORCE, as the tables are created (bible row 112).
ALTER TABLE "stock_layers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_layers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "stock_layers_org_isolation" ON "stock_layers"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "stock_layer_consumptions_org_isolation" ON "stock_layer_consumptions"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
