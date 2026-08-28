-- 0054 — T-133: the internal half of the one order flow.
--
-- HAND-WRITTEN, like 0020-0053. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ WHY A RENAME. ADR-008 §8: *"One ordering and fulfilment flow. Two accounting treatments,
-- derived from the counterparty. … A mode is a fork; a derived treatment is a fact."* T-132 built
-- the sale treatment and deliberately REFUSED an internal counterparty, naming this task. Adding
-- the transfer treatment to the same table means a table called `wholesale_orders` would hold
-- internal branch transfers — exactly the defect docs/GLOSSARY.md exists to prevent, where v1
-- field names mean the OPPOSITE of what they look like and cost real time to unlearn.
-- ⚠️ The glossary's own examples are deliberately NOT quoted here: a guard test refuses any v2
-- source file that names one, and it is right to, even in a comment citing them as a warning.
--
-- ⚠️ The rename is nearly free exactly ONCE: the table is one day old, holds no production data,
-- and has no UI. It gets more expensive every day after this one.
--
-- ⛔ NOT a drop-and-recreate. ALTER ... RENAME carries the data, the indexes, the constraints and
-- the RLS policies with it. Recreating would silently drop the policies and leave two tables
-- readable across orgs until somebody noticed.

ALTER TABLE "wholesale_orders" RENAME TO "trade_orders";--> statement-breakpoint
ALTER TABLE "wholesale_order_lines" RENAME TO "trade_order_lines";--> statement-breakpoint

-- Constraints and indexes keep their old names after a table rename; renaming them too means a
-- future reader greps one word, not two.
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_total_positive_check" TO "trade_orders_total_positive_check";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_status_check" TO "trade_orders_status_check";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_dispatch_shape_check" TO "trade_orders_dispatch_shape_check";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_void_shape_check" TO "trade_orders_void_shape_check";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_credit_override_shape_check" TO "trade_orders_credit_override_shape_check";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_org_fk" TO "trade_orders_org_fk";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_store_fk" TO "trade_orders_store_fk";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_customer_fk" TO "trade_orders_customer_fk";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_ar_charge_fk" TO "trade_orders_ar_charge_fk";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_journal_entry_fk" TO "trade_orders_journal_entry_fk";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_dispatched_by_fk" TO "trade_orders_dispatched_by_fk";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_credit_override_by_fk" TO "trade_orders_credit_override_by_fk";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_voided_by_fk" TO "trade_orders_voided_by_fk";--> statement-breakpoint
ALTER TABLE "trade_orders" RENAME CONSTRAINT "wholesale_orders_created_by_fk" TO "trade_orders_created_by_fk";--> statement-breakpoint

ALTER INDEX "wholesale_orders_org_customer_idx" RENAME TO "trade_orders_org_customer_idx";--> statement-breakpoint
ALTER INDEX "wholesale_orders_org_store_date_idx" RENAME TO "trade_orders_org_store_date_idx";--> statement-breakpoint
ALTER INDEX "wholesale_orders_ar_charge_key" RENAME TO "trade_orders_ar_charge_key";--> statement-breakpoint

ALTER TABLE "trade_order_lines" RENAME CONSTRAINT "wholesale_order_lines_quantity_positive_check" TO "trade_order_lines_quantity_positive_check";--> statement-breakpoint
ALTER TABLE "trade_order_lines" RENAME CONSTRAINT "wholesale_order_lines_rate_non_negative_check" TO "trade_order_lines_rate_non_negative_check";--> statement-breakpoint
ALTER TABLE "trade_order_lines" RENAME CONSTRAINT "wholesale_order_lines_total_positive_check" TO "trade_order_lines_total_positive_check";--> statement-breakpoint
ALTER TABLE "trade_order_lines" RENAME CONSTRAINT "wholesale_order_lines_org_fk" TO "trade_order_lines_org_fk";--> statement-breakpoint
ALTER TABLE "trade_order_lines" RENAME CONSTRAINT "wholesale_order_lines_order_fk" TO "trade_order_lines_order_fk";--> statement-breakpoint
ALTER TABLE "trade_order_lines" RENAME CONSTRAINT "wholesale_order_lines_item_fk" TO "trade_order_lines_item_fk";--> statement-breakpoint

ALTER INDEX "wholesale_order_lines_order_idx" RENAME TO "trade_order_lines_order_idx";--> statement-breakpoint
ALTER INDEX "wholesale_order_lines_org_item_idx" RENAME TO "trade_order_lines_org_item_idx";--> statement-breakpoint

-- ⚠️ A policy is NOT renamed by the table rename; it keeps its own name on the renamed table.
ALTER POLICY "wholesale_orders_org_isolation" ON "trade_orders" RENAME TO "trade_orders_org_isolation";--> statement-breakpoint
ALTER POLICY "wholesale_order_lines_org_isolation" ON "trade_order_lines" RENAME TO "trade_order_lines_org_isolation";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- `received` — who confirmed what actually landed.
--
-- ⚠️ For a SAME-ORG transfer this posts nothing: the value already moved in one entry at dispatch,
-- because both stores are rows in one database (bible landmine #27's fix). It is a recorded fact,
-- not a posting trigger. It becomes a posting when the counterparty is another ORG, which no data
-- has yet — see the task spec §4.
ALTER TABLE "trade_orders" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "received_by" uuid;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_received_by_fk"
	FOREIGN KEY ("received_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_received_shape_check"
	CHECK (("received_at" is null) = ("received_by" is null));--> statement-breakpoint

-- `received` joins the lifecycle. ⛔ DROP then ADD: a CHECK cannot be altered in place, and the
-- old one would keep refusing the new value.
ALTER TABLE "trade_orders" DROP CONSTRAINT "trade_orders_status_check";--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_status_check"
	CHECK ("status" in ('draft','confirmed','dispatched','received','void'));--> statement-breakpoint

-- ⭐ An INTERNAL transfer raises no receivable, so the dispatch shape check must stop demanding
-- one. What a dispatched order always has is the dispatch itself; the ar_charge is now required
-- only when the order actually billed someone, which the journal entry proves either way.
ALTER TABLE "trade_orders" DROP CONSTRAINT "trade_orders_dispatch_shape_check";--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_dispatch_shape_check"
	CHECK (
		"status" not in ('dispatched','received')
		or ("dispatched_at" is not null and "dispatched_by" is not null and "journal_entry_id" is not null)
	);
