-- 0119 — T-179: customer returns. The goods come back, and they hold a credit.
-- docs/tasks/179-customer-returns-and-store-credit.md, bible row 166. Sibling of T-170 (0118).
--
-- HAND-WRITTEN, per DEF-073/DEF-121 (this repo's drizzle-kit snapshot chain is stale since
-- ~migration 0020; every migration since has been hand-written from schema.ts). Never edited
-- after apply.

CREATE TABLE "customer_returns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"trade_order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"treatment" text NOT NULL,
	"returned_on" date NOT NULL,
	"reason" text NOT NULL,
	"settlement" text NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_returns_treatment_check" CHECK ("treatment" IN ('external','inter_entity','internal')),
	CONSTRAINT "customer_returns_settlement_check" CHECK ("settlement" IN ('reduce_ar','store_credit','cash_refund','reverse_transfer','mixed')),
	CONSTRAINT "customer_returns_status_check" CHECK ("status" IN ('posted','void')),
	CONSTRAINT "customer_returns_void_shape_check"
		CHECK ("status" <> 'void' OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)),
	CONSTRAINT "customer_returns_internal_settlement_check"
		CHECK ("treatment" <> 'internal' OR "settlement" = 'reverse_transfer'),
	CONSTRAINT "customer_returns_settlement_internal_check"
		CHECK ("settlement" <> 'reverse_transfer' OR "treatment" = 'internal')
);--> statement-breakpoint

ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_trade_order_id_trade_orders_id_fk"
	FOREIGN KEY ("trade_order_id") REFERENCES "trade_orders"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_customer_id_customers_id_fk"
	FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_journal_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_voided_by_persons_id_fk"
	FOREIGN KEY ("voided_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "customer_returns_store_status_idx" ON "customer_returns" ("store_id", "status");--> statement-breakpoint
CREATE INDEX "customer_returns_customer_idx" ON "customer_returns" ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_returns_trade_order_idx" ON "customer_returns" ("trade_order_id");--> statement-breakpoint
CREATE INDEX "customer_returns_org_idx" ON "customer_returns" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
CREATE TABLE "customer_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"return_id" uuid NOT NULL,
	"line_no" text NOT NULL,
	"trade_order_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"saleable" boolean DEFAULT true NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"cost" numeric(14, 2) NOT NULL,
	"item_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_return_lines_quantity_positive_check" CHECK ("quantity" > 0),
	CONSTRAINT "customer_return_lines_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "customer_return_lines_cost_non_negative_check" CHECK ("cost" >= 0)
);--> statement-breakpoint

ALTER TABLE "customer_return_lines" ADD CONSTRAINT "customer_return_lines_return_id_customer_returns_id_fk"
	FOREIGN KEY ("return_id") REFERENCES "customer_returns"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "customer_return_lines" ADD CONSTRAINT "customer_return_lines_trade_order_line_id_trade_order_lines_id_fk"
	FOREIGN KEY ("trade_order_line_id") REFERENCES "trade_order_lines"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "customer_return_lines" ADD CONSTRAINT "customer_return_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "customer_return_lines" ADD CONSTRAINT "customer_return_lines_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "customer_return_lines_return_line_key" ON "customer_return_lines" ("return_id", "line_no");--> statement-breakpoint
CREATE INDEX "customer_return_lines_trade_order_line_idx" ON "customer_return_lines" ("trade_order_line_id");--> statement-breakpoint
CREATE INDEX "customer_return_lines_item_idx" ON "customer_return_lines" ("item_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE, as the tables are created (bible row 112).
ALTER TABLE "customer_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_returns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_return_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_return_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "customer_returns_org_isolation" ON "customer_returns"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ⚠️ DERIVED scoping: customer_return_lines carries no org_id of its own — reached only through
-- its return, same shape as supplier_return_lines through supplier_returns.
CREATE POLICY "customer_return_lines_org_isolation" ON "customer_return_lines"
	USING (EXISTS (SELECT 1 FROM "customer_returns" r WHERE r."id" = "return_id" AND r."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "customer_returns" r WHERE r."id" = "return_id" AND r."org_id" = app_current_org()));--> statement-breakpoint
