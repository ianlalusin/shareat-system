-- 0159 — T-341 / DEF-414: a position grant authorises only at the store whose default produced it.
-- docs/tasks/341-def-414-person-grants-store.md §4; Amendments R1 and R3 (binding; R3 supersedes
-- R1 item 2 / R2 item 2).
--
-- v1: authority came from a position held AT THAT STORE. v2 today: defaults are per (position,
-- store), but the person_grants row they materialise has no store, so a Cook at A / Cashier at B
-- rings sales at A (DEF-414) — and a §2.2 sibling wrongly REVOKES a still-justified grant at a
-- second store when a same-rank position call at the second store never rewrote the stored ref.
-- Option 1 (a store dimension on position-sourced grants, over a live axis-2 derivation) is chosen
-- because it fixes both defects together without touching the self-grant refusal or row 115
-- ("grants are written on job change, never derived at check time").
--
-- Seven ordinary steps (§4.1 items 1,2,3,4,5,6,7,8) plus Amendment R1's two binding data repairs,
-- ordered so nothing here can transiently violate a constraint this same migration adds:
--   1. Add person_grants.store_id (+ FK, index).
--   2. UNIQUE (id, store_id) on position_capability_defaults — what the composite FK below needs.
--   3. Backfill: pin every existing 'position' row (active AND revoked) to its default's store.
--   4. Drop the single (person, grant_name) active-unique; replace with two partial ones — a
--      person-level slot (store_id IS NULL) and a per-store slot (store_id IS NOT NULL) — so a
--      position row and a person-level row can now coexist for the same capability.
--   5. Amendment R1 item 1 — BEFORE the old rank-based `grantCapability` rewrite existed only in
--      history: an ACTIVE row now tagged 'position' whose `granted_at` predates the default that
--      justifies it (`source_ref`) was NOT born from today's position machinery — it was a
--      NULL-source or 'elevation' row an old reconcile pass rewrote in place (access.ts's old rank
--      comparison, rank 0 -> rank 1). Step 3 is about to pin that ROW to one store; access before
--      this migration was NOT store-limited, so pinning it alone would silently narrow it. A
--      person-level twin (store_id NULL) restores the pre-upgrade shape — 'elevation' when the
--      capability is one only the auto-elevation fallback could have produced (admin:true,
--      manager:false — ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER, `packages/auth/src/capabilities.ts`,
--      literal today's list per the same "packages/db does not import @shareat/auth" rule
--      `person_grants.grant_name` itself already lives under, ADR-004) AND the person does not
--      presently hold an admin-role in this org; NULL-source otherwise, the same "unknown is not
--      inference" posture 0140 already took for a pre-0140 row. Orchestrator ruling: no owner
--      question, since it only RESTORES today's access, never widens it (bible row 211).
--      ⛔ ACTIVE only (`g.revoked_at IS NULL`) — a row that was later legitimately revoked gets no
--      twin; twinning it would hand back access that is genuinely gone today. The twin's own
--      `granted_at` COPIES the row it twins (`g.granted_at`) — the twin's provenance is that
--      original grant, not this migration's own act.
--      Runs after step 4 (never before): under the OLD single active-unique index, the row it
--      twins from is the ONLY active row for that (person, grant_name), so a second active row
--      for the same pair could not have coexisted until the new partial indexes exist.
--   6. Materialise rows the OLD index suppressed (§4.1 item 5) — only access justified TODAY.
--      "Wanted": an open employment HOLDING THE POSITION (employment_positions, is_active — 0152's
--      own pattern) whose ACTIVE default at that store names the capability — never looser than
--      that, or this repair recreates DEF-414 itself (an unrelated position's default at the same
--      store would otherwise count for anyone merely employed there). "Evidence" this person's
--      claim is real: an ACTIVE 'position' row for that capability at a DIFFERENT store — ACTIVE
--      ONLY (Amendment R3, superseding R1 item 2 / R2 item 2: a revoked-row branch narrow enough
--      to exclude a deliberate admin revocation turned out to also exclude every real §2.2
--      victim — the two are the same shape from the row alone). An already-revoked §2.2 victim is
--      NOT repaired by this migration; it is counted in §8's cutover count instead (orchestrator,
--      read-only). No active (person, capability, store) row yet. Insert one: ref = the lowest-id
--      matching default, granted_by copied from the qualifying evidence row.
--   7. CHECK the shape: a 'position' row always carries a store; nothing else ever does.
--   8. Composite FK (source_ref, store_id) -> position_capability_defaults(id, store_id). MATCH
--      SIMPLE (Postgres default, unwritten): a 'grant' row that KEEPS a history ref but carries no
--      store (§C3/§C5 transition 1) has a NULL store_id, so this composite FK does not apply to it
--      — the pre-existing single-column FK on source_ref alone still validates the ref exists.
--   9. Fill trigger, never correcting: a raw 'position' insert/update with no store_id gets one
--      from its default — the shape every fixture importer and raw test writer already uses
--      (`_fixtures/staff-everyday-access.ts`, `t336-auto-staff-role-on-hire.test.ts`). Amendment R1
--      item 4: RLS on position_capability_defaults is FORCED and org-scoped (0146), so a default
--      the caller's role cannot see reads back as no rows, not an error — the trigger raises its
--      OWN named error in that case rather than leaving store_id NULL for the CHECK to catch blind.
--
-- HAND-WRITTEN, per ADR-012 §5 (packages/db/migrations/README.md) — drizzle-kit generate is
-- retired. Never edited after apply (RULES §1 rule 9).

-- ---------------------------------------------------------------------------------------------
-- Step 1 — person_grants gains store_id.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "person_grants" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX "person_grants_store_id_idx" ON "person_grants" ("store_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 2 — what the composite FK (step 8) references.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "position_capability_defaults" ADD CONSTRAINT "position_capability_defaults_id_store_unique"
	UNIQUE ("id", "store_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 3 — backfill: every 'position' row, active or revoked, is pinned to the store its own
-- source_ref default belongs to. Never touches a 'grant'/'owner'/'elevation'/NULL-source row —
-- those stay store_id NULL (person-level), including a 'grant' row that carries a HISTORY ref.
-- ---------------------------------------------------------------------------------------------
UPDATE "person_grants" "g"
SET "store_id" = "d"."store_id"
FROM "position_capability_defaults" "d"
WHERE "g"."grant_source" = 'position' AND "d"."id" = "g"."source_ref";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 4 — one (person, grant_name) active slot becomes two: person-level (store_id NULL) and
-- per-store (store_id NOT NULL). A position row and a person-level row now COEXIST — neither ever
-- rewrites the other (packages/db/src/repo/access.ts's grantCapability, T-341 §4.2).
-- ---------------------------------------------------------------------------------------------
DROP INDEX "person_grants_active_person_grant_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "person_grants_active_person_level_unique" ON "person_grants"
	("person_id","grant_name") WHERE "revoked_at" IS NULL AND "store_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "person_grants_active_position_store_unique" ON "person_grants"
	("person_id","grant_name","store_id") WHERE "revoked_at" IS NULL AND "store_id" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 5 — Amendment R1 item 1: person-level twins for rows upgraded before this migration
-- existed. See the header's step-5 paragraph for the full argument. ELEVATED_GRANTS_FOR_ADMINLESS_
-- MANAGER's members as of this migration (packages/auth/src/capabilities.ts — admin:true,
-- manager:false; approve_item/post_journal_entry/cross_org_access/view_franchise_sales are
-- admin:false and never appear here) are named literally, the same "plain data, not a dependency"
-- posture 0152 already took for its 21-name backfill list.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source", "source_ref", "store_id", "granted_at")
SELECT
	"g"."person_id",
	"g"."grant_name",
	"g"."granted_by",
	CASE
		WHEN "g"."grant_name" = ANY (ARRAY[
			'view_trial_balance','override_period_lock','manage_users','manage_stores',
			'grant_capability','set_pay_rate','run_payroll','provision_clock_terminal',
			'set_cash_policy','manage_price_lists','manage_fixed_assets','run_depreciation',
			'manage_prepaid_items','run_amortisation','manage_chart_of_accounts'
		])
		AND ("pr"."role" IS NULL OR "pr"."role" NOT IN ('admin', 'super_admin'))
		THEN 'elevation'
		ELSE NULL
	END,
	NULL,
	NULL,
	"g"."granted_at"
FROM "person_grants" "g"
JOIN "position_capability_defaults" "d" ON "d"."id" = "g"."source_ref"
JOIN "persons" "per" ON "per"."id" = "g"."person_id"
LEFT JOIN "person_roles" "pr" ON "pr"."person_id" = "g"."person_id" AND "pr"."org_id" = "per"."org_id" AND "pr"."revoked_at" IS NULL
-- ⛔ Auditor finding (2026-09-25), HIGH: `g.revoked_at IS NULL` is load-bearing. Without it, a
-- 'position' row that predates its default AND was later legitimately revoked (job ended, admin
-- revoked it) gets twinned anyway — restoring access that is genuinely gone today, not access
-- this migration owes anyone (bible row 211 cuts both ways).
WHERE "g"."grant_source" = 'position' AND "g"."granted_at" < "d"."set_at" AND "g"."revoked_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 6 — materialise rows the OLD index suppressed (§4.1 item 5). See the header's step-6
-- paragraph for the full argument — "candidate_defaults" requires the OPEN EMPLOYMENT to hold the
-- SAME position the default belongs to (`employment_positions`, `d.position_id = ep.position_id`,
-- `p.is_active` — 0152's own join, :211), never a looser "any default at this store": that
-- looseness IS DEF-414's leak, reintroduced by this repair itself if skipped. Amendment R3
-- (supersedes R1 item 2 / R2 item 2): "other_store_evidence" admits ONLY an ACTIVE 'position' row
-- at another store — no revoked-row branch. R2's §2.2-shape attempt (an open employment still
-- holding the row's position, with its own default still active) was re-audited and found to
-- admit only a DELIBERATE admin revocation while missing every real §2.2 victim (the wrongful
-- reconcile revocation this task exists to repair) — the two are indistinguishable from the row's
-- own shape alone. The remaining unrepairable §2.2 shape goes into the §8 cutover count
-- (orchestrator, read-only), not this migration. `chosen` picks the lowest-id matching default
-- for `source_ref`, same tie-break 0152 used for the identical ambiguity.
-- ---------------------------------------------------------------------------------------------
WITH "candidate_defaults" AS (
	SELECT DISTINCT "e"."person_id", "e"."store_id", "d"."capability", "d"."id" AS "default_id"
	FROM "employments" "e"
	JOIN "employment_positions" "ep" ON "ep"."employment_id" = "e"."id"
	JOIN "positions" "p" ON "p"."id" = "ep"."position_id" AND "p"."is_active" = true
	JOIN "position_capability_defaults" "d"
		ON "d"."position_id" = "ep"."position_id" AND "d"."store_id" = "e"."store_id" AND "d"."revoked_at" IS NULL
	WHERE "e"."ended_on" IS NULL
),
"other_store_evidence" AS (
	SELECT DISTINCT ON ("cd"."person_id", "cd"."store_id", "cd"."capability")
		"cd"."person_id", "cd"."store_id", "cd"."capability", "g"."granted_by" AS "existing_granted_by"
	FROM "candidate_defaults" "cd"
	JOIN "person_grants" "g"
		ON "g"."person_id" = "cd"."person_id"
		AND "g"."grant_name" = "cd"."capability"
		AND "g"."grant_source" = 'position'
		AND "g"."store_id" IS DISTINCT FROM "cd"."store_id"
		AND "g"."revoked_at" IS NULL
	WHERE NOT EXISTS (
		SELECT 1 FROM "person_grants" "pg2"
		WHERE "pg2"."person_id" = "cd"."person_id" AND "pg2"."grant_name" = "cd"."capability"
			AND "pg2"."store_id" = "cd"."store_id" AND "pg2"."revoked_at" IS NULL
	)
	ORDER BY "cd"."person_id", "cd"."store_id", "cd"."capability", "g"."granted_at" DESC
),
"chosen" AS (
	SELECT DISTINCT ON ("ose"."person_id", "ose"."store_id", "ose"."capability")
		"ose"."person_id", "ose"."store_id", "ose"."capability", "ose"."existing_granted_by", "cd"."default_id"
	FROM "other_store_evidence" "ose"
	JOIN "candidate_defaults" "cd"
		ON "cd"."person_id" = "ose"."person_id" AND "cd"."store_id" = "ose"."store_id" AND "cd"."capability" = "ose"."capability"
	ORDER BY "ose"."person_id", "ose"."store_id", "ose"."capability", "cd"."default_id"
)
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source", "source_ref", "store_id")
SELECT "person_id", "capability", "existing_granted_by", 'position', "default_id", "store_id"
FROM "chosen"
ON CONFLICT ("person_id", "grant_name", "store_id") WHERE "revoked_at" IS NULL AND "store_id" IS NOT NULL DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 7 — the shape, from here on. Every row above already conforms (step 3 pinned every
-- 'position' row; steps 5/6 inserted only already-conforming rows), so this validates clean.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_store_shape_check" CHECK (
	("grant_source" = 'position' AND "store_id" IS NOT NULL)
	OR ("grant_source" IS DISTINCT FROM 'position' AND "store_id" IS NULL)
);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 8 — a position row's store must be the store its own default belongs to. MATCH SIMPLE
-- (unwritten, Postgres default): a 'grant' row with a history ref and a NULL store_id skips this
-- FK entirely (one referencing column is NULL) — the single-column FK on source_ref alone
-- (migration 0146) still requires that history ref to exist.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_source_ref_store_fk"
	FOREIGN KEY ("source_ref", "store_id") REFERENCES "position_capability_defaults" ("id", "store_id")
	ON DELETE RESTRICT;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 9 — fill trigger. Never overwrites a supplied store_id (a mismatch is the composite FK's
-- job, step 8; a non-position row with a store is the shape CHECK's job, step 7) — only fills a
-- 'position' row's NULL store_id from its own default. Amendment R1 item 4: raises its own named
-- error when the default is not visible under RLS (wrong or absent org context), rather than
-- leaving store_id NULL for the CHECK to reject with a generic message.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "person_grants_fill_store_id"() RETURNS trigger AS $$
DECLARE
	"v_store_id" uuid;
BEGIN
	IF NEW."grant_source" = 'position' AND NEW."store_id" IS NULL AND NEW."source_ref" IS NOT NULL THEN
		SELECT "store_id" INTO "v_store_id" FROM "position_capability_defaults" WHERE "id" = NEW."source_ref";
		IF "v_store_id" IS NULL THEN
			RAISE EXCEPTION 'person_grants: no visible default for source_ref %', NEW."source_ref";
		END IF;
		NEW."store_id" := "v_store_id";
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "person_grants_fill_store_id_trg"
	BEFORE INSERT OR UPDATE OF "grant_source", "source_ref" ON "person_grants"
	FOR EACH ROW EXECUTE FUNCTION "person_grants_fill_store_id"();--> statement-breakpoint
