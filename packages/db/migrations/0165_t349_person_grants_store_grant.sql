-- 0165 — T-349 / DEF-456: "Hold in their own right" keeps the grant at that store.
-- docs/tasks/349-def-456-store-scoped-hold-own-right.md §3.1.
--
-- v1: authority came from a position held AT THAT STORE (0159's own header). T-291 §C3 / Ian's
-- decision 5 added one act on top: an administrator can make a job-derived capability the
-- person's own, so switching the job default off no longer takes it away. Since 0159 a
-- 'position' row always carries a store and every other row never does
-- (person_grants_store_shape_check), so a hand-grant made from a store-scoped position row has
-- nowhere to carry that store — it lands person-level (store_id NULL) and authorises at every
-- store the person has scope at (DEF-456). This migration gives a 'grant' row somewhere to carry
-- a store, alongside the person-level (NULL) shape it already had.
--
-- Planner ruling (coexist, not upgrade in place): a separate 'grant' row AT the position row's
-- store, next to the 'position' row, so the hand grant and the job grant each survive the
-- other's removal — revoking the hand grant leaves the job access at that store untouched, and
-- the next reconcile re-inserting the 'position' row does not collide with an upgraded row. The
-- repo layer (S2) and the page fold (S2) are a separate slice; this migration only makes the
-- shape legal.
--
-- Two steps, plus a NULL-blind hole this migration closes on the way past:
--   1. Shape CHECK, replaced. The 0159 CHECK reads `grant_source = 'position' AND store_id IS
--      NOT NULL) OR (grant_source IS DISTINCT FROM 'position' AND store_id IS NULL)`. For a NULL
--      grant_source with a store set, branch 1 is `NULL = 'position'` → NULL, and branch 2 is
--      `NULL IS DISTINCT FROM 'position'` → TRUE, `AND store_id IS NULL` → FALSE, so branch 2 is
--      FALSE. `NULL OR FALSE` is NULL, and Postgres accepts a NULL CHECK result — a NULL-source
--      row with a store slips through undetected. No such row exists today (live-data tally,
--      task doc §1). `IS NOT DISTINCT FROM` closes it: 'position' with a store, 'grant' with or
--      without one, and everything else (elevation/owner/NULL) with no store — nothing else.
--   2. Per-store active slot, split by source. The 0159 index
--      (person_grants_active_position_store_unique) enforced one active per-store row per
--      (person, grant_name, store) with no source term, so a 'grant' row at a position row's own
--      store would collide with it. Split into two partial indexes, one per source, so a
--      'position' row and a 'grant' row can each hold their own active slot at the same store.
--
-- Step 3 (not shipped here) is the DEF-456 data repair — re-scoping the rows this defect already
-- widened to org-wide. It is slice S3, migration 0166, built only if Ian answers open question Q1
-- (task doc §9); it needs 0165 applied first and never blocks S1/S2.
-- Step 4: no trigger, RLS, policy or FK change. The fill trigger stays 'position'-only (a 'grant'
-- row's store comes from the app layer, S2, never a trigger); the new rows carry source_ref NULL,
-- so the composite (source_ref, store_id) FK from 0159 step 8 — MATCH SIMPLE, so a NULL in either
-- referencing column skips the check — does not apply to them (0159's own note describes only the
-- mirror case: a NULL store_id with source_ref set). The single-column store_id -> stores FK
-- (0159 step 1) still applies to every row that carries a store, 'grant' included.
--
-- HAND-WRITTEN, per ADR-012 §5 (packages/db/migrations/README.md) — drizzle-kit generate is
-- retired. Never edited after apply (RULES §1 rule 9).

-- ---------------------------------------------------------------------------------------------
-- Step 1 — shape CHECK, replaced. IS NOT DISTINCT FROM closes the NULL-blind hole (see header).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "person_grants" DROP CONSTRAINT "person_grants_store_shape_check";--> statement-breakpoint
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_store_shape_check" CHECK (
	("grant_source" IS NOT DISTINCT FROM 'position' AND "store_id" IS NOT NULL)
	OR ("grant_source" IS NOT DISTINCT FROM 'grant')
	OR ("grant_source" IS DISTINCT FROM 'position' AND "grant_source" IS DISTINCT FROM 'grant' AND "store_id" IS NULL)
);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 2 — the per-store active slot becomes two, one per source. A 'position' row and a 'grant'
-- row can now each hold one active row at the same store; the person-level slot (store_id IS
-- NULL) is unchanged.
-- ---------------------------------------------------------------------------------------------
DROP INDEX "person_grants_active_position_store_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "person_grants_active_position_store_unique" ON "person_grants"
	("person_id","grant_name","store_id") WHERE "revoked_at" IS NULL AND "store_id" IS NOT NULL AND "grant_source" = 'position';--> statement-breakpoint
CREATE UNIQUE INDEX "person_grants_active_grant_store_unique" ON "person_grants"
	("person_id","grant_name","store_id") WHERE "revoked_at" IS NULL AND "store_id" IS NOT NULL AND "grant_source" = 'grant';--> statement-breakpoint
