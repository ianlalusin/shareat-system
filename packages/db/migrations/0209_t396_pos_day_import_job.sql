-- T-396 S1: the 06:00 Manila POS day-import is a scheduler job (it writes a scheduler_runs row per org per run).
-- Hand-authored per ADR-012 section 5; the list below is every job SCHEDULER_JOBS names (0198's list plus pos_day_import).
-- No table, column or policy changes: the only change is the widened CHECK. The audit action sales_day.auto_imported is
-- dotted, so it lives in the catalogue only (never in 0197's list).
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay',
	                 'order_wastage_backstop', 'finding_observation', 'budget_reissue', 'recurring_expenses',
	                 'orphan_file_sweep', 'fiscal_period_seed', 'usage_auto_post', 'pos_day_import'));
