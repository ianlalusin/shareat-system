-- 0124 — T-204: the Firestore sync relay joins the scheduler. Closes DEF-132/DEF-134's wiring
-- half.
--
-- HAND-WRITTEN, like 0020-0123 (DEF-073 — never `db:generate` on this repo).
--
-- Two new jobs alongside depreciation/amortisation/attendance_sweep: `mirror_publish` (Lane A —
-- drains mirror_outbox to Firestore) and `inbox_relay` (Lane B — ingests /inbox into Postgres,
-- adjudicating each day a new punch lands in as it goes). Same table, same per-org-per-run
-- bookkeeping — DEF-044's rule applies here exactly as it already does to the three jobs on this
-- table: "it ran and did nothing" and "it never ran" must stay tellable apart.

alter table "scheduler_runs" drop constraint "scheduler_runs_job_check";--> statement-breakpoint
alter table "scheduler_runs"
  add constraint "scheduler_runs_job_check"
  check ("job" in ('depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay'));
