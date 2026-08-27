-- 0034 — T-144: cash requests. Bible row 159.
--
-- Postings already verified in POSTING-PATTERNS.md §Cash request, from real v1 data (82 release
-- legs, 52 return legs):
--
--   release   DR 1120 staff float   CR the funding account
--   spend     DR the expense        CR 1120                  ← T-122 ALREADY DOES THIS
--   return    DR the funding acct   CR 1120
--   shortage  DR staff advance      CR 1120
--                                          -> 1120 nets to ZERO
--
-- ⚠️ The REQUEST posts nothing (bible §16.10). Asking for money is not a financial event; only the
-- release is. Posting on request would show a float in someone's hands before anyone handed it over.

--> statement-breakpoint
-- ⭐ 1120 GAINS A PARTY, AND THE PARTY IS THE REQUEST.
--
-- POSTING-PATTERNS records that in v1 "1120 is NOT a requires_party account — it is a plain asset".
-- That is the shape v2 improves, for the third time and for the same reason as the wallet (row 142)
-- and the loan (row 158): one store has ONE staff-float account, but TWO PEOPLE CAN HOLD FLOATS AT
-- ONCE, and one person can hold two. With no party, P2,000 with Ana and P3,000 with Ben is P5,000 at
-- 1120 and the ledger cannot say whose is whose — so "who still owes a liquidation?" would need a
-- second register, which is how v1's loans ended up with three.
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_party_type_check";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_type_check"
	CHECK (
		"journal_lines"."party_type" is null
		or "journal_lines"."party_type" in ('supplier', 'customer', 'employee', 'store', 'channel', 'money_account', 'loan', 'cash_request')
	);--> statement-breakpoint

CREATE TABLE "cash_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	-- ⭐ Who will hold the float. The whole document exists to answer "who has the money".
	"requested_for" uuid NOT NULL,
	"purpose" text NOT NULL,
	"requested_amount" numeric(14, 2) NOT NULL,
	"requested_on" date NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"approved_amount" numeric(14, 2),
	"approved_by" uuid,
	"decided_on" date,
	"reject_reason" text,
	-- ⚠️ Named, not inferred — "the till" is not an account.
	"released_from_money_account_id" uuid,
	"released_on" date,
	"released_by" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "cash_requests_amount_positive_check" CHECK ("cash_requests"."requested_amount" > 0),
	CONSTRAINT "cash_requests_purpose_not_blank_check" CHECK (length(trim("cash_requests"."purpose")) > 0),
	CONSTRAINT "cash_requests_approved_positive_check" CHECK ("cash_requests"."approved_amount" is null or "cash_requests"."approved_amount" > 0),
	CONSTRAINT "cash_requests_status_check" CHECK ("cash_requests"."status" in
		('requested','approved','rejected','released','liquidated','cancelled')),
	-- ⛔ A refusal needs a reason; an approval needs an amount AND an approver. "Approved, but
	-- nobody says for how much" is not a state.
	CONSTRAINT "cash_requests_decision_shape_check" CHECK (
		("cash_requests"."status" in ('requested', 'cancelled'))
		or ("cash_requests"."status" = 'rejected' and "cash_requests"."reject_reason" is not null and "cash_requests"."approved_by" is not null)
		or ("cash_requests"."status" in ('approved','released','liquidated')
			and "cash_requests"."approved_amount" is not null and "cash_requests"."approved_by" is not null)
	),
	-- ⚠️ Released means the money left a NAMED account on a KNOWN date.
	CONSTRAINT "cash_requests_release_shape_check" CHECK (
		"cash_requests"."status" not in ('released', 'liquidated')
		or ("cash_requests"."released_from_money_account_id" is not null and "cash_requests"."released_on" is not null)
	)
);
--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_requested_for_persons_id_fk"
	FOREIGN KEY ("requested_for") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_approved_by_persons_id_fk"
	FOREIGN KEY ("approved_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_released_by_persons_id_fk"
	FOREIGN KEY ("released_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_released_from_money_account_id_money_accounts_id_fk"
	FOREIGN KEY ("released_from_money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "cash_requests_org_store_idx" ON "cash_requests" ("org_id","store_id");--> statement-breakpoint
CREATE INDEX "cash_requests_org_status_idx" ON "cash_requests" ("org_id","status");--> statement-breakpoint
CREATE INDEX "cash_requests_holder_idx" ON "cash_requests" ("requested_for");--> statement-breakpoint

ALTER TABLE "cash_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cash_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cash_requests_org_isolation" ON "cash_requests" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
