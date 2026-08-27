-- 0040 — T-128: generic liabilities.
--
-- HAND-WRITTEN, like 0020-0039. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ 2500 Accrued and other liabilities — the RESIDUAL control account, party-requiring, with the
-- obligation itself as the party. Fifth application of the same rule: the wallet (row 142), the loan
-- (row 158), the cash request (row 159), the owner (row 160), now the obligation.
--
-- ⛔ STATUTORY PAYABLES (2210-2240) ARE DELIBERATELY LEFT ALONE AND STAY PARTY-FREE.
-- Two things already depend on that: the `statutory_remittance` pattern debits 2210 with no party,
-- and payroll will accrue into those accounts when it is built. Making them party-requiring would
-- break something that already works to serve a module that does not need it — and recording an SSS
-- obligation HERE as well would put the same debt in 2500 and 2210 at once, with nothing
-- reconciling them. The service refuses it, naming the reason.
--
-- ⛔ NO BALANCE COLUMNS ON `liabilities`, for the fourth time (DEF-074). v1 keeps
-- outstandingBalance / totalCharged / totalPaid on the account plus a LiabilityLedgerEntry with its
-- own balanceBefore/balanceAfter. Here everything is summed from 2500 by party.

INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '2500', 'Accrued and other liabilities', 'liability', 'credit', h.id, true, true, true, 'active'
FROM "accounts" h
WHERE h.code = '2000'
  AND NOT EXISTS (
	SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '2500'
);--> statement-breakpoint

ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_party_type_check";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_type_check"
	CHECK (
		"journal_lines"."party_type" is null
		or "journal_lines"."party_type" in ('supplier', 'customer', 'employee', 'store', 'channel', 'money_account', 'loan', 'cash_request', 'owner', 'liability')
	);--> statement-breakpoint

CREATE TABLE "liabilities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"description" text,
	-- ⭐ A genuine ADD: v1 has no due date on a liability at all, so it can show what is owed and
	-- never what is LATE — the question people open the screen to ask.
	"due_on" date,
	-- ⚠️ Retired is NOT settled. Settled is derived from the ledger; this says somebody decided to
	-- stop using the row. A balance of zero today is not a promise of zero tomorrow.
	"retired_at" timestamp with time zone,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "liabilities_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "liabilities_category_check" CHECK (
		"category" in ('taxes_payable','government_contributions','accrued_expenses','other')
	)
);
--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "liabilities_org_store_idx" ON "liabilities" USING btree ("org_id","store_id");--> statement-breakpoint
CREATE INDEX "liabilities_due_on_idx" ON "liabilities" USING btree ("due_on");--> statement-breakpoint

ALTER TABLE "liabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "liabilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "liabilities_org_isolation" ON "liabilities"
	USING ("org_id" = current_setting('app.org_id', true)::uuid)
	WITH CHECK ("org_id" = current_setting('app.org_id', true)::uuid);
