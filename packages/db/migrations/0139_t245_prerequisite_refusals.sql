-- T-245 — the prerequisite-refusal counter's storage.
-- docs/tasks/245-prerequisite-refusal-counter.md §2.
--
-- ⛔ An APPEND-ONLY observation log, not a stored counter (bible §4.2 rule 7, row 173) — the same
-- shape as `finding_occurrences` (0130, T-214, bible row 177). Every row is immutable once written:
-- no `updated_at`, no unique constraint — hitting the same wall twice is two data points, not one
-- row to dedupe. "How many times has X happened" is always count(*)/max(occurred_at) computed at
-- read time, never a value carried forward.
--
-- Message text is deliberately NOT a column: the rendered sentence belongs to the domain layer and
-- is free to be reworded without a migration. `reason_code` is the stable identity a report groups
-- on, chosen once at the throw site — `finding_key`'s exact role on the table beside this one.
--
-- ⛔ Written on an INDEPENDENT transaction, never the throwing caller's own `tx` — see
-- `packages/domain/src/attendance/credentials.ts`'s `recordPrerequisiteRefusal`, which opens one via
-- `withOrgPrincipal` before calling `prerequisiteRefusalsRepo.record`. The caller's transaction
-- aborts on the throw that follows; this row must not abort with it.

CREATE TABLE "prerequisite_refusals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid,
	"reason_code" text NOT NULL,
	"domain" text NOT NULL,
	"actor_person_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "prerequisite_refusals" ADD CONSTRAINT "prerequisite_refusals_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "prerequisite_refusals" ADD CONSTRAINT "prerequisite_refusals_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "prerequisite_refusals" ADD CONSTRAINT "prerequisite_refusals_actor_person_id_persons_id_fk"
	FOREIGN KEY ("actor_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "prerequisite_refusals_org_occurred_idx" ON "prerequisite_refusals" ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "prerequisite_refusals_org_reason_idx" ON "prerequisite_refusals" ("org_id","reason_code");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE as the table is created (bible row 112). Org-scoped only, so the plain
-- org_column form (packages/db/src/rls/registry.ts's entry for this table).
-- ⚠️ DEF-183's lesson applies to the WITH CHECK as much as the USING: a policy that only filters
-- reads still lets a write plant a row labelled with another org's id.
ALTER TABLE "prerequisite_refusals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "prerequisite_refusals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "prerequisite_refusals_org_isolation" ON "prerequisite_refusals"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
