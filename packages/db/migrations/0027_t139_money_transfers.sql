-- 0027 — T-139 (docs/tasks/139-money-transfers.md): moving money between the places it sits.
--
-- Hand-written for the RLS policy, as 0021, 0023 and 0026 were: drizzle-kit generates no policies,
-- and a registry entry without one is "a promise, not a control".
--
-- The 4th most-used entry in v1 (POSTING-PATTERNS.md §Transfer, 926 legs). Two balance-sheet legs,
-- plus a third to an expense account when a fee applies.
--
-- ## ⭐ Both amounts are stated; the fee is DERIVED
--
-- v1 takes one `amount` and charges the source `amount + fee`. This project's own posting doc
-- narrates the same three legs the other way round. The legs are identical either way — but the
-- same number typed in the same box would produce two different transfers, and BOTH readings are
-- real here: a bank wire adds its fee to the source, a GCash cash-out deducts it from the target.
-- Asking for both figures removes the convention entirely, and each is a number a person reads off
-- the statement they are reconciling against.
--
-- ⛔ So there is no `fee` column. It is amount_out − amount_in.

--> statement-breakpoint
CREATE TABLE "money_transfers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	-- ⚠️ Both ends are at THIS store. Cross-store money movement is an inter-entity transaction
	-- that must eliminate on consolidation — a different problem, and a different task.
	"store_id" uuid NOT NULL,
	"from_money_account_id" uuid NOT NULL,
	"to_money_account_id" uuid NOT NULL,
	"amount_out" numeric(14, 2) NOT NULL,
	"amount_in" numeric(14, 2) NOT NULL,
	"fee_account_code" text,
	"transfer_date" date NOT NULL,
	"reference" text,
	"notes" text,
	"journal_entry_id" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"voided_on" date,
	"void_reason" text,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "money_transfers_amount_out_positive_check" CHECK ("money_transfers"."amount_out" > 0),
	CONSTRAINT "money_transfers_amount_in_positive_check" CHECK ("money_transfers"."amount_in" > 0),
	-- ⛔ Money arriving that never left is not a transfer — it is income, and it must not be
	-- enterable here. Equality is the ordinary case: no fee.
	CONSTRAINT "money_transfers_fee_not_negative_check" CHECK ("money_transfers"."amount_in" <= "money_transfers"."amount_out"),
	-- A fee with nowhere to land would silently vanish from the P&L while the entry still balanced
	-- — the exact trap POSTING-PATTERNS §Transfer warns about.
	CONSTRAINT "money_transfers_fee_needs_account_check" CHECK (("money_transfers"."amount_in" = "money_transfers"."amount_out") or ("money_transfers"."fee_account_code" is not null)),
	CONSTRAINT "money_transfers_distinct_accounts_check" CHECK ("money_transfers"."from_money_account_id" <> "money_transfers"."to_money_account_id"),
	CONSTRAINT "money_transfers_status_check" CHECK ("money_transfers"."status" in ('posted', 'voided')),
	CONSTRAINT "money_transfers_void_shape_check" CHECK (("money_transfers"."status" = 'voided') = ("money_transfers"."voided_on" is not null and "money_transfers"."void_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_from_money_account_id_money_accounts_id_fk"
	FOREIGN KEY ("from_money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_to_money_account_id_money_accounts_id_fk"
	FOREIGN KEY ("to_money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_journal_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_voided_by_persons_id_fk"
	FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "money_transfers_org_store_date_idx" ON "money_transfers" ("org_id","store_id","transfer_date");--> statement-breakpoint
CREATE INDEX "money_transfers_from_idx" ON "money_transfers" ("from_money_account_id");--> statement-breakpoint
CREATE INDEX "money_transfers_to_idx" ON "money_transfers" ("to_money_account_id");--> statement-breakpoint
-- One transfer, one entry. A second row pointing at the same entry would double-count the movement
-- in every report that joins the two.
CREATE UNIQUE INDEX "money_transfers_journal_entry_unique" ON "money_transfers" ("journal_entry_id");--> statement-breakpoint

ALTER TABLE "money_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "money_transfers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "money_transfers_org_isolation" ON "money_transfers"
	FOR ALL
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
