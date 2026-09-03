-- 0118 — T-170: supplier returns. The goods go back, and we hold a credit.
-- docs/tasks/170-supplier-returns.md, bible row 166.
--
-- HAND-WRITTEN, per DEF-073/DEF-121 (this repo's drizzle-kit snapshot chain is stale since
-- ~migration 0020; every migration since has been hand-written from schema.ts). Never edited
-- after apply.
--
-- ⭐ credit_basis is a THREE-value enum ('grni' | 'supplier_advance' | 'mixed'), not the two the
-- task spec's contract listed — a supplier invoice's LINES link to individual stock_layers rows,
-- so one delivery can have some lines invoiced and others not, and the header rolls up what the
-- lines (which each carry their own two-value basis) actually were. See schema/supplier-returns.ts.

CREATE TABLE "supplier_returns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"delivery_id" uuid,
	"returned_on" date NOT NULL,
	"reason" text NOT NULL,
	"credit_basis" text NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_returns_credit_basis_check" CHECK ("credit_basis" IN ('grni','supplier_advance','mixed')),
	CONSTRAINT "supplier_returns_status_check" CHECK ("status" IN ('posted','void')),
	CONSTRAINT "supplier_returns_void_shape_check"
		CHECK ("status" <> 'void' OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_supplier_id_suppliers_id_fk"
	FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_delivery_id_deliveries_id_fk"
	FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_journal_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_voided_by_persons_id_fk"
	FOREIGN KEY ("voided_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "supplier_returns_store_status_idx" ON "supplier_returns" ("store_id", "status");--> statement-breakpoint
CREATE INDEX "supplier_returns_supplier_idx" ON "supplier_returns" ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_returns_org_idx" ON "supplier_returns" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
CREATE TABLE "supplier_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"return_id" uuid NOT NULL,
	"line_no" text NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"delivery_line_id" uuid,
	"movement_id" uuid NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"credit_basis" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_return_lines_quantity_positive_check" CHECK ("quantity" > 0),
	CONSTRAINT "supplier_return_lines_unit_cost_non_negative_check" CHECK ("unit_cost" >= 0),
	CONSTRAINT "supplier_return_lines_credit_basis_check" CHECK ("credit_basis" IN ('grni','supplier_advance'))
);--> statement-breakpoint

ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_return_id_supplier_returns_id_fk"
	FOREIGN KEY ("return_id") REFERENCES "supplier_returns"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_delivery_line_id_delivery_lines_id_fk"
	FOREIGN KEY ("delivery_line_id") REFERENCES "delivery_lines"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "supplier_return_lines_return_line_key" ON "supplier_return_lines" ("return_id", "line_no");--> statement-breakpoint
CREATE INDEX "supplier_return_lines_item_idx" ON "supplier_return_lines" ("item_id");--> statement-breakpoint
CREATE INDEX "supplier_return_lines_delivery_line_idx" ON "supplier_return_lines" ("delivery_line_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE, as the tables are created (bible row 112).
ALTER TABLE "supplier_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_returns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "supplier_returns_org_isolation" ON "supplier_returns"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ⚠️ DERIVED scoping: supplier_return_lines carries no org_id of its own — reached only through
-- its return, same shape as delivery_lines through deliveries.
CREATE POLICY "supplier_return_lines_org_isolation" ON "supplier_return_lines"
	USING (EXISTS (SELECT 1 FROM "supplier_returns" r WHERE r."id" = "return_id" AND r."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "supplier_returns" r WHERE r."id" = "return_id" AND r."org_id" = app_current_org()));--> statement-breakpoint
