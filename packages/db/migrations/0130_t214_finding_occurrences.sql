-- T-214 — the manager responsiveness scorecard, and the clock findings do not have.
--
-- ⭐ `finding_occurrences` is an OBSERVATION log, not finding state. Read `schema/findings.ts`'s
-- header before changing anything here: that file deliberately has no `findings` table, because v1
-- stored a finding's state and resolving one suppressed tomorrow's recompute while the condition
-- still held (bible row 123). This table records "the detector reported this key on this day", and
-- ⛔ NOTHING in the detection path reads it — asserted by a test, not promised by a comment.
--
-- It exists because a `DetectedFinding` carries no timestamp and cannot: it is a pure function of
-- current state, and almost no detector can be re-asked "as of" a past date. So when a finding first
-- appeared is not recoverable from anywhere, and both components of the scorecard need it.

CREATE TABLE "finding_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid,
	"finding_key" text NOT NULL,
	"kind" text NOT NULL,
	"opened_on" date NOT NULL,
	"last_seen_on" date NOT NULL,
	"closed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_occurrences_window_check" CHECK ("last_seen_on" >= "opened_on"),
	CONSTRAINT "finding_occurrences_closed_after_open_check" CHECK ("closed_on" IS NULL OR "closed_on" >= "opened_on")
);--> statement-breakpoint

ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⭐ At most ONE OPEN occurrence per key. This is what makes the daily job idempotent and safely
-- re-runnable, and it is the constraint the whole design leans on.
-- ⚠️ `coalesce` because NULL never equals NULL in a unique index — without it the ORG-WIDE findings
-- (store_id IS NULL: a trial balance belongs to no branch) would be the only ones exempt from the
-- rule that matters most to them.
CREATE UNIQUE INDEX "finding_occurrences_one_open_idx" ON "finding_occurrences"
	("org_id", coalesce("store_id", '00000000-0000-0000-0000-000000000000'::uuid), "finding_key")
	WHERE "closed_on" IS NULL;--> statement-breakpoint
CREATE INDEX "finding_occurrences_period_idx" ON "finding_occurrences" ("org_id","opened_on");--> statement-breakpoint
CREATE INDEX "finding_occurrences_store_idx" ON "finding_occurrences" ("org_id","store_id","opened_on");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- `finding_views` — who actually opened /findings. v1 logs the same thing (`insightViewLog`), and
-- T-135 kept it deliberately: "a finding nobody is accountable for is a finding nobody clears."
-- ⚠️ Recorded, NOT scored — scoring page-opens pays people to open pages.

CREATE TABLE "finding_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"viewed_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "finding_views" ADD CONSTRAINT "finding_views_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "finding_views" ADD CONSTRAINT "finding_views_person_id_persons_id_fk"
	FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- One row per person per Manila day, so a refresh is not a second view.
CREATE UNIQUE INDEX "finding_views_person_day_idx" ON "finding_views" ("org_id","person_id","viewed_on");--> statement-breakpoint
CREATE INDEX "finding_views_org_day_idx" ON "finding_views" ("org_id","viewed_on");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE as the tables are created (bible row 112). Both carry their own org_id,
-- so both use the plain org_column form.
-- ⚠️ DEF-183's lesson applies to the WITH CHECK as much as the USING: a policy that only filters
-- reads still lets a write plant a row labelled with another org's id.
ALTER TABLE "finding_occurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finding_occurrences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finding_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finding_views" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "finding_occurrences_org_isolation" ON "finding_occurrences"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "finding_views_org_isolation" ON "finding_views"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- scheduler_runs — register the DAILY observation job as a T-140 job.
-- ⚠️ SHARED TABLE, and this is the third lane to widen this constraint. If another lane's migration
-- also widens `scheduler_runs_job_check` between this one and that one, the two DROP/ADD pairs must
-- be reconciled into ONE final constraint naming every job from every lane — see 0126's own note.
-- ⛔ DEF-044's lesson stands and is why the job is registered at all: v1's seed data claimed rows
-- were "auto-generated by the depreciation cron" and no such cron ever existed. Registering the job
-- is not the same as arming its timer — `docs/ops/README.md` is where that finishes.
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation','amortisation','attendance_sweep','mirror_publish','inbox_relay','order_wastage_backstop','finding_observation'));
