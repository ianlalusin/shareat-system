-- T-216 Part 2 — the recurring-expense drafting JOB. docs/tasks/216-recurring-expense-automation.md
-- §J5. Ian, 6–7 Sep 2026: v2 DRAFTS, never auto-pays.
--
-- ⚠️ Hand-written, per DEF-073 / DEF-121 — `drizzle-kit generate`'s snapshot chain died at 0019 and
-- the tool opens by asking whether `expenses.supplier_invoice_id`, created ninety migrations ago, is
-- a rename. Same convention as 0131, 0132 and 0133, which say so in their own headers.
--
-- ⛔ Registering the job is NOT arming its timer. DEF-044 is what happens when a cron is claimed and
-- never existed; DEF-194 records that three jobs have now shipped unarmed because `docs/` is not in
-- the deploy artifact. `docs/ops/README.md` is where this finishes, and only Ian can finish it.

-- ---------------------------------------------------------------------------------------------
-- 1. `recurring_expenses.supplier_id` — the column that makes drafting possible at all.
--
-- ⛔ WHY THIS EXISTS: the original spec said the job would "call `createExpense` unchanged". It
-- cannot. `expenses.supplier_id` and `expenses.supplier_invoice_id` are both NOT NULL, gated in
-- `createExpense` and backstopped by the `expenses_check_invoice_open_for_recording` trigger, and
-- `createExpense` is the only caller of `insertExpense` in the tree. A machine with no supplier
-- cannot record an expense. So the template names one, and the job creates the pending invoice.
--
-- ⚠️ NULLABLE, deliberately. Existing templates have no supplier and a NOT NULL would refuse this
-- migration. The rule lives where it can be REPORTED instead: the job refuses such a template and
-- names it in the run's failures, and `/expenses/recurring` shows which ones are unset — the same
-- insist-on-screen shape T-229 used for the TIN. A NEWLY created template must name one.
ALTER TABLE "recurring_expenses" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_supplier_id_suppliers_id_fk"
	FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "recurring_expenses_supplier_idx" ON "recurring_expenses" ("supplier_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. `recurring_expense_drafts` — idempotency as a database FACT, not as a promise.
--
-- ⭐ THE UNIQUE INDEX IS THE INVARIANT, not the cursor. `next_due_date` already stops the ordinary
-- second run of the day. This stops the ones the cursor cannot see: two job processes racing, or a
-- cursor moved backwards by a template edit. `insertDraftRecord` is ON CONFLICT DO NOTHING and a
-- zero-row return means somebody already drafted that date — the same idiom as
-- `budgetsRepo.insertReissued`.
--
-- ⛔ WHY NOT THE INVOICE NUMBER, which was the first proposal: `supplier_invoices.invoice_no` says
-- in its own schema that it is "read by the warn-only duplicate check, never a unique constraint",
-- and there is no unique index on it — so a duplicate `RECUR-…` would be created silently.
--
-- ⛔ AND WHY THE DUE DATE, NOT THE PERIOD: a WEEKLY template has four or five due dates inside one
-- `YYYY-MM`. A per-period key would draft a weekly bill once a month and look correct doing it.
CREATE TABLE "recurring_expense_drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"recurring_expense_id" uuid NOT NULL,
	-- The date this draft was created FOR — the template's cursor at the moment it drafted, never
	-- "today". A catch-up run drafts for a date in the past and this is that date.
	"due_date" date NOT NULL,
	"expense_id" uuid,
	"supplier_invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "recurring_expense_drafts" ADD CONSTRAINT "recurring_expense_drafts_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- CASCADE: the row is provenance about ONE template and means nothing without it. A template that
-- has drafted cannot be deleted by the domain anyway (it is paused instead), so this fires only on a
-- genuine removal.
ALTER TABLE "recurring_expense_drafts" ADD CONSTRAINT "recurring_expense_drafts_template_fk"
	FOREIGN KEY ("recurring_expense_id") REFERENCES "recurring_expenses"("id") ON DELETE CASCADE;--> statement-breakpoint

-- ⛔ SET NULL on BOTH document pointers, and it is 0132's lesson applied a second time. This table
-- is reached from a KEEP table but points at PURGE ones (`expenses`, `supplier_invoices`); a
-- RESTRICT here would let it BLOCK the 1 January purge. The row's own class is `purge` — it is
-- provenance ABOUT expenses, and when they go it has nothing left to describe — so in practice it
-- goes with them; SET NULL is the honest belt for the interval in which one is deleted alone.
ALTER TABLE "recurring_expense_drafts" ADD CONSTRAINT "recurring_expense_drafts_expense_fk"
	FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "recurring_expense_drafts" ADD CONSTRAINT "recurring_expense_drafts_invoice_fk"
	FOREIGN KEY ("supplier_invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "recurring_expense_drafts_once_idx"
	ON "recurring_expense_drafts" ("recurring_expense_id","due_date");--> statement-breakpoint
CREATE INDEX "recurring_expense_drafts_expense_idx" ON "recurring_expense_drafts" ("expense_id");--> statement-breakpoint

-- RLS — ENABLE and FORCE as the table is created (bible row 112), `app_current_org()` never a raw
-- `current_setting(...)::uuid` (DEF-077), and WITH CHECK as well as USING (DEF-183).
ALTER TABLE "recurring_expense_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_expense_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "recurring_expense_drafts_org_isolation" ON "recurring_expense_drafts"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. `scheduler_runs_job_check` — register `recurring_expenses`, and close DEF-217 while here.
--
-- ⚠️ SHARED TABLE. If another lane's migration also widens this constraint, the two DROP/ADD pairs
-- must be reconciled into ONE naming every job from every lane — 0126, 0130 and 0131 all carry the
-- same warning, for the same reason.
--
-- ⛔ DEF-217, found writing this migration: `budget_reissue` is in the LIVE constraint (0131) but
-- missing from `packages/db/schema/scheduler.ts`'s own `check()` list — nine names in
-- `SCHEDULER_JOBS`, eight in the check beside it. Inert today, because migrations build the database
-- and the schema file does not. Dangerous tomorrow, because the next widening migration is written
-- by copying that list, and copying it would silently drop `budget_reissue` from the constraint and
-- break T-215's job at its next run. The schema file is corrected in the same change as this.
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation','amortisation','attendance_sweep','mirror_publish','inbox_relay',
	                 'order_wastage_backstop','finding_observation','budget_reissue','recurring_expenses'));
