-- 0144 — T-272 (DEF-299): register `orphan_file_sweep` as a T-140-pattern scheduler job.
-- docs/tasks/272-def-299-orphan-sweep-timer.md (the "Implementation spec, lane A" section governs).
--
-- `sweepOrphanedFiles` (packages/domain/src/files/index.ts) has never had a production caller
-- (DEF-299) and, until this task, ran once globally with no `orgId` at all — the closed cross-org
-- caller list's DEF-287 entry. `scheduler_runs.org_id` is NOT NULL, so a global run cannot be
-- recorded; T-272 scopes the sweep per organisation (mechanical — `stored_files.org_id` is already
-- NOT NULL, no schema change needed for that half) so it can be wired through the same
-- `runJobForOrg` harness as the other nine jobs.
--
-- ⚠️ SHARED TABLE. If another lane's migration also widens `scheduler_runs_job_check` between this
-- one and the next, the two DROP/ADD pairs must be reconciled into ONE naming every job from every
-- lane — 0126, 0130, 0131 and 0136 all carry the same warning, for the same reason. T-272's own
-- briefing reserved this slot (0144) as the only one held this cycle.
--
-- Hand-authored per ADR-012 §5 — `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay',
	                 'order_wastage_backstop', 'finding_observation', 'budget_reissue', 'recurring_expenses',
	                 'orphan_file_sweep'));
