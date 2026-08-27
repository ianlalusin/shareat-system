-- 0038 — T-127: the two-route personal expense, and the monthly drawings close.
--
-- HAND-WRITTEN, like 0020-0037. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ Ian, 2026-08-27, after evaluating a three-route cascade: "go to your 2route version, and for
-- drawing can we make monthly close for that too so all drawings within the cut off period is
-- reconciled and recorded properly and akcnowledge adjustment if any visible and enforced."
--
-- ⛔ WHY takes_salary (0037) GOES AWAY AFTER ONE DAY.
-- 0037 routed a personal expense by whether the owner drew a salary. The design that replaced it
-- routes by whether the money is EXPECTED BACK, which is the line the tax treatment actually turns
-- on: a payment made with no expectation of repayment is a distribution however it is labelled.
-- Whether the owner is on payroll no longer picks the ACCOUNT — it only decides which settlement
-- path is available once a receivable exists. So the column has no reader, and an unread column
-- that looks like policy is worse than no column.
--
-- ⚠️ Not folded back into 0036/0037: this project does not edit an applied migration (bible §15.5).
-- The trail showing the design changed, and why, is worth more than a tidy history.

ALTER TABLE "owners" DROP COLUMN "takes_salary";--> statement-breakpoint

ALTER TABLE "owners" ADD COLUMN "personal_expense_treatment" text DEFAULT 'repayable' NOT NULL;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_personal_expense_treatment_check"
	CHECK ("owners"."personal_expense_treatment" in ('repayable','drawing'));--> statement-breakpoint

-- ⭐ 1260 Due from owners. A personal expense the business expects back is a RECEIVABLE, not a
-- reduction of equity. Party-requiring, party_type = 'owner'.
-- ⚠️ Inserted for every org that already has a chart; the seed carries it for new ones.
-- ⚠️ The parent is a uuid FK (`parent_id`), not a code — resolved here from the 1000 header of the
-- SAME org. Writing `parent_code` failed loudly, which is the FK doing its job.
INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '1260', 'Due from owners', 'asset', 'debit', h.id, true, true, true, 'active'
FROM "accounts" h
WHERE h.code = '1000'
  AND NOT EXISTS (
	SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '1260'
);--> statement-breakpoint

-- ⭐ THE MONTHLY DRAWINGS CLOSE.
-- `acknowledged_amount` is an ATTESTATION, not a maintained balance: it says what a named person
-- agreed to on a named date, and it does not change when the ledger does. It is stored precisely SO
-- THAT later divergence is visible — a close that stored nothing could not detect anything.
CREATE TABLE "owner_drawing_closes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"acknowledged_amount" numeric(14, 2) NOT NULL,
	"adjustment_amount" numeric(14, 2),
	"adjustment_reason" text,
	"adjustment_entry_id" uuid,
	"closed_on" date NOT NULL,
	"closed_by" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A month has exactly one identity, so two closes cannot describe the same period.
	CONSTRAINT "owner_drawing_closes_period_is_month_start_check"
		CHECK (date_trunc('month', "period_month") = "period_month"),
	CONSTRAINT "owner_drawing_closes_acknowledged_not_negative_check"
		CHECK ("acknowledged_amount" >= 0),
	-- ⛔ An adjustment is a three-part fact: an amount, a reason, and the entry that POSTED it.
	-- "Visible and enforced" means the books move, not that somebody typed a sentence about them.
	CONSTRAINT "owner_drawing_closes_adjustment_shape_check" CHECK (
		("adjustment_amount" is null and "adjustment_reason" is null and "adjustment_entry_id" is null)
		or ("adjustment_amount" is not null and "adjustment_amount" <> 0
		    and "adjustment_reason" is not null and length(trim("adjustment_reason")) > 0
		    and "adjustment_entry_id" is not null)
	)
);
--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_owner_id_owners_id_fk"
	FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_closed_by_persons_id_fk"
	FOREIGN KEY ("closed_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "owner_drawing_closes_org_store_idx" ON "owner_drawing_closes" USING btree ("org_id","store_id");--> statement-breakpoint
-- ⛔ One close per owner per month: the LOCK depends on "is this month closed?" having one answer.
CREATE UNIQUE INDEX "owner_drawing_closes_owner_month_key" ON "owner_drawing_closes" USING btree ("owner_id","period_month");--> statement-breakpoint

ALTER TABLE "owner_drawing_closes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "owner_drawing_closes_org_isolation" ON "owner_drawing_closes"
	USING ("org_id" = current_setting('app.org_id', true)::uuid)
	WITH CHECK ("org_id" = current_setting('app.org_id', true)::uuid);
