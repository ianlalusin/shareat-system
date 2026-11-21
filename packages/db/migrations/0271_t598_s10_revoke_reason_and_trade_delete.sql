-- 0271 - T-598 S10: DEF-415 (a clock terminal revoked with a blank reason) and DEF-548 (shareat_app can DELETE a trade order).
-- docs/tasks/598-open-defect-sweep.md S10; hand-authored per ADR-012 s5. Journal idx 271 (0270 is T-600's, reserved by BOSS 20 Nov; gaps are legal).
--
-- DEF-415. `clock_terminals_revoked_triple_check` (0087) binds revoked_at, revoked_by and revoke_reason to be all NULL or all NOT NULL, but a '' or '   ' reason
-- passes it - a revoked terminal nobody can explain. Sibling 0138 (person_credentials) and 0158 (attendance_credentials) closed the same gap with btrim(...) <> ''.
-- Unlike 0158 this migration does NOT rewrite a blank reason (BOSS ruling: never invent an audit sentence for a terminal): a pre-check counts the violating rows and
-- refuses the migration NAMING them, and a person fixes the reason first. docs/ops/P0271-precheck.sql is the same count, read-only, to run before the deploy.
--   * The explicit `IS NOT NULL` before btrim is load-bearing (0158's header): `btrim(NULL) <> ''` is NULL and a CHECK passes on NULL.
--   * The count runs with SET LOCAL row_security = off (precedent 0162): production migrates as doadmin, which RLS cannot filter, so this is a no-op there; any OTHER role
--     fails LOUDLY (Postgres refuses a query that RLS would filter) instead of counting zero rows and passing. Reset to `on` right after, in the same transaction.
--
-- DEF-548. 0011:68 granted shareat_app SELECT/INSERT/UPDATE/DELETE on every table. Nothing in the app deletes a trade order (a cancelled order keeps its row; lines, messages
-- and payments hang off it). The REVOKE gives a loud 42501 at the statement, before RLS, exactly as 0170 did for six other tables. FK cascades and the cutover TRUNCATE run as
-- the table owner, so neither is affected. UPDATE stays: the order lifecycle writes it.
--
-- LOCK BUDGET. First statement SET LOCAL lock_timeout = '5s' (resets at commit). clock_terminals holds a handful of rows (one per tablet); the DROP/ADD CONSTRAINT scan is
-- trivial. Every statement is its own breakpoint.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL row_security = off;
--> statement-breakpoint
DO $$
DECLARE
	blank integer;
	blank_rows text;
BEGIN
	SELECT count(*), string_agg(format('%s / "%s"', s.code, t.label), ', ' ORDER BY s.code, t.label) INTO blank, blank_rows
	  FROM clock_terminals t JOIN stores s ON s.org_id = t.org_id AND s.id = t.store_id
	 WHERE t.revoked_at IS NOT NULL AND btrim(t.revoke_reason) = '';
	IF blank > 0 THEN
		RAISE EXCEPTION '0271 refused: % revoked clock terminal(s) have a blank revoke reason (%). Give each one a real reason first (enter it on the terminal record, or ask the database owner to set revoke_reason), then deploy again. Nothing was changed.',
			blank, blank_rows
			USING ERRCODE = 'check_violation';
	END IF;
END
$$;
--> statement-breakpoint
SET LOCAL row_security = on;
--> statement-breakpoint
ALTER TABLE "clock_terminals" DROP CONSTRAINT "clock_terminals_revoked_triple_check";
--> statement-breakpoint
ALTER TABLE "clock_terminals" ADD CONSTRAINT "clock_terminals_revoked_triple_check" CHECK (
	("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL)
	OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL AND btrim("revoke_reason") <> '')
);
--> statement-breakpoint
REVOKE DELETE ON "trade_orders" FROM "shareat_app";
