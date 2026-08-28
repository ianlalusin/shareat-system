-- 0048 — T-147: the supplier-item catalogue. docs/tasks/147-supplier-item-catalogue.md.
--
-- HAND-WRITTEN, like 0020-0047. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ ONE TABLE, AND IT IS THE SMALL HALF. The catalogue has two kinds of link:
--
--   observed — this supplier has actually billed us this item. That is
--              `SELECT DISTINCT supplier_id, item_id` over supplier_invoice_lines, so it is a
--              QUERY and gets no table. Storing it would cache something the ledger already
--              answers — DEF-075's pattern, refused an eighth time.
--   declared — a person says "we could buy this here", with no invoice yet. Nothing derives
--              that, so it is stored. THIS TABLE.
--
-- ⚠️ The first draft of the spec stored both, and was corrected before any code was written.
-- The give-away was its own invariant list refusing a stored price two lines above a stored
-- relationship.
--
-- ⭐ Consequences of deriving the observed half, all of them simplifications:
--   - no `source` column: every row here means the same thing
--   - no promotion step when an invoice finally proves a declaration — the query just reports it
--     as observed and this row stops mattering
--   - no "observed must never be demoted" invariant to enforce or test
--   - "you cannot un-buy something" is structural: an observed link is not a row, so DELETE
--     cannot reach it
--
-- ⭐ `created_by` is NOT NULL. Only a human ever writes here.

CREATE TABLE "supplier_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_supplier_id_suppliers_id_fk"
	FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "supplier_items_supplier_item_key" ON "supplier_items" USING btree ("supplier_id","item_id");--> statement-breakpoint
CREATE INDEX "supplier_items_org_idx" ON "supplier_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "supplier_items_item_idx" ON "supplier_items" USING btree ("item_id");--> statement-breakpoint

-- ⭐ The observed half's index. `itemsForSupplier` joins lines -> invoices and groups by supplier;
-- without this it scans every line in the org to answer "what has this supplier sold us".
CREATE INDEX "supplier_invoices_supplier_status_idx" ON "supplier_invoices" USING btree ("supplier_id","status");--> statement-breakpoint

ALTER TABLE "supplier_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- `app_current_org()`, never a raw current_setting cast — DEF-077, closed today in migration 0044.
CREATE POLICY "supplier_items_org_isolation" ON "supplier_items"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
