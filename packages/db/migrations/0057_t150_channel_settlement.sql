-- 0057 — T-150: channel settlement. Clearing the receivable Foodpanda and Grab raise.
--
-- HAND-WRITTEN, like 0020-0056. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ SPEC BY A PEER SESSION (`ianla-72`), `docs/tasks/150-channel-settlement.md`, 2026-08-28.
-- Ian: *"then do the panda and grab settlement the other agent planned."* Implemented to that
-- spec; the two decisions it left open are taken on its own recommendations, and marked below.
--
-- ⭐ WHY. T-123 raises `1220 Channel receivable` on every verified Foodpanda / Grab day and
-- NOTHING has ever cleared it, so the balance only grows. 74% of v1's AR collection volume has no
-- home, and Phase 2's exit gate — *"subledgers tie to control accounts"* — cannot pass.

-- ---------------------------------------------------------------------------------------------
-- 1. `6420` — settlement variance. ⭐ DECISION TAKEN (spec §5, "needs Ian", recommended).
--
-- A below-tolerance shortfall could be folded into `6400 Platform and channel fees`, and it would
-- balance. ⛔ But a channel that systematically under-remits by ₱40 a day would then read as a
-- slightly worse fee rate and never be seen. Its own account makes the pattern visible, which is
-- the entire reason for measuring it.
INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '6420', 'Channel settlement variance', 'expense', 'debit', h.id, true, true, false, 'active'
FROM "accounts" h
WHERE h.code = '6000'
  AND NOT EXISTS (
	SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '6420'
);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Per-channel configuration the settlement needs.
--
-- ⚠️ `destination_money_account_id` is per-channel CONFIG, not a constant: Grab and Foodpanda do
-- not have to bank into the same account, and hard-coding one would be wrong the first time they
-- differ.
ALTER TABLE "sales_channels" ADD COLUMN "destination_money_account_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_destination_money_account_fk"
	FOREIGN KEY ("destination_money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict;--> statement-breakpoint

-- ⭐ v1's per-channel switch, kept, defaulting to `expense` (spec §7).
--
-- Withholding tax is booked to `6800 Taxes and licences` — an EXPENSE, not an asset. RR 2-98
-- §2.58.3(B): a creditable withholding tax may be claimed only when the income payment has been
-- declared as part of gross income with the 2307 attached. Bible §13 row 75 records that reported
-- sales are not all sales and that this ledger is never a filing basis, so the credit cannot be
-- realised — and an asset is a resource from which future benefit is expected. There is none.
--
-- ⛔ NO `1270` creditable-withholding-tax asset is seeded. An account that exists invites someone
-- to use it, and an unrealisable asset on the balance sheet is worse than no account at all. The
-- flag decides which account the leg hits if that posture ever changes.
ALTER TABLE "sales_channels" ADD COLUMN "tax_treatment" text DEFAULT 'expense' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_tax_treatment_check"
	CHECK ("tax_treatment" in ('expense', 'creditable'));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. The settlement itself — one platform payout against one channel-day.
--
-- ⚠️ A multi-day payout is N rows sharing a `reference`, never one row spanning days: the identity
-- below is checkable precisely because a settlement clears exactly one day.
CREATE TABLE "channel_settlements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"sales_day_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"gross_amount" numeric(14, 2) NOT NULL,
	"outstanding_cleared" numeric(14, 2) NOT NULL,

	-- ⭐ TYPED COLUMNS, NOT ROWS — deliberately the opposite of `sales_day_channels`. That table
	-- uses rows because channels are open-ended per-store configuration; deduction kinds are a
	-- CLOSED SET OF SIX, and a seventh needs an ACCOUNT DECISION before it needs a column. Making
	-- a new kind a migration rather than a data row is the point: the decision cannot be smuggled
	-- in as data.
	--
	-- ⚠️ NONE of them is constrained non-negative. A negative deduction is a real credit — a
	-- promo-heavy day genuinely returns money — and v1 shipped a bug by assuming otherwise.
	"commission" numeric(14, 2) DEFAULT '0' NOT NULL,
	"marketing" numeric(14, 2) DEFAULT '0' NOT NULL,
	"platform_fee" numeric(14, 2) DEFAULT '0' NOT NULL,
	"vat_on_fees" numeric(14, 2) DEFAULT '0' NOT NULL,
	"withholding_tax" numeric(14, 2) DEFAULT '0' NOT NULL,
	"penalty" numeric(14, 2) DEFAULT '0' NOT NULL,

	-- Opposite directions of the same difference; both non-zero is incoherent.
	"variance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"settlement_gain" numeric(14, 2) DEFAULT '0' NOT NULL,

	"loan_deduction" numeric(14, 2) DEFAULT '0' NOT NULL,
	"loan_id" uuid,
	"loan_owner_store_id" uuid,
	"net_deposited" numeric(14, 2) NOT NULL,
	"destination_money_account_id" uuid NOT NULL,

	"reference" text,
	"settled_on" date NOT NULL,
	-- The 2307 the platform issues. ⭐ Captured NOW even though the tax is expensed, because it is
	-- the one document that cannot be obtained retroactively if the posture ever changes.
	"withholding_certificate_file_id" uuid,

	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,

	-- ⭐ THE IDENTITY, held by the database because it is one row and therefore checkable here.
	-- What the channel owed us, plus anything we under-reported, equals every deduction they made
	-- plus what they actually banked.
	CONSTRAINT "channel_settlements_identity_check" CHECK (
		abs(
			("outstanding_cleared" + "settlement_gain")
			- ("commission" + "marketing" + "platform_fee" + "vat_on_fees" + "withholding_tax"
			   + "penalty" + "variance" + "loan_deduction" + "net_deposited")
		) < 0.005
	),
	-- Fees exceeding the payout is a refusal, not a negative deposit.
	CONSTRAINT "channel_settlements_net_non_negative_check" CHECK ("net_deposited" >= 0),
	CONSTRAINT "channel_settlements_variance_shape_check" CHECK (
		"variance" >= 0 AND "settlement_gain" >= 0
		AND ("variance" = 0 OR "settlement_gain" = 0)
	),
	CONSTRAINT "channel_settlements_status_check" CHECK ("status" in ('draft','posted','voided')),
	CONSTRAINT "channel_settlements_posted_shape_check" CHECK (
		"status" <> 'posted' or ("posted_by" is not null and "posted_at" is not null and "journal_entry_id" is not null)
	),
	CONSTRAINT "channel_settlements_void_shape_check" CHECK (
		"status" <> 'voided' or ("voided_by" is not null and "voided_at" is not null and "void_reason" is not null)
	),
	-- A loan deduction names the loan it repays, or it is not a loan deduction.
	CONSTRAINT "channel_settlements_loan_shape_check" CHECK (
		("loan_deduction" = 0 and "loan_id" is null) or ("loan_deduction" <> 0 and "loan_id" is not null)
	)
);--> statement-breakpoint

ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_org_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_store_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_channel_fk"
	FOREIGN KEY ("channel_id") REFERENCES "public"."sales_channels"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_sales_day_fk"
	FOREIGN KEY ("sales_day_id") REFERENCES "public"."sales_days"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_loan_fk"
	FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_loan_owner_store_fk"
	FOREIGN KEY ("loan_owner_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_destination_money_account_fk"
	FOREIGN KEY ("destination_money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_withholding_certificate_fk"
	FOREIGN KEY ("withholding_certificate_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_journal_entry_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_posted_by_fk"
	FOREIGN KEY ("posted_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_voided_by_fk"
	FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

-- ⭐ ONE posted settlement per (channel, business date). A second is refused, never duplicated —
-- and a voided one does not block the corrected re-post, which is why the index is partial.
CREATE UNIQUE INDEX "channel_settlements_channel_day_key"
	ON "channel_settlements" USING btree ("channel_id","business_date")
	WHERE "status" = 'posted';--> statement-breakpoint
CREATE INDEX "channel_settlements_org_store_date_idx" ON "channel_settlements" USING btree ("org_id","store_id","business_date");--> statement-breakpoint
CREATE INDEX "channel_settlements_sales_day_idx" ON "channel_settlements" USING btree ("sales_day_id");--> statement-breakpoint

ALTER TABLE "channel_settlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_settlements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "channel_settlements_org_isolation" ON "channel_settlements"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
