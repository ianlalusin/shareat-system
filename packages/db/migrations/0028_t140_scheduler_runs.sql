-- 0028 — T-140 (docs/tasks/140-month-end-scheduler.md): what the month-end scheduler did,
-- and — the point of the table — what it FAILED to do.
--
-- Hand-written for the RLS policy, as 0021, 0023, 0026 and 0027 were.
--
-- ## ⭐ The one place a figure is STORED rather than derived, and deliberately
--
--   a month that POSTED     -> derivable, the entry is right there
--   a month that FAILED     -> ⛔ NOT derivable; a failure leaves no trace by construction
--   a run that never HAPPENED -> ⛔ NOT derivable, and this is DEF-044 exactly
--
-- v1's depreciation stopped for two months, ₱35,483.98 a month went unbooked, and it was found by
-- an AUDIT rather than by anybody noticing — because the only evidence of a run was the postings
-- it made, and a run that makes no postings is indistinguishable from one that never ran.

--> statement-breakpoint
CREATE TABLE "scheduler_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"job" text NOT NULL,
	"period" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"posted_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	-- The reasons, verbatim. The most likely one is mundane and WILL happen: "no fiscal period
	-- covers 2026-06-30". It has to reach a screen, not a log nobody reads.
	"failures" jsonb,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"error" text,
	-- ⭐ "nobody has run it since March" and "the cron died in March and someone has been clicking
	-- the button" are different problems.
	"trigger" text DEFAULT 'cron' NOT NULL,
	CONSTRAINT "scheduler_runs_job_check" CHECK ("scheduler_runs"."job" in ('depreciation', 'amortisation')),
	CONSTRAINT "scheduler_runs_outcome_check" CHECK ("scheduler_runs"."outcome" in ('ok', 'partial', 'failed')),
	CONSTRAINT "scheduler_runs_period_shape_check" CHECK ("scheduler_runs"."period" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "scheduler_runs_counts_not_negative_check" CHECK ("scheduler_runs"."posted_count" >= 0 and "scheduler_runs"."skipped_count" >= 0 and "scheduler_runs"."failed_count" >= 0),
	-- ⚠️ An outcome and its failure count cannot disagree, or the screen would lie about the only
	-- thing this table exists to report.
	CONSTRAINT "scheduler_runs_outcome_matches_failures_check" CHECK (
		("scheduler_runs"."outcome" = 'ok' and "scheduler_runs"."failed_count" = 0)
		or ("scheduler_runs"."outcome" = 'partial' and "scheduler_runs"."failed_count" > 0 and "scheduler_runs"."posted_count" > 0)
		or ("scheduler_runs"."outcome" = 'failed')
	)
);
--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "scheduler_runs_org_job_started_idx" ON "scheduler_runs" ("org_id","job","started_at");--> statement-breakpoint
CREATE INDEX "scheduler_runs_outcome_idx" ON "scheduler_runs" ("outcome");--> statement-breakpoint

ALTER TABLE "scheduler_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduler_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scheduler_runs_org_isolation" ON "scheduler_runs"
	FOR ALL
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
