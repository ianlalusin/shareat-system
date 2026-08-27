-- 0033 — T-126: loans, a standard model. Bible row 158.
--
-- Ian, 2026-08-27: "that loan model in v1 is really flawed. I suggest build a standard one for
-- loan and we will build on top of it later to cater our case."
--
-- ## ⛔ THREE places recorded the same money in v1
--
-- `LoanPlain` carried FOUR running totals (totalPaid, principalPaid, interestPaid,
-- outstandingBalance -- the last commented "principalAmount - principalPaid", a stored copy of a
-- subtraction). Beside it sat a `loanPayments` collection, and beside THAT a `LoanLedgerEntry`
-- carrying its own `balanceBefore`. Three registers of one debt.
--
-- ⚠️ They drifted, and it was MEASURED: the ERPNext migration read both live Grab loans and
-- concluded "NEITHER figure is usable" -- one stale by fourteen days of unrecorded settlements,
-- the other reading zero payments because every settlement routed through a single
-- channelCfg.loanId ("a wiring artifact, not a fact").
--
-- ## ⭐ So there is ONE register, and it is the ledger
--
-- This table holds the TERMS. Every peso is a journal entry keyed source_type =
-- 'loan_disbursement' | 'loan_payment', source_id = the loan id, with 2400 = principal and
-- 7200 = interest. ⛔ There is deliberately NO loan_payments table.

--> statement-breakpoint
-- ⭐ The party on a 2400 line is THE LOAN, not the lender. That looks like the wrong noun until
-- you ask what a party is FOR: it makes each balance on a shared control account attributable, and
-- A LENDER CAN HOLD TWO LOANS -- v1's own data has exactly that, two Grab loans on Lipa. Keying on
-- the lender would merge two debts that must be tracked apart.
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_party_type_check";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_type_check"
	CHECK (
		"journal_lines"."party_type" is null
		or "journal_lines"."party_type" in ('supplier', 'customer', 'employee', 'store', 'channel', 'money_account', 'loan')
	);--> statement-breakpoint

CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	-- ⚠️ TEXT because there is no suppliers table yet (T-130 owns it). When it lands this gains an
	-- FK beside the name; the party on the LINE does not change.
	"lender_name" text NOT NULL,
	"name" text NOT NULL,
	"principal_amount" numeric(14, 2) NOT NULL,
	"interest_rate" numeric(8, 4) NOT NULL,
	-- ⛔ NOT NULL with no default, and v1 says exactly why: absent meant DIFFERENT THINGS on
	-- different rows -- annual on legacy loans, monthly on new ones, with nothing on the row to
	-- tell them apart. "A month is 30 days and a year is 365; they are not interchangeable."
	"rate_period" text NOT NULL,
	"interest_method" text NOT NULL,
	"payment_frequency" text NOT NULL,
	"term_periods" integer NOT NULL,
	"start_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"closed_on" date,
	"close_reason" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "loans_principal_positive_check" CHECK ("loans"."principal_amount" > 0),
	CONSTRAINT "loans_lender_not_blank_check" CHECK (length(trim("loans"."lender_name")) > 0),
	-- A negative rate is a gift, not a loan; nothing here models one.
	CONSTRAINT "loans_rate_not_negative_check" CHECK ("loans"."interest_rate" >= 0),
	CONSTRAINT "loans_term_positive_check" CHECK ("loans"."term_periods" >= 1),
	CONSTRAINT "loans_rate_period_check" CHECK ("loans"."rate_period" in ('day', 'month', 'year')),
	CONSTRAINT "loans_method_check" CHECK ("loans"."interest_method" in ('straight', 'amortizing', 'equal_principal')),
	CONSTRAINT "loans_frequency_check" CHECK ("loans"."payment_frequency" in ('daily','weekly','biweekly','monthly','quarterly','annual')),
	CONSTRAINT "loans_status_check" CHECK ("loans"."status" in ('active', 'paid_off', 'defaulted', 'written_off')),
	-- ⚠️ paid_off is exempt: it is reached by ARITHMETIC, not by somebody closing it with a reason.
	CONSTRAINT "loans_close_shape_check" CHECK (
		"loans"."status" in ('active', 'paid_off')
		or ("loans"."closed_on" is not null and "loans"."close_reason" is not null)
	)
);
--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "loans_org_store_idx" ON "loans" ("org_id","store_id");--> statement-breakpoint
CREATE INDEX "loans_org_status_idx" ON "loans" ("org_id","status");--> statement-breakpoint

ALTER TABLE "loans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "loans_org_isolation" ON "loans" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
