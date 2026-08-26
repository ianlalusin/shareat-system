-- 0023 — DEF-068 / ADR-010 / bible row 148: `sales_day_tenders` — which money account each
-- day's online tender actually landed in.
--
-- Hand-written for the RLS policy, as 0021 was. The policy is `derived`, not `org_column`: this
-- table has no `org_id` of its own and is reachable only through the sales day it belongs to,
-- the same shape `sales_day_channels` beside it already uses. One source of truth for which org
-- a row belongs to, so a copied column cannot drift from its parent.
--
-- ## Why this table, when sales_day_channels already exists
--
-- ⚠️ They are ORTHOGONAL axes, and mistaking one for the other is the reason this was missed:
--
--   sales_day_channels   where the sale came FROM  (Walk-in, Foodpanda)   revenue, receivables
--   sales_day_tenders    where the money WENT      (GCash, BDO)           CUSTODY
--
-- A Foodpanda sale can settle into any wallet, so neither answers the other's question. v2
-- recorded one undifferentiated `online_collected` figure, which left ADR-010's headline question
-- — how much online money is in the cashier's hands versus the office's — unanswerable on the
-- side that matters most, because collections are the largest inflow.
--
-- v1 never had this problem: its sale builder takes `onlineBreakdown` as an accountId→amount map
-- and posts one leg per account. The data was never missing — POS captures the payment mode at
-- the till — T-123 simply did not carry it across.
--
-- ## Additive, deliberately
--
-- `sales_days.online_collected` is NOT dropped. It stays as the day's total, and this table
-- breaks it down; the domain enforces that they agree. Removing the column would be a second,
-- larger change to a module already in the Oct–Dec pilot path, and there is no need to couple them.

--> statement-breakpoint
CREATE TABLE "sales_day_tenders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"sales_day_id" uuid NOT NULL,
	"money_account_id" uuid NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	-- ⛔ Strictly positive, unlike a channel row. A channel MAY be zero — a reporter confirming
	-- "no Foodpanda sales today" is information. A tender row of zero says money went into a
	-- wallet and the amount was nothing, which is not a fact about anything: the row should not
	-- exist at all.
	CONSTRAINT "sales_day_tenders_amount_positive_check" CHECK ("sales_day_tenders"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "sales_day_tenders" ADD CONSTRAINT "sales_day_tenders_sales_day_id_sales_days_id_fk"
	FOREIGN KEY ("sales_day_id") REFERENCES "public"."sales_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ⚠️ restrict, not cascade: a wallet that has received money can never be deleted, only retired.
-- Deleting it would orphan the day's tender exactly as v1's hard-deletes orphan journal legs.
ALTER TABLE "sales_day_tenders" ADD CONSTRAINT "sales_day_tenders_money_account_id_money_accounts_id_fk"
	FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "sales_day_tenders_sales_day_id_money_account_id_unique" ON "sales_day_tenders" ("sales_day_id","money_account_id");--> statement-breakpoint
CREATE INDEX "sales_day_tenders_money_account_id_idx" ON "sales_day_tenders" ("money_account_id");--> statement-breakpoint

ALTER TABLE "sales_day_tenders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_day_tenders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sales_day_tenders_org_isolation" ON "sales_day_tenders"
	FOR ALL
	USING (exists (select 1 from sales_days sd where sd.id = sales_day_tenders.sales_day_id and sd.org_id = app_current_org()))
	WITH CHECK (exists (select 1 from sales_days sd where sd.id = sales_day_tenders.sales_day_id and sd.org_id = app_current_org()));
