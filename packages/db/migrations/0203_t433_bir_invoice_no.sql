-- 0203 - T-433 S2: the BIR booklet invoice number a person writes on a trade order's delivery receipt.
-- docs/tasks/433-b2b-trade-order-gaps.md ruling 8; hand-authored per ADR-012 s5. Builds on 0201 (journal head); idx 202 is reserved for POS v2 and is deliberately absent.
--
-- WHY. The official invoice is the pre-printed booklet the business already uses (bible row 75: this system never issues one).
-- We only NOTE its number on the order so the printout can show it. Optional, so nullable; unique per organisation when set,
-- so one booklet number cannot sit on two orders. No table is added, so no classification / RLS registry change.
ALTER TABLE "trade_orders" ADD COLUMN "bir_invoice_no" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "trade_orders_org_bir_invoice_no_key" ON "trade_orders" USING btree ("org_id","bir_invoice_no") WHERE "bir_invoice_no" is not null;
