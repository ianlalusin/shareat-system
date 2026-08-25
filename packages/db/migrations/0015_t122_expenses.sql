-- 0015 — T-122: expenses. docs/tasks/122-expenses.md, bible rows 118-120.
--
-- expense_categories / expense_payments / expenses — non-inventory spend. A delivery books AP
-- directly at receipt (row 119) and is a separate document, Phase 3; this is everything else.
--
-- CREATE TABLE / FK / index statements below this comment are DRIZZLE-GENERATED from
-- packages/db/schema/expenses.ts, unedited. The RLS section at the end of this file is
-- HAND-ADDED, following the exact pattern migrations 0011 and 0014 established (drizzle-kit does
-- not generate RLS policies): ENABLE + FORCE ROW LEVEL SECURITY, then a policy per table, scoped
-- per its packages/db/src/rls/registry.ts entry. 0000-0014 are applied and never edited
-- (bible §2 rule 8).

CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"group" text NOT NULL,
	"category" text NOT NULL,
	"sub_category" text,
	"account_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "expense_categories_group_check" CHECK ("expense_categories"."group" in ('OPEX', 'COGS', 'CAPEX', 'PERSONAL'))
);
--> statement-breakpoint
CREATE TABLE "expense_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"expense_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"account_code" text,
	"staff_id" uuid,
	"cash_request_id" text,
	CONSTRAINT "expense_payments_method_check" CHECK ("expense_payments"."method" in ('cash', 'online', 'credit', 'other', 'reimbursable', 'ar_collection')),
	CONSTRAINT "expense_payments_amount_positive_check" CHECK ("expense_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"category_id" uuid NOT NULL,
	"supplier_id" text,
	"particulars" text NOT NULL,
	"receipt_photo_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"posted_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "expenses_status_check" CHECK ("expenses"."status" in ('draft', 'posted', 'voided')),
	CONSTRAINT "expenses_total_amount_positive_check" CHECK ("expenses"."total_amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_staff_id_persons_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_persons_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_org_id_category_unique" ON "expense_categories" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "expense_categories_org_id_group_idx" ON "expense_categories" USING btree ("org_id","group");--> statement-breakpoint
CREATE INDEX "expense_payments_expense_id_idx" ON "expense_payments" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "expense_payments_staff_id_idx" ON "expense_payments" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "expenses_org_id_store_id_idx" ON "expenses" USING btree ("org_id","store_id");--> statement-breakpoint
CREATE INDEX "expenses_org_id_business_date_idx" ON "expenses" USING btree ("org_id","business_date");--> statement-breakpoint
CREATE INDEX "expenses_category_id_idx" ON "expenses" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "expenses_status_idx" ON "expenses" USING btree ("status");--> statement-breakpoint
CREATE INDEX "expenses_created_by_idx" ON "expenses" USING btree ("created_by");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- RLS — hand-added, matching packages/db/src/rls/registry.ts entries for these three
-- tables exactly. A registry entry with no policy here is a promise, not a control.
-- ---------------------------------------------------------------------------------------

-- expense_categories and expenses both carry org_id directly — org_column, same pattern as
-- accounts / journal_entries.
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "expense_categories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "expense_categories_org_isolation" ON "expense_categories" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "expenses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "expenses_org_isolation" ON "expenses" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- expense_payments has no org_id of its own — derived through the expense it belongs to,
-- same pattern as journal_lines through journal_entries.
ALTER TABLE "expense_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "expense_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "expense_payments_via_expense" ON "expense_payments" FOR ALL
	USING (EXISTS (SELECT 1 FROM "expenses" e WHERE e."id" = "expense_payments"."expense_id" AND e."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "expenses" e WHERE e."id" = "expense_payments"."expense_id" AND e."org_id" = app_current_org()));