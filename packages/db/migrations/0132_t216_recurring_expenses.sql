-- T-216 — recurring-expense TEMPLATES: the fixed bills that should not depend on somebody
-- remembering them.
--
-- ⛔ THERE ARE NO SYSTEM ROWS HERE, AND THE ABSENCE IS THE FEATURE. v1 seeds five payroll rows into
-- its `recurringExpenses` and then builds TWO independent mechanisms to stop anyone confirming them
-- (an `isSystem` flag AND a frozen `payroll__` id prefix — its own source calls this "belt and
-- braces"). They shipped ACTIVE and CONFIRMABLE, and confirming one would have posted a second real
-- cash movement for a payroll already paid, or expensed a statutory contribution already withheld
-- into a liability. The correct fix for "five rows nobody may confirm" is not to gate them; it is
-- not to create them. v2's payroll posts its own liabilities (T-189/T-190/T-193).
--
-- ⚠️ Hand-written, per DEF-073 / DEF-121 — `drizzle-kit generate`'s snapshot chain died at 0019.
--
-- ⚠️ THE JOB IS NOT IN THIS MIGRATION. `scheduler_runs_job_check` is deliberately untouched: whether
-- a due template DRAFTS an expense (this task's design) or AUTO-PAYS it (v1's) is an open decision
-- for Ian, and it changes the job's shape rather than a flag. Registering a job nothing runs would
-- be DEF-044's shape — a cron claimed in data and absent in fact.

CREATE TABLE "recurring_expenses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid NOT NULL,
	-- ⚠️ A DEFAULT, not the amount. Rent is fixed; electricity is not, and the drafted expense is
	-- edited against the real bill before anyone posts it.
	"default_amount" numeric(14, 2) NOT NULL,
	"default_money_account_id" uuid,
	-- ⛔ True only when the default account is a CASHIER account and a person chose it knowingly.
	-- v1's `payment-routing.ts` exists because a scheduled payment could drift onto the till: "a
	-- recurring/scheduled payment must never silently draw from the cashier till." A runtime fallback
	-- answers "what do we do with a bad value?"; this answers "how did a bad value get stored?".
	"till_is_deliberate" boolean DEFAULT false NOT NULL,
	"interval" text NOT NULL,
	"anchor_day" integer NOT NULL,
	-- ⭐ The job's ONLY cursor. One column, so "has this already drafted?" has exactly one answer.
	"next_due_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_drafted_expense_id" uuid,
	"last_drafted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "recurring_expenses_amount_check" CHECK ("default_amount" > 0),
	CONSTRAINT "recurring_expenses_interval_check"
		CHECK ("interval" IN ('weekly','bi_weekly','monthly','quarterly','annually')),
	CONSTRAINT "recurring_expenses_status_check" CHECK ("status" IN ('active','paused')),
	-- ⭐ ONE check, BOTH families: the anchor must be in range FOR ITS OWN INTERVAL. v1 stores an
	-- out-of-range anchor happily and clamps at read time, so a template can hold dayOfMonth 45 for
	-- ever and merely behave as though it said 31.
	-- ⛔ Note what this does NOT refuse: 29, 30 and 31 are all valid, because they CLAMP. Refusing
	-- them would make "the last day of the month" unexpressible, and that is one of the commonest
	-- real anchors there is.
	CONSTRAINT "recurring_expenses_anchor_day_check" CHECK (
		("interval" IN ('weekly','bi_weekly') AND "anchor_day" BETWEEN 0 AND 6)
		OR ("interval" IN ('monthly','quarterly','annually') AND "anchor_day" BETWEEN 1 AND 31)
	)
);--> statement-breakpoint

ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_category_id_expense_categories_id_fk"
	FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_money_account_id_fk"
	FOREIGN KEY ("default_money_account_id") REFERENCES "money_accounts"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⛔ SET NULL, and it is the one FK here that is not RESTRICT — for a reason found by writing the
-- cutover classification rather than by running the purge. This table is class KEEP (a standing fact
-- about how the business operates); `expenses` is class PURGE. A RESTRICT here would make a KEEP
-- table BLOCK the 1 January purge of a PURGE one. Provenance of a deleted draft is worth nothing.
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_last_drafted_expense_id_fk"
	FOREIGN KEY ("last_drafted_expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX "recurring_expenses_due_idx" ON "recurring_expenses" ("org_id","status","next_due_date");--> statement-breakpoint
CREATE INDEX "recurring_expenses_store_idx" ON "recurring_expenses" ("store_id","status");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE as the table is created (bible row 112), `app_current_org()` never a raw
-- `current_setting(...)::uuid` (DEF-077), and WITH CHECK as well as USING (DEF-183).
ALTER TABLE "recurring_expenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_expenses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "recurring_expenses_org_isolation" ON "recurring_expenses"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
