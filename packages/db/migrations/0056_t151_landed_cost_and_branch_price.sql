-- 0056 — T-151: landed cost and the branch price. Two delivery fees, two different treatments.
--
-- HAND-WRITTEN, like 0020-0055. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ IAN'S RULE, 2026-08-28, which is the whole specification:
--   *"delivery fee from supplier to Lipa is added to price. delivery fee on top of that is the fee
--    from Lipa to Malvar."*
--
--   supplier → Lipa   INTO the item's cost   it is part of what the goods cost to have
--   Lipa → Malvar     ON TOP of the order    a haulage charge for one shipment, not a property of
--                                            the item — loading it in would make the same item
--                                            cost different depending on how it travelled
--
-- ⛔ Neither was modelled. Invoice lines had to sum EXACTLY to the invoice total, so there was
-- nowhere for a fee to go, and a branch price built on the raw line was understated before any
-- markup was applied to it.

-- ---------------------------------------------------------------------------------------------
-- 1. Inbound freight — INTO the cost.
--
-- ⚠️ The line-sum rule moves with it: `sum(lines) = total_amount` becomes
-- `sum(lines) + delivery_fee + other_fees = total_amount`. That is enforced in
-- `validateInvoiceLines`, not here, for the same reason the item checks live there — a CHECK
-- cannot sum a child table.
ALTER TABLE "supplier_invoices" ADD COLUMN "delivery_fee" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "other_fees" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_fees_non_negative_check"
	CHECK ("delivery_fee" >= 0 AND "other_fees" >= 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Outbound freight — ON TOP of the order.
ALTER TABLE "trade_orders" ADD COLUMN "delivery_fee" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "other_fees" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_fees_non_negative_check"
	CHECK ("delivery_fee" >= 0 AND "other_fees" >= 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Pricing off another item — v1's `costBasisProductId`.
--
-- ⭐ Sliced meat prices off its SOURCE SLAB, not off itself: the slab is what was actually bought,
-- so it is the only thing with a real received cost. v1 resolves this first, before the item's own
-- history (`resolveBasisCost`, three tiers), and so do we.
ALTER TABLE "items" ADD COLUMN "cost_basis_item_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_cost_basis_item_fk"
	FOREIGN KEY ("cost_basis_item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint
-- ⛔ An item priced off itself is a loop that reads as a rule.
ALTER TABLE "items" ADD CONSTRAINT "items_cost_basis_not_self_check"
	CHECK ("cost_basis_item_id" is null or "cost_basis_item_id" <> "id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. The branch price rule, per item.
--
-- ⭐ WHAT IS DELIBERATELY ABSENT: any stored cost. v1 keeps a rolling `lastReceivedCost` here, and
-- that is precisely what broke — a delivery line entered as qty 1 with the lot TOTAL in the
-- unit-cost field poisoned it, and because the rule is `max(prior, new)` the poison was STICKY:
-- every later cheaper receive kept it, freezing a chopstick branch price at ₱1,458 instead of
-- ₱1.46. Correcting the delivery did not help — the refresh skips recompute when the stored value
-- already equals the new max, so it could not self-heal and needed a manual forced recompute.
--
-- ⭐ v2 derives the basis from invoice history on every read and stores NOTHING. Fix the bad line
-- and the price is right next time it is asked for. Same rule, same `max` semantics, no poison.
CREATE TABLE "item_pricing" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"pricing_mode" text NOT NULL,
	"fixed_amount" numeric(14, 2),
	"markup_percent" numeric(8, 4),
	"fixed_markup_amount" numeric(14, 2),
	-- Advisory only. ⚠️ It warns; it never blocks an order.
	"margin_alert_threshold_pct" numeric(8, 4),
	"set_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "item_pricing_mode_check" CHECK ("pricing_mode" in ('fixed','fixed_markup','percent_markup')),
	-- Each mode needs its own number and is meaningless without it.
	CONSTRAINT "item_pricing_mode_shape_check" CHECK (
		("pricing_mode" <> 'fixed' or "fixed_amount" is not null)
		and ("pricing_mode" <> 'fixed_markup' or "fixed_markup_amount" is not null)
		and ("pricing_mode" <> 'percent_markup' or "markup_percent" is not null)
	),
	CONSTRAINT "item_pricing_non_negative_check" CHECK (
		coalesce("fixed_amount", 0) >= 0
		and coalesce("fixed_markup_amount", 0) >= 0
		and coalesce("markup_percent", 0) >= 0
	)
);--> statement-breakpoint

ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_org_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_item_fk"
	FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_set_by_fk"
	FOREIGN KEY ("set_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "item_pricing_item_key" ON "item_pricing" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_pricing_org_idx" ON "item_pricing" USING btree ("org_id");--> statement-breakpoint

ALTER TABLE "item_pricing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "item_pricing" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "item_pricing_org_isolation" ON "item_pricing"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
