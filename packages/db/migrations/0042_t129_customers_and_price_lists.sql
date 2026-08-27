-- 0042 — T-129: customers and price lists. ADR-008 §2, §3, §11.
--
-- HAND-WRITTEN, like 0020-0041. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⛔ A RETAIL DINER IS NOT A CUSTOMER. ADR-008 §11: "A customers row exists because there is a
-- BALANCE or a credit relationship. A diner who pays at the point of sale has neither." The test is
-- not org-vs-individual — an individual buying meat on terms belongs here, a company paying cash at
-- the counter does not.
--
-- ⛔ NO outstanding_balance COLUMN. v1 keeps one on ARCustomerPlain and another on ApSupplierPlain
-- (DEF-075, the fifth and sixth time). The balance is summed from 1210 by party from day one, so
-- there is never a column for T-131 to have to remove.
--
-- ⭐ THE CHECK ON THE TWO COUNTERPARTY LINKS IS THE WHOLE DESIGN. Both set at once would make the
-- treatment ambiguous, and the two answers are not close: one ELIMINATES the movement, the other
-- books REAL REVENUE. Whichever the code tested first would win, and nothing on any screen would
-- look wrong.

CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"retired_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "price_lists_name_not_blank_check" CHECK (length(trim("name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	-- ⚠️ Opaque text, not a FK — there is no item master in v2 yet. Same precedent as
	-- expenses.supplier_id. It becomes a foreign key the day an item master lands.
	"item_code" text NOT NULL,
	"item_name" text,
	"rate" numeric(14, 2) NOT NULL,
	"unit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "price_list_items_rate_not_negative_check" CHECK ("rate" >= 0),
	CONSTRAINT "price_list_items_item_code_not_blank_check" CHECK (length(trim("item_code")) > 0)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"contact_no" text,
	-- ⭐ One of OUR OWN stores — an internal transfer that ELIMINATES. v1 has this already, as
	-- ARCustomerPlain.linkedStoreId.
	"counterparty_store_id" uuid,
	-- ⭐ ANOTHER org — a franchise. Real revenue, real receivable: money leaves one legal entity and
	-- enters another. ⛔ v1 has no equivalent, because it models a franchise as a branch (ADR-008 §7).
	"counterparty_org_id" uuid,
	"price_list_id" uuid,
	-- ⚠️ Reporting and defaults ONLY. It must never gate a posting decision.
	"customer_group" text DEFAULT 'wholesale' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	-- ⭐ The reconciliation anchor, ported from v1: everything before this date is considered
	-- settled. An ATTESTATION, not a balance — it does not change when the ledger does.
	"reconciled_as_of" date,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "customers_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "customers_status_check" CHECK ("status" in ('active','inactive')),
	CONSTRAINT "customers_group_check" CHECK (
		"customer_group" in ('wholesale','franchise','internal','staff','other')
	),
	-- ⛔ AT MOST ONE counterparty link — ADR-008 §2.
	CONSTRAINT "customers_one_counterparty_check" CHECK (
		num_nonnulls("counterparty_store_id", "counterparty_org_id") <= 1
	),
	-- ⚠️ An anchor is a three-part fact: a date, a moment, and a person.
	CONSTRAINT "customers_reconciled_shape_check" CHECK (
		("reconciled_as_of" is null and "reconciled_at" is null and "reconciled_by" is null)
		or ("reconciled_as_of" is not null and "reconciled_at" is not null and "reconciled_by" is not null)
	)
);
--> statement-breakpoint

ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
-- ⭐ CASCADE is deliberate here (bible §4.2 rule 3): a rate is genuinely part of its list.
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_price_lists_id_fk"
	FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_counterparty_store_id_stores_id_fk"
	FOREIGN KEY ("counterparty_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_counterparty_org_id_organizations_id_fk"
	FOREIGN KEY ("counterparty_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_price_list_id_price_lists_id_fk"
	FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_reconciled_by_persons_id_fk"
	FOREIGN KEY ("reconciled_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "price_lists_org_name_key" ON "price_lists" USING btree ("org_id","name");--> statement-breakpoint
-- ⛔ One rate per item per list, or the price lookup answers whichever row the planner reached first.
CREATE UNIQUE INDEX "price_list_items_list_item_key" ON "price_list_items" USING btree ("price_list_id","item_code");--> statement-breakpoint
CREATE INDEX "price_list_items_org_idx" ON "price_list_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "customers_org_idx" ON "customers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "customers_counterparty_store_idx" ON "customers" USING btree ("counterparty_store_id");--> statement-breakpoint
CREATE INDEX "customers_counterparty_org_idx" ON "customers" USING btree ("counterparty_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_name_key" ON "customers" USING btree ("org_id","name");--> statement-breakpoint

ALTER TABLE "price_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_lists" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "price_lists_org_isolation" ON "price_lists"
	USING ("org_id" = current_setting('app.org_id', true)::uuid)
	WITH CHECK ("org_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "price_list_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_list_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "price_list_items_org_isolation" ON "price_list_items"
	USING ("org_id" = current_setting('app.org_id', true)::uuid)
	WITH CHECK ("org_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "customers_org_isolation" ON "customers"
	USING ("org_id" = current_setting('app.org_id', true)::uuid)
	WITH CHECK ("org_id" = current_setting('app.org_id', true)::uuid);
