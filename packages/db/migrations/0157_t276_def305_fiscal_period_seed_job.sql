-- 0157 — T-276 (DEF-305): register `fiscal_period_seed` as a T-140-pattern scheduler job.
-- docs/tasks/276-def-305-fiscal-period-coverage.md, "Build slice (2026-09-25)" §2.
--
-- A fresh organisation is seeded 12 months of fiscal periods at bootstrap (T-264/DEF-284) and
-- never again — an org that runs more than a year with nobody opening `/admin/organizations`
-- eventually posts into a month that has no period at all, and `postEntry` refuses it. This
-- monthly job tops coverage back up to 12 months ahead and, per the approved option (c), backfills
-- any month that already ELAPSED with no period (created `open`, never closed retroactively) so
-- the gap is surfaced as a failure line rather than silently blocking every post in that month.
--
-- ⚠️ SHARED TABLE. If another lane's migration also widens `scheduler_runs_job_check` between this
-- one and the next, the two DROP/ADD pairs must be reconciled into ONE naming every job from every
-- lane — 0126, 0130, 0131, 0136 and 0144 all carry the same warning, for the same reason. This
-- slot (0157) is reserved for T-276 alone this cycle (DEF-091).
--
-- Hand-authored per ADR-012 §5 — `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay',
	                 'order_wastage_backstop', 'finding_observation', 'budget_reissue', 'recurring_expenses',
	                 'orphan_file_sweep', 'fiscal_period_seed'));
