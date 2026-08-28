-- 0047 — T-145: the item master, supplier invoice lines, and the FK T-129 promised.
-- docs/tasks/145-item-master-and-invoice-lines.md.
--
-- HAND-WRITTEN, like 0020-0046. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ WHY THIS EXISTS. Ian, 2026-08-28: "yes, i want to track item prices over time." That is
-- impossible on either system's current shape, and the reason is identity, not storage. Measured
-- in v1's live data: 842 item records across six stores but only 385 distinct NAMES — 187 of them
-- existing in more than one store as separate documents with separate ids, separate costs, and
-- sometimes separate units (`white onion` is ₱61/kg at Lipa, ₱130/kg at Malvar, and priced in
-- PCS at Padre Garcia). There is nothing to group a price question by.
--
-- ⛔ AND THERE IS NO PRICE HISTORY IN v1 TO PRESERVE. `costPerUnit` is a single overwritten
-- snapshot and is ZERO on 595 of 842 items (71%); `inventoryLedger` records quantity movements
-- with no cost field at all. This is new capability, not a port — unusual for this project, and
-- worth stating so nobody hunts for a v1 behaviour to duplicate.
--
-- ⭐ `price_list_items.item_code` has carried the comment "⛔ This becomes a foreign key the day
-- an item master lands" since T-129. This is that day.

CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	-- ⭐ ORG-level, not per store. v1's per-store items are precisely why the same product exists
	-- as five unrelated records; a price question spanning stores needs ONE row to group by.
	"code" text NOT NULL,
	"name" text NOT NULL,
	-- The business's own vocabulary, taken from live data: raw_material 340, supply 207,
	-- retail 234, meat_slab 17, meat_sliced 44. The meat split is real, not decorative.
	"kind" text NOT NULL,
	-- ⛔ A UNIT OF MEASURE, never a container. v1 has 33 items whose baseUnit is `box` or `pack`,
	-- which is a modelling error: a box is a quantity of something. Containers are PURCHASE units
	-- and live on the invoice line with a factor converting them to this.
	"base_unit" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "items_code_not_blank_check" CHECK (length(trim("code")) > 0),
	CONSTRAINT "items_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "items_kind_check" CHECK ("kind" in ('raw_material','supply','retail','meat_slab','meat_sliced')),
	CONSTRAINT "items_base_unit_check" CHECK ("base_unit" in ('pcs','kg','g','ltr','ml','roll')),
	CONSTRAINT "items_status_check" CHECK ("status" in ('active','inactive'))
);
--> statement-breakpoint

CREATE TABLE "supplier_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" uuid NOT NULL,
	-- What the supplier called it, verbatim. Kept because the paper says what the paper says, and
	-- a rename of the item must not rewrite what was on a past bill.
	"description" text,
	"quantity" numeric(14, 3) NOT NULL,
	-- The unit the supplier actually billed in — may be a container.
	"purchase_unit" text NOT NULL,
	-- ⭐ SNAPSHOTTED, never looked up later. THE most important column in this migration. If the
	-- factor lived only on the item and a price query joined to it, correcting a pack size next
	-- year would silently rewrite what we paid last year. A balance is a consequence of facts and
	-- must be recomputed; a conversion used in a past transaction IS a fact and belongs on the row.
	"conversion_factor" numeric(14, 6) NOT NULL,
	-- Per PURCHASE unit, as billed. ₱/kg is derived, never typed.
	"unit_price" numeric(14, 4) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	CONSTRAINT "supplier_invoice_lines_quantity_positive_check" CHECK ("quantity" > 0),
	CONSTRAINT "supplier_invoice_lines_conversion_positive_check" CHECK ("conversion_factor" > 0),
	CONSTRAINT "supplier_invoice_lines_unit_price_not_negative_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "supplier_invoice_lines_total_not_negative_check" CHECK ("line_total" >= 0),
	CONSTRAINT "supplier_invoice_lines_purchase_unit_check" CHECK (
		"purchase_unit" in ('pcs','kg','g','ltr','ml','roll','box','pack','case','sack','tray','dozen')
	),
	-- ⭐ The line must be arithmetic. A line whose parts do not make its total is a typo that would
	-- otherwise become a price observation.
	CONSTRAINT "supplier_invoice_lines_arithmetic_check" CHECK (
		abs(round("quantity" * "unit_price", 2) - "line_total") <= 0.01
	)
);
--> statement-breakpoint

ALTER TABLE "items" ADD CONSTRAINT "items_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

-- CASCADE is deliberate: a line is genuinely part of its invoice, not an independent record that
-- could outlive it (same reasoning as price_list_items -> price_lists, bible §4.2 rule 3).
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_invoice_id_fk"
	FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "items_org_code_key" ON "items" USING btree ("org_id","code");--> statement-breakpoint
-- ⛔ "Pork Belly" and "pork belly" are ONE thing. Case-insensitive, because the 187 duplicate
-- names in v1 are exactly how a price chart stops summing.
CREATE UNIQUE INDEX "items_org_name_key" ON "items" USING btree ("org_id", lower("name"));--> statement-breakpoint
CREATE INDEX "items_org_status_idx" ON "items" USING btree ("org_id","status");--> statement-breakpoint

CREATE UNIQUE INDEX "supplier_invoice_lines_invoice_line_key" ON "supplier_invoice_lines" USING btree ("supplier_invoice_id","line_no");--> statement-breakpoint
-- The price-history query's own index: every line for one item, oldest first.
CREATE INDEX "supplier_invoice_lines_item_idx" ON "supplier_invoice_lines" USING btree ("item_id");--> statement-breakpoint

-- ===========================================================================================
-- Row-level security. `app_current_org()`, never a raw current_setting cast — DEF-077, closed
-- earlier today in migration 0044.
-- ===========================================================================================
ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "items_org_isolation" ON "items"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- No org_id of its own — reachable only through the invoice it belongs to, same pattern as
-- expense_payments through expenses and ap_payment_allocations through ap_payments.
ALTER TABLE "supplier_invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "supplier_invoice_lines_via_invoice" ON "supplier_invoice_lines" FOR ALL
	USING (EXISTS (SELECT 1 FROM "supplier_invoices" si WHERE si."id" = "supplier_invoice_lines"."supplier_invoice_id" AND si."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "supplier_invoices" si WHERE si."id" = "supplier_invoice_lines"."supplier_invoice_id" AND si."org_id" = app_current_org()));--> statement-breakpoint

-- ===========================================================================================
-- price_list_items.item_code -> item_id. The FK T-129 promised in that column's own comment.
--
-- BACKFILL FIRST, then constrain — the same shape as 0043's supplier backfill. Any existing
-- item_code becomes a real `items` row so no price list loses its rates. Written as a loop over
-- whatever rows exist, and unlike 0043's comment this one genuinely handles every case: there is
-- no NULL branch to miss, because item_code is NOT NULL.
-- ===========================================================================================
ALTER TABLE "price_list_items" ADD COLUMN "item_id" uuid;--> statement-breakpoint

DO $$
DECLARE
	r RECORD;
	new_item_id uuid;
	creator uuid;
BEGIN
	FOR r IN
		SELECT DISTINCT pli.org_id, pli.item_code, pli.item_name, pli.unit
		FROM price_list_items pli
	LOOP
		SELECT id INTO creator FROM persons WHERE org_id = r.org_id ORDER BY created_at LIMIT 1;
		IF creator IS NULL THEN
			RAISE EXCEPTION 'price_list_items backfill: org % has no persons row to attribute the item to', r.org_id;
		END IF;

		SELECT id INTO new_item_id FROM items
			WHERE org_id = r.org_id AND lower(name) = lower(coalesce(r.item_name, r.item_code));

		IF new_item_id IS NULL THEN
			INSERT INTO items (org_id, code, name, kind, base_unit, status, notes, created_by)
			VALUES (
				r.org_id, r.item_code, coalesce(r.item_name, r.item_code),
				'raw_material',
				-- The price list's own unit when it is a real unit of measure; `pcs` otherwise.
				-- A container is not a base unit (see items_base_unit_check).
				CASE WHEN r.unit IN ('pcs','kg','g','ltr','ml','roll') THEN r.unit ELSE 'pcs' END,
				'active',
				'Auto-created by migration 0047 from a price list rate that predates the item master.',
				creator
			)
			RETURNING id INTO new_item_id;
		END IF;

		UPDATE price_list_items SET item_id = new_item_id
		WHERE org_id = r.org_id AND item_code = r.item_code;
	END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE "price_list_items" ALTER COLUMN "item_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint

-- ⛔ The unique key moves with the identity: one rate per ITEM per list, not per text code.
DROP INDEX "price_list_items_list_item_key";--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_items_list_item_key" ON "price_list_items" USING btree ("price_list_id","item_id");--> statement-breakpoint

ALTER TABLE "price_list_items" DROP COLUMN "item_code";--> statement-breakpoint
ALTER TABLE "price_list_items" DROP COLUMN "item_name";
