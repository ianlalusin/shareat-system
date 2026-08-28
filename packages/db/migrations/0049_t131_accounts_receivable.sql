-- 0049 — T-131: accounts receivable. Charges, collections, open-item allocation, write-off.
-- docs/tasks/131-accounts-receivable.md.
--
-- HAND-WRITTEN, like 0020-0048. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ THE MIRROR OF T-130, DELIBERATELY. AP proved the shape — a control account, a subledger
-- keyed by party, open items derived from the ledger, allocation that must name what it settles,
-- and a surplus that becomes a named balance rather than a floating number. AR is the same
-- machinery pointed the other way, so it reuses the same decisions rather than re-litigating them.
--
-- ⛔ WHAT v1 DOES THAT THIS REFUSES TO COPY, each measured in its live data:
--   - a stored `outstandingAmount` that disagrees with its own inputs on 106 of 794 rows (13.3%)
--   - `overageAsStoreCredit`, a boolean stamped from a client-supplied number with NO balance
--     anywhere behind it (0 of 512 collections ever used it)
--   - `unallocatedAmount`, money tied to nothing on 38 collections and no way to re-apply it
--   - a `pending_verification` status nothing can ever transition out of
--
-- ⭐ 74% of v1's "AR collections" (381 of 512) are delivery-platform settlements riding the same
-- document through a different write path. Those are NOT built here — see the task doc.

-- ===========================================================================================
-- ⭐ 2140 becomes a control account.
--
-- A customer store credit that does not say WHOSE credit it is cannot be paid back to anyone. v1
-- had no balance at all behind its overage flag; making this account party-required means the
-- T-118 trigger refuses a surplus with no customer, rather than trusting the service layer to
-- remember. The seed is updated to match so new orgs are born correct.
-- ===========================================================================================
UPDATE "accounts" SET "requires_party" = true WHERE "code" = '2140';--> statement-breakpoint

CREATE TABLE "ar_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"charge_date" date NOT NULL,
	-- Aging reads this and falls back to charge_date (bible row 162, landed today).
	"due_date" date,
	"reference_no" text,
	"notes" text,
	"total_amount" numeric(14, 2) NOT NULL,
	-- ⭐ Explicit, never guessed. The sales-day router REFUSES credit sales outright ("credit
	-- sales belong to AR (T-131), not to a daily summary"), so nothing else books this revenue.
	-- There is no wholesale-revenue account in the chart yet; naming one here keeps the choice
	-- visible instead of inventing an account nobody decided on.
	"revenue_account_code" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ar_charges_total_positive_check" CHECK ("total_amount" > 0),
	CONSTRAINT "ar_charges_status_check" CHECK ("status" in ('draft','posted','voided')),
	CONSTRAINT "ar_charges_void_shape_check" CHECK (
		"status" <> 'voided' or ("voided_by" is not null and "voided_at" is not null and "void_reason" is not null)
	)
);
--> statement-breakpoint

CREATE TABLE "ar_collections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"collection_date" date NOT NULL,
	-- The GROSS receivable cleared. What lands in the bank is this minus the platform fee.
	"amount" numeric(14, 2) NOT NULL,
	-- ⛔ Booked HERE and nowhere else. v1 recognised it twice and it cost ₱198,148.29 across two
	-- stores, 37 duplicate expense documents voided. POSTING-PATTERNS.md ar_collection, 176 legs.
	"platform_fee" numeric(14, 2) DEFAULT '0' NOT NULL,
	"money_account_id" uuid NOT NULL,
	"reference_no" text,
	"notes" text,
	-- v1's real rule, ported: proof is required for an ONLINE collection, never for cash.
	"receipt_file_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ar_collections_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "ar_collections_fee_not_negative_check" CHECK ("platform_fee" >= 0),
	-- A fee cannot exceed what was collected; that would mean the customer paid us nothing and
	-- we still cleared their debt.
	CONSTRAINT "ar_collections_fee_within_amount_check" CHECK ("platform_fee" <= "amount"),
	CONSTRAINT "ar_collections_status_check" CHECK ("status" in ('draft','posted','voided')),
	CONSTRAINT "ar_collections_void_shape_check" CHECK (
		"status" <> 'voided' or ("voided_by" is not null and "voided_at" is not null and "void_reason" is not null)
	)
);
--> statement-breakpoint

CREATE TABLE "ar_collection_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ar_collection_id" uuid NOT NULL,
	"ar_charge_id" uuid NOT NULL,
	"amount_applied" numeric(14, 2) NOT NULL,
	CONSTRAINT "ar_collection_allocations_amount_positive_check" CHECK ("amount_applied" > 0)
);
--> statement-breakpoint

CREATE TABLE "ar_write_offs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"ar_charge_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reason" text NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	-- ⛔ Admin only, and never the charge's own author (service layer — a CHECK cannot reach
	-- ar_charges.created_by from here without a trigger, and this rule is about WHO acts, which
	-- the service already knows). Writing off your own receivable is how a shortfall is buried.
	"written_off_by" uuid NOT NULL,
	"written_off_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ar_write_offs_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "ar_write_offs_reason_not_blank_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint

ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_money_account_id_fk" FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_receipt_file_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "ar_collection_allocations" ADD CONSTRAINT "ar_collection_allocations_collection_fk" FOREIGN KEY ("ar_collection_id") REFERENCES "public"."ar_collections"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "ar_collection_allocations" ADD CONSTRAINT "ar_collection_allocations_charge_fk" FOREIGN KEY ("ar_charge_id") REFERENCES "public"."ar_charges"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "ar_write_offs" ADD CONSTRAINT "ar_write_offs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_write_offs" ADD CONSTRAINT "ar_write_offs_charge_fk" FOREIGN KEY ("ar_charge_id") REFERENCES "public"."ar_charges"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_write_offs" ADD CONSTRAINT "ar_write_offs_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ar_write_offs" ADD CONSTRAINT "ar_write_offs_written_off_by_persons_id_fk" FOREIGN KEY ("written_off_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "ar_charges_org_customer_idx" ON "ar_charges" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "ar_charges_store_idx" ON "ar_charges" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "ar_charges_org_due_date_idx" ON "ar_charges" USING btree ("org_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ar_collection_allocations_collection_charge_key" ON "ar_collection_allocations" USING btree ("ar_collection_id","ar_charge_id");--> statement-breakpoint
-- The open-item query joins allocations by CHARGE; the unique index above leads with the
-- collection, which is the wrong direction for it. Same lesson as migration 0045's AP indexes.
CREATE INDEX "ar_collection_allocations_charge_idx" ON "ar_collection_allocations" USING btree ("ar_charge_id");--> statement-breakpoint
CREATE INDEX "ar_collections_org_customer_idx" ON "ar_collections" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "ar_write_offs_charge_idx" ON "ar_write_offs" USING btree ("ar_charge_id");--> statement-breakpoint

-- ===========================================================================================
-- RLS — `app_current_org()`, never a raw current_setting cast (DEF-077, closed today in 0044).
-- ===========================================================================================
ALTER TABLE "ar_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ar_charges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ar_charges_org_isolation" ON "ar_charges"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

ALTER TABLE "ar_collections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ar_collections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ar_collections_org_isolation" ON "ar_collections"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

ALTER TABLE "ar_write_offs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ar_write_offs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ar_write_offs_org_isolation" ON "ar_write_offs"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- No org_id of its own — reachable through the collection it belongs to, same pattern as
-- ap_payment_allocations through ap_payments.
ALTER TABLE "ar_collection_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ar_collection_allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ar_collection_allocations_via_collection" ON "ar_collection_allocations" FOR ALL
	USING (EXISTS (SELECT 1 FROM "ar_collections" c WHERE c."id" = "ar_collection_allocations"."ar_collection_id" AND c."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "ar_collections" c WHERE c."id" = "ar_collection_allocations"."ar_collection_id" AND c."org_id" = app_current_org()));
