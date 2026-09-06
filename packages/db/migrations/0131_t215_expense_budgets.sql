-- T-215 — expense budgets: the envelope a store spends a category out of.
--
-- ⛔ A budget is NOT a ledger document. There is deliberately no `journal_entry_id` here for anyone
-- to reach for: a budget is an INTENTION and the ledger records FACTS. That is what keeps the whole
-- feature cheap, and it is the first line to re-read if a change to it ever starts to feel expensive.
--
-- ⛔ AND THERE IS NO `consumed_amount` COLUMN. v1 stores one on its budget document and increments
-- it from the expense actions; that is the same shape as AR's `outstanding_amount`, measured WRONG
-- on 106 of 794 live rows (13.3%). Bible §4.2 rule 7, as extended by §13 row 173, bans a
-- separately-accumulated counter "even when it is called a cache". Consumption is a `sum()` over
-- `expenses`, grouped by `category_id` — NEVER by `account_code`, because three codes in the seed
-- (`6890`, `6620`, `6600`) are each shared by two categories and an account-code roll-up silently
-- over-counts six envelopes.
--
-- ⚠️ Hand-written, per DEF-073 / DEF-121: `drizzle-kit generate`'s snapshot chain has been dead
-- since 0019 and the tool now opens by asking whether a column created 88 migrations ago is a
-- rename. Hand-writing from `schema/expense-budgets.ts` is this project's working convention.

CREATE TABLE "expense_budgets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"auto_reissue" boolean DEFAULT false NOT NULL,
	"reissue_interval" text,
	"reissued_from_id" uuid,
	"last_reset_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "expense_budgets_period_key_check" CHECK ("period_key" ~ '^[0-9]{6}$'),
	-- ⚠️ Zero is a VALUE, not "unset": zero means spend nothing in this category, and no row at all
	-- means no cap. Bible §6 — "a rate of 0 is a legitimate value, never unset".
	CONSTRAINT "expense_budgets_amount_check" CHECK ("amount" >= 0),
	CONSTRAINT "expense_budgets_reissue_interval_enum_check"
		CHECK ("reissue_interval" IS NULL OR "reissue_interval" IN
			('daily','weekly','bi_weekly','monthly','quarterly','annually')),
	-- ⛔ AUTO-REISSUE WITHOUT AN INTERVAL IS UNREPRESENTABLE, and this is the rule most worth having
	-- in the database rather than in a service. v1 enforces it in its action with a comment saying
	-- exactly why: "an auto-reissue budget MUST carry a valid interval, else the reissue processor
	-- silently skips it (no-op)" — a cap that quietly stops existing next period while its screen
	-- still says it renews. Phrased as bible row 104 demands: this names what the DATABASE refuses.
	CONSTRAINT "expense_budgets_reissue_interval_check"
		CHECK ("auto_reissue" = false OR "reissue_interval" IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_category_id_expense_categories_id_fk"
	FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- Provenance of an auto-created row: which budget the reissue job cloned it from.
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_reissued_from_id_fk"
	FOREIGN KEY ("reissued_from_id") REFERENCES "expense_budgets"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- ⚠️ Nullable: a row the JOB created has no person behind it, and `system` is not a person row.
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⭐ ONE envelope per category per store per period. This is the whole integrity story, and the
-- reissue job leans on it directly: a second run the same day hits this index rather than a promise
-- the job keeps, which is what makes "idempotent" a database fact.
CREATE UNIQUE INDEX "expense_budgets_unique_envelope" ON "expense_budgets"
	("org_id","store_id","category_id","period_key");--> statement-breakpoint
CREATE INDEX "expense_budgets_store_period_idx" ON "expense_budgets" ("store_id","period_key");--> statement-breakpoint
CREATE INDEX "expense_budgets_reissue_idx" ON "expense_budgets" ("auto_reissue","reissue_interval");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE as the table is created, never retrofitted (bible row 112).
-- ⚠️ DEF-183's lesson: the WITH CHECK matters as much as the USING. A policy that only filters
-- reads still lets a write plant a row labelled with another org's id.
-- ⚠️ And `app_current_org()`, never a raw `current_setting(...)::uuid` — DEF-077: a custom GUC
-- assigned only with SET LOCAL reads back as '' (not NULL) on a pooled connection, and the raw cast
-- then throws 22P02 where this form cleanly denies.
ALTER TABLE "expense_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "expense_budgets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "expense_budgets_org_isolation" ON "expense_budgets"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- scheduler_runs — register `budget_reissue` as a T-140 job.
-- ⚠️ SHARED TABLE. If another lane's migration also widens `scheduler_runs_job_check` between this
-- one and that one, the two DROP/ADD pairs must be reconciled into ONE constraint naming every job
-- from every lane — 0126 and 0130 both carry the same warning, for the same reason.
-- ⛔ Registering the job is NOT arming its timer. DEF-044 is what happens when a cron is claimed and
-- never existed, and DEF-194 records that three jobs have now shipped unarmed because `docs/` is not
-- in the deploy artifact. `docs/ops/README.md` is where this finishes, and only Ian can finish it.
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation','amortisation','attendance_sweep','mirror_publish','inbox_relay','order_wastage_backstop','finding_observation','budget_reissue'));
