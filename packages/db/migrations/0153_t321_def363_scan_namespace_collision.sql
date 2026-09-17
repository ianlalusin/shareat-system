-- 0153 — T-321: a scanned value can never resolve to the wrong person. Closes DEF-363 and DEF-362
-- together — they ship in one migration/pass because adding Contract 1 alone would make DEF-362
-- worse before better (see docs/tasks/321-scan-namespace-collision.md, opening note).
--
-- ⛔⛔ CONTRACT 1 — the collision is made UNREPRESENTABLE, not merely checked at write time.
-- `attendance_credentials_shape_check` already guarantees exactly one of card_id / match_token is
-- non-null per row (a card row never has a token, a fingerprint row never has a card id), so the
-- two columns can be treated as ONE namespace for uniqueness: a stored generated column
-- `coalesce(card_id, match_token)` plus ONE partial unique index on
-- `(org_id, scan_value) where revoked_at is null` REPLACES both
-- `attendance_credentials_card_live_unique` and `attendance_credentials_token_live_unique` — any
-- violation of either old index is also a violation of this one. Net index count: -2 +1 = -1.
--
-- ⭐ RUN, NOT ONLY REASONED — orchestrator, 2026-09-17: built on a scratch table on a lane database
-- (PostgreSQL 18.6) with the real shape check and exactly one partial unique index; all five cases
-- behaved as this contract requires (cross-column collision rejected, different org accepted,
-- revoked-then-reissued accepted, two live cards sharing an id rejected, two live tokens sharing a
-- value rejected — the last two are the old indexes' own jobs, both absorbed by this one).
--
-- ⛔⛔ CONTRACT 2 — refuses rather than failing obscurely if live colliding rows already exist,
-- naming the offending organisations and staff codes. Creating the new unique index directly
-- against a table already holding a collision would surface a bare Postgres constraint-violation
-- error and tell an operator nothing (0152's own refusal pattern, which earned its keep on its
-- first real run). So detection runs AFTER step 1 (it needs the computed column) and BEFORE step 3
-- (after which the index would do the refusing, badly, for the wrong reason).
--
-- Order:
--   1. ADD COLUMN scan_value, generated, stored. Always succeeds — a computed value, not a check.
--   2. Refuse if any organisation already holds a live cross-row collision on scan_value, naming
--      who (organisation name + staff code). Not narrowed to cross-COLUMN collisions only: the two
--      indexes being dropped already make a same-column collision impossible today, so this can
--      only ever fire for the cross-column case in practice — but it stays a general check on the
--      actual invariant being added, honest if this migration is ever run somewhere those two
--      indexes were missing.
--   3. DROP the two old partial unique indexes; CREATE the one replacement.
--
-- ⚠️ Step 1 rewrites the table under an ACCESS EXCLUSIVE lock — nothing on this table today: dev
-- holds 2 live credentials, and T-314 measured 703 real terminal sessions over 35 days with card
-- and QR usage at exactly zero.
--
-- Hand-authored per ADR-012 §5 — `npm run db:generate` is retired and fails closed (DEF-242).
--
-- ⛔⛔ DELIBERATE DEPARTURE FROM §5 STEP 3, recorded here as a decision (orchestrator, 2026-09-17),
-- not as compliance with the usual rule. Drizzle's builder CAN express both the generated column
-- (`generatedAlwaysAs()`) and the replacement partial unique index below — this is NOT the "what
-- Drizzle cannot express is hand-added" case ADR-012 §5 step 3 normally covers. They are left OUT
-- of `packages/db/schema/attendance-credentials.ts` anyway, for a security reason rather than a
-- Drizzle limitation: declaring `scan_value` there would put it in the column list Drizzle builds
-- for `insertCredential`'s bare `.returning()` and `listLiveForEmployment`'s bare `.select()`,
-- handing every caller of either function the scanned value — the exact card id or match token
-- `packages/domain/src/attendance/credentials.ts`'s `summarise()` exists to keep from travelling
-- past enrolment. See the `// NOTE:` comment beside the index block in that schema file for the
-- full reasoning; it is the one place a future reader will look before "fixing" the builder to
-- match this SQL, and it must not be read as saying the opposite of this paragraph.
--
-- `organizations` is the SQL table name (American spelling) though the prose everywhere else on
-- this project says "organisation" — packages/db/schema/organizations.ts:11.

-- ---------------------------------------------------------------------------------------------
-- Step 1 — the generated column.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "attendance_credentials"
	ADD COLUMN "scan_value" text GENERATED ALWAYS AS (coalesce("card_id", "match_token")) STORED;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 2 — refuse if any live credential already shares a scan value with another live credential
-- in the same organisation.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
	bad_count int;
	bad_list text;
BEGIN
	SELECT count(*), string_agg(
		o."name" || ': ' || e."staff_code" || ' (credential ' || ac."id" || ')',
		'; ' ORDER BY o."name", e."staff_code"
	)
	INTO bad_count, bad_list
	FROM "attendance_credentials" ac
	JOIN "employments" e ON e."id" = ac."employment_id"
	JOIN "organizations" o ON o."id" = ac."org_id"
	WHERE ac."revoked_at" IS NULL
	  AND ac."scan_value" IS NOT NULL
	  AND EXISTS (
	    SELECT 1 FROM "attendance_credentials" other
	    WHERE other."org_id" = ac."org_id"
	      AND other."scan_value" = ac."scan_value"
	      AND other."revoked_at" IS NULL
	      AND other."id" <> ac."id"
	  );

	IF bad_count > 0 THEN
		RAISE EXCEPTION 'migration 0153 refuses to run: % live credential(s) share a scan value with another live credential in the same organisation, which Contract 1 (docs/tasks/321-scan-namespace-collision.md) makes unrepresentable going forward. Revoke one side of each colliding pair, then re-run. Offenders (organisation: staff code (credential id)): %', bad_count, bad_list;
	END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 3 — replace the two independent partial unique indexes with the one that spans both
-- columns. Net index count: -2 +1 = -1 (Contract 1).
-- ---------------------------------------------------------------------------------------------
DROP INDEX "attendance_credentials_card_live_unique";--> statement-breakpoint

DROP INDEX "attendance_credentials_token_live_unique";--> statement-breakpoint

CREATE UNIQUE INDEX "attendance_credentials_scan_value_live_unique"
	ON "attendance_credentials" ("org_id", "scan_value")
	WHERE "attendance_credentials"."revoked_at" IS NULL AND "attendance_credentials"."scan_value" IS NOT NULL;
