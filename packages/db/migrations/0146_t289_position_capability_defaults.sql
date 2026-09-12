-- 0146 — T-289: position access defaults, the spine.
-- docs/tasks/289-position-access-defaults-spine.md §C1, §C2, §C3, §C13.
-- docs/plans/289-position-access-defaults-plan.md §3.
--
-- An administrator decides, once, that every holder of a job gets a capability in addition to
-- the role matrix — bible row 120's pattern ("decide once, at the moment a human is present, and
-- store the answer") applied to jobs. `position_capability_defaults` is that decision,
-- materialised into ordinary `person_grants` rows by `reconcilePositionGrants`
-- (packages/domain/src/people/position-defaults.ts), tagged `grant_source = 'position'` with
-- `source_ref` pointing back here.
--
-- Two independent changes, one migration (cheaper and more coherent than two, matching 0140's own
-- precedent of folding two related gaps into one migration):
--   1. CREATE TABLE "position_capability_defaults", RLS as it is created (bible row 112).
--   2. `person_grants` gains the value 'position' on `grant_source` and a new nullable
--      `source_ref` column back to this table, with a CHECK admitting exactly three shapes
--      (planner ruling, plan §11.1 — `IS DISTINCT FROM` closes the null-blind gap a naive
--      equality would leave: a NULL source must carry no ref either).
--
-- ⛔ No backfill. There are no defaults yet — the first toggle IS the backfill (plan §6).
--
-- HAND-WRITTEN, per ADR-012 §5 — drizzle-kit's snapshot chain has been dead since 0019 (13
-- snapshots against a 145-entry journal; `db:generate` fails closed and points here). Never
-- edited after apply (RULES §1 rule 9).

CREATE TABLE "position_capability_defaults" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "position_capability_defaults_revoke_check" CHECK (
		("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL)
		OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL
			AND "revoke_reason" IS NOT NULL AND btrim("revoke_reason") <> '')
	)
);--> statement-breakpoint

ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_position_id_positions_id_fk"
	FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_set_by_persons_id_fk"
	FOREIGN KEY ("set_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_revoked_by_persons_id_fk"
	FOREIGN KEY ("revoked_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- One ACTIVE default per (position, store, capability) — re-toggling after a revocation inserts
-- a NEW row, so each default's own window stays exact.
CREATE UNIQUE INDEX "position_capability_defaults_active_unique" ON "position_capability_defaults"
	("position_id","store_id","capability") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "position_capability_defaults_store_id_idx" ON "position_capability_defaults" ("store_id");--> statement-breakpoint
CREATE INDEX "position_capability_defaults_position_id_idx" ON "position_capability_defaults" ("position_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE as the table is created, never retrofitted (bible row 112).
-- ⚠️ `personKeyedAccess` is NOT set for this table (rls/registry.ts) — it is keyed on
-- (position, store), not on a person; `set_by`/`revoked_by` are audit columns, not the subject.
-- ⚠️ DEF-183's lesson still applies to the WITH CHECK, even without a person key: a policy that
-- only filters reads still lets a write plant a row labelled with another org's id.
-- ⚠️ `app_current_org()`, never a raw `current_setting(...)::uuid` — DEF-077: a custom GUC
-- assigned only with SET LOCAL reads back as '' (not NULL) on a pooled connection, and the raw
-- cast then throws 22P02 where this form cleanly denies.
ALTER TABLE "position_capability_defaults" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "position_capability_defaults" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "position_capability_defaults_org_isolation" ON "position_capability_defaults"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- person_grants — grant_source gains 'position'; source_ref points back at the default that
-- justified the row (§C2, §C3). 0140 stays applied and unedited (RULES §1 rule 9) — this moves
-- the constraint forward, the exact pattern 0143 used on 0003's functions.

ALTER TABLE "person_grants" DROP CONSTRAINT "person_grants_source_check";--> statement-breakpoint
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_source_check" CHECK (
	"grant_source" IS NULL OR "grant_source" IN ('elevation', 'position', 'owner', 'grant')
);--> statement-breakpoint

ALTER TABLE "person_grants" ADD COLUMN "source_ref" uuid;--> statement-breakpoint
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_source_ref_position_capability_defaults_id_fk"
	FOREIGN KEY ("source_ref") REFERENCES "position_capability_defaults"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "person_grants_source_ref_idx" ON "person_grants" ("source_ref");--> statement-breakpoint

-- Planner ruling, plan §11.1: three admitted shapes. A 'position' row ALWAYS carries a ref; a
-- 'grant' row MAY (history of an upgrade — §C5 transition 1, the ref is kept when a hand-grant
-- supersedes a position row); every other source — 'elevation', 'owner', and NULL — carries none.
-- `IS DISTINCT FROM` closes the null-blind gap a naive `<>` would leave open for a NULL source.
-- The migration applies cleanly to existing rows because none has a ref yet (proven by
-- integration case 13 on a scratch database).
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_position_source_ref_check" CHECK (
	("grant_source" = 'position' AND "source_ref" IS NOT NULL)
	OR ("grant_source" IS DISTINCT FROM 'position'
		AND ("source_ref" IS NULL OR "grant_source" = 'grant'))
);
