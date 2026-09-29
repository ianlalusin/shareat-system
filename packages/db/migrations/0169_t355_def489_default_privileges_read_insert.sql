-- 0169 — T-355 / DEF-489, bible §13 row 242. Ian, 2026-09-29: "DEF-489 go with (a), fix before launch".
-- docs/tasks/355-def-489-default-privileges-read-insert.md.
--
-- Narrows the standing default from 0011 (`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO "shareat_app"`, :72) to SELECT + INSERT only. Every table
-- created since has been born with app-role UPDATE and DELETE it never asked for — that is how
-- audit_log got the grant 0168 had to REVOKE by hand (0168:75). From now on a table is born read +
-- insert; a table the app UPDATEs, DELETEs, or upserts (`onConflictDoUpdate`) into needs an explicit
-- `GRANT UPDATE[, DELETE] ON "<t>" TO "shareat_app"` in its OWN migration (ADR-012 §5 step 4a,
-- packages/db/migrations/README.md).
--
-- ⛔ Default privileges are per GRANTOR (`ALTER DEFAULT PRIVILEGES` with no `FOR ROLE` changes only
-- `current_user`'s own entry, and affects only objects `current_user` later creates). Every
-- migration in every environment runs as one role that owns every table — `postgres` locally and in
-- CI (`.github/workflows/ci.yml:124`), `doadmin` in production (`deploy.yml:150`,
-- `docs/ops/README.md:43`) — and nothing in this tree ever changes a table's owner (`OWNER TO`:
-- zero hits). So this migration names no role in the ALTER itself; naming one would hard-code a
-- single environment.
--
-- ⛔ **Existing tables are UNTOUCHED, including the six append-only-by-trigger candidates.** T-355's
-- own spec proposed revoking UPDATE/DELETE on those six too (R3) — DROPPED by the orchestrator's
-- independent audit (amendment S1): `stock_movements` UPDATE is needed by `onHandForUpdate`
-- (`repo/stock-ledger.ts:86-91`, `SELECT … FOR UPDATE`, called by `domain/stock/transfers.ts:74` as
-- the app role) — Postgres requires UPDATE privilege for `FOR UPDATE`/`FOR SHARE`, so every transfer
-- dispatch would have 42501'd. That narrower, corrected revoke is T-356, only if Ian says yes to it
-- (he has — bible row 243 — but it is a separate migration, not this one).
--
-- The sequences default (`0088_t181_mirror_outbox.sql:160`, `USAGE, SELECT ON SEQUENCES`) is a
-- SEPARATE row and is unchanged here — USAGE alone covers `nextval()`, so a new `serial` table still
-- inserts.
--
-- The DO block below is a POST-ASSERTION, not a guard ahead of the REVOKE: it runs AFTER the REVOKE
-- and rolls this whole migration back — failing the deploy loudly, before `deploy.yml`'s symlink
-- swap — on any of four distinct bad states, each with its own RAISE naming what to check:
--   (i) any stored default, from ANY grantor, in ANY namespace (the global one, `0`, included),
--       still leaves `shareat_app` with a table privilege other than SELECT or INSERT (re-widened);
--   (ii) the migrating role has no public/'r' row for `shareat_app` at all, and some OTHER grantor
--        does — this is simply not the role that ran 0011, so its own default was never touched;
--   (iii) the migrating role has no such row and NO grantor does — a row this role once had was
--         REVOKEd to empty (Postgres deletes the row, rather than leaving it empty); or
--   (iv) the migrating role HAS a row, but it is missing SELECT or INSERT (named), a partial state
--        (i)-(iii) cannot produce and must not be misreported as "wrong role" (no privilege name).
-- Reads `pg_default_acl` via `aclexplode` — a catalog, never an RLS table, so T-354 R6's
-- blind-pre-flight lesson does not apply here.
--
-- HAND-WRITTEN, per ADR-012 §5 — `drizzle-kit generate` is retired; it cannot emit
-- `ALTER DEFAULT PRIVILEGES` or a DO-block assertion. Every statement below is its own breakpoint,
-- except the final DO block, which is the last statement in the file.

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE UPDATE, DELETE ON TABLES FROM "shareat_app";
--> statement-breakpoint

DO $$
DECLARE
	excess_grantor regrole;
	excess_privilege text;
	other_grantor regrole;
	has_select boolean;
	has_insert boolean;
BEGIN
	-- Check (i) — no stored default, anywhere, still grants shareat_app more than SELECT/INSERT.
	SELECT a.grantor::regrole, a.privilege_type
	INTO excess_grantor, excess_privilege
	FROM pg_default_acl d, aclexplode(d.defaclacl) a
	WHERE d.defaclobjtype = 'r'
	  AND a.grantee = 'shareat_app'::regrole
	  AND a.privilege_type NOT IN ('SELECT', 'INSERT')
	LIMIT 1;

	IF excess_grantor IS NOT NULL THEN
		RAISE EXCEPTION
			'DEF-489: a stored default privilege still grants % to shareat_app on new tables (grantor %). Nothing in this migration was applied. Read pg_default_acl as the admin role and bring it to Ian — see docs/ops/README.md, "Default privileges (T-355)".',
			excess_privilege, excess_grantor
			USING ERRCODE = 'raise_exception';
	END IF;

	-- current_user's OWN public/'r' row for shareat_app, if any: which of SELECT/INSERT it holds.
	-- An empty aggregate (no row at all) gives NULL, coalesced to false — "has neither" then covers
	-- both "no row" and "a row that names other grantees but never shareat_app".
	SELECT bool_or(a.privilege_type = 'SELECT'), bool_or(a.privilege_type = 'INSERT')
	INTO has_select, has_insert
	FROM pg_default_acl d, aclexplode(d.defaclacl) a
	WHERE d.defaclobjtype = 'r'
	  AND d.defaclnamespace = 'public'::regnamespace
	  AND d.defaclrole = current_user::regrole
	  AND a.grantee = 'shareat_app'::regrole;
	has_select := COALESCE(has_select, false);
	has_insert := COALESCE(has_insert, false);

	IF NOT has_select AND NOT has_insert THEN
		-- current_user grants shareat_app NOTHING here. Two different facts read this way, and only
		-- a THIRD query — does some OTHER grantor hold the row? — tells them apart: another grantor
		-- holding it means 0011 simply ran under a different role (this role's default was never
		-- touched, by 0169 or anything else); nobody holding it means a row THIS role once had was
		-- REVOKEd to empty, which deletes the pg_default_acl row rather than leaving it empty.
		SELECT d.defaclrole::regrole
		INTO other_grantor
		FROM pg_default_acl d, aclexplode(d.defaclacl) a
		WHERE d.defaclobjtype = 'r'
		  AND a.grantee = 'shareat_app'::regrole
		  AND d.defaclrole <> current_user::regrole
		LIMIT 1;

		IF other_grantor IS NOT NULL THEN
			RAISE EXCEPTION
				'DEF-489: the migrating role (%) is not the role that ran 0011 (%) — its own default privilege was never narrowed. Nothing in this migration was applied. See docs/ops/README.md, "Default privileges (T-355)".',
				current_user, other_grantor
				USING ERRCODE = 'raise_exception';
		ELSE
			RAISE EXCEPTION
				'DEF-489: no default privilege row for shareat_app from % — re-grant SELECT, INSERT. Someone REVOKEd every default privilege for this role, which deletes the pg_default_acl row rather than leaving it empty. Nothing in this migration was applied. See docs/ops/README.md, "Default privileges (T-355)".',
				current_user
				USING ERRCODE = 'raise_exception';
		END IF;
	ELSIF NOT (has_select AND has_insert) THEN
		-- The row exists and is current_user's own, but PARTIAL — exactly one of the two is
		-- missing. Name it, rather than the generic "wrong role" message, which never does.
		RAISE EXCEPTION
			'DEF-489: the default privilege row for shareat_app from % is missing %. Nothing in this migration was applied. See docs/ops/README.md, "Default privileges (T-355)".',
			current_user, (CASE WHEN NOT has_select THEN 'SELECT' ELSE 'INSERT' END)
			USING ERRCODE = 'raise_exception';
	END IF;
END
$$;
