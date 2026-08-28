-- 0053 — T-132: wholesale orders, the document a franchisee sale has never had.
--
-- HAND-WRITTEN, like 0020-0052. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ WHY. `ar_charges` carries a total and a caller-chosen revenue account, and NO LINES. So a
-- franchisee sale is a lump sum: no item, no quantity, no cost, and no reader for the price
-- lists (T-129), the item master (T-145) or the wholesale flag (T-149) — three shipped features
-- feeding nothing. This adds the one document that consumes them.
--
-- ⭐ THE SHAPE IS NOT INVENTED. `docs/discovery/19-b2b-order-to-cash.md` read ERPNext, Odoo,
-- Tryton and Dolibarr at controller level: Tryton collapses Quote/SO/DeliveryNote/Invoice into
-- ONE record, and Dolibarr bills straight from a validated order with no shipment document at
-- all. One order document with statuses is the light, precedented shape — ADR-008 §8's choice,
-- corroborated rather than asserted.
--
-- ⚠️ DISPATCH IS THE BILLING EVENT. The other fork — billing that lags and batches several
-- dispatches — needs an interim account and an unbilled-dispatch report, for generality nobody
-- has asked for. Revisit only when a buyer actually asks for period-batched invoices.

-- ---------------------------------------------------------------------------------------------
-- 1. The wholesale revenue account, which has never existed.
--
-- ⛔ 4100 unli, 4150 à la carte, 4400 beverage, 4500 other charges — every 4xxx leaf is RETAIL.
-- 0049 named this gap and deliberately left it: *"There is no wholesale-revenue account in the
-- chart yet; naming one here keeps the choice visible instead of inventing an account nobody
-- decided on."* Now it is decided, so it exists.
--
-- NOT 4200: the 2026-08-23 revenue amendment REMOVED 4200 (a take-out split POS cannot
-- populate), so reusing that number would read as that account returning. 4300 carries no
-- history.
--
-- ⚠️ By migration, not by editing the seed alone — the seed builds a FRESH database and both
-- live databases already exist. Same idempotent, per-org shape as 0012/0038/0040.
INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '4300', 'Wholesale sales', 'income', 'credit', h.id, true, true, false, 'active'
FROM "accounts" h
WHERE h.code = '4000'
  AND NOT EXISTS (
	SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '4300'
);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. A credit limit on the customer.
--
-- ⚠️ NULLABLE, and null is NOT zero: null means "no limit set", zero would mean "may not owe us
-- anything". Three of the four systems studied answer the credit question differently; Dolibarr's
-- limit field that enforces nothing is the cautionary tale, so ours is checked — at exactly one
-- gate (dispatch), never at three like ERPNext, because we have one document, not three.
ALTER TABLE "customers" ADD COLUMN "credit_limit" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_limit_non_negative_check"
	CHECK ("credit_limit" is null or "credit_limit" >= 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. The order.
CREATE TABLE "wholesale_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	-- The SELLING store. Sellability is resolved here, not org-wide: Lipa may sell the bulgogi
	-- sauce it makes while a branch that only buys it in may not (T-149).
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"reference_no" text,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	-- ⭐ The receivable this raised at dispatch. LINKED, never duplicated — the money lives in
	-- ar_charges and is collected, aged and written off by T-131's own code.
	"ar_charge_id" uuid,
	"journal_entry_id" uuid,
	"dispatched_at" timestamp with time zone,
	"dispatched_by" uuid,
	"credit_override_by" uuid,
	"credit_override_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "wholesale_orders_total_positive_check" CHECK ("total_amount" > 0),
	CONSTRAINT "wholesale_orders_status_check" CHECK ("status" in ('draft','confirmed','dispatched','void')),
	-- A dispatched order has dispatched, and raised a receivable doing it. Nothing else may.
	CONSTRAINT "wholesale_orders_dispatch_shape_check" CHECK (
		"status" <> 'dispatched'
		or ("dispatched_at" is not null and "dispatched_by" is not null and "ar_charge_id" is not null)
	),
	CONSTRAINT "wholesale_orders_void_shape_check" CHECK (
		"status" <> 'void' or ("voided_by" is not null and "voided_at" is not null and "void_reason" is not null)
	),
	-- An override without a reason is an override nobody can review later.
	CONSTRAINT "wholesale_orders_credit_override_shape_check" CHECK (
		("credit_override_by" is null) = ("credit_override_reason" is null)
	)
);--> statement-breakpoint

ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_org_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_store_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_customer_fk"
	FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_ar_charge_fk"
	FOREIGN KEY ("ar_charge_id") REFERENCES "public"."ar_charges"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_journal_entry_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_dispatched_by_fk"
	FOREIGN KEY ("dispatched_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_credit_override_by_fk"
	FOREIGN KEY ("credit_override_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_voided_by_fk"
	FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_orders" ADD CONSTRAINT "wholesale_orders_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "wholesale_orders_org_customer_idx" ON "wholesale_orders" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "wholesale_orders_org_store_date_idx" ON "wholesale_orders" USING btree ("org_id","store_id","order_date");--> statement-breakpoint
CREATE UNIQUE INDEX "wholesale_orders_ar_charge_key" ON "wholesale_orders" USING btree ("ar_charge_id") WHERE "ar_charge_id" is not null;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. The lines — the entire point of the task.
CREATE TABLE "wholesale_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text NOT NULL,
	-- ⭐ CAPTURED at line creation, never a live join to price_list_items. An agreed price must
	-- not move: a live join means editing a price list silently reprices every open order, and
	-- every system studied copies the rate forward rather than re-deriving it. ⚠️ This is one of
	-- the few places the project's derive-don't-store instinct (bible §4.2 rule 7) is WRONG.
	"rate" numeric(14, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wholesale_order_lines_quantity_positive_check" CHECK ("quantity" > 0),
	CONSTRAINT "wholesale_order_lines_rate_non_negative_check" CHECK ("rate" >= 0),
	CONSTRAINT "wholesale_order_lines_total_positive_check" CHECK ("line_total" > 0)
);--> statement-breakpoint

ALTER TABLE "wholesale_order_lines" ADD CONSTRAINT "wholesale_order_lines_org_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "wholesale_order_lines" ADD CONSTRAINT "wholesale_order_lines_order_fk"
	FOREIGN KEY ("order_id") REFERENCES "public"."wholesale_orders"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "wholesale_order_lines" ADD CONSTRAINT "wholesale_order_lines_item_fk"
	FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "wholesale_order_lines_order_idx" ON "wholesale_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "wholesale_order_lines_org_item_idx" ON "wholesale_order_lines" USING btree ("org_id","item_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. RLS. ⚠️ `app_current_org()`, never raw current_setting — DEF-077, and the enumerated test
-- in rls.test.ts fails on any policy that forgets.
ALTER TABLE "wholesale_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wholesale_orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wholesale_orders_org_isolation" ON "wholesale_orders"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

ALTER TABLE "wholesale_order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wholesale_order_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wholesale_order_lines_org_isolation" ON "wholesale_order_lines"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
