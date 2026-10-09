-- 0188 - T-385, docs/tasks/385-verify-only-after-submit.md: a sales day is verified only after it is submitted.
--
-- PURPOSE: Ian 2026-10-09, "verify and post must be blocked until submitted". runVerify gains the same rule in plain
-- words (S1); this is the database's copy of the ORDER, so no writer under any role skips submit. DEF-618.
--
-- WHAT IT GUARDS: an UPDATE that moves a row INTO 'verified' from anything other than 'submitted' with a submitter.
-- Rows already verified are untouched (the WHEN), so days verified before 0188 without a submit (history, P0188b)
-- still void and still update. INSERT is not guarded (no app path inserts a non-open day; insertSalesDay takes no
-- status). Trigger registry: origin / validator (a replay must load historic rows). SECURITY INVOKER (the default).
--
-- S3 (Amendment B1, Ian t385-q1 = a): the person who submitted a day may not verify it, except a super-admin. That is
-- a domain rule through the new capability verify_own_sales_day (super-admin-only, org scope, area sales); the database
-- cannot answer it without a second copy of holdsSuperAdminAuthority, so no trigger arm. THE BACKFILL (between the
-- B0188 markers): holdsSuperAdminAuthority needs ALL super-admin-only grants, so each existing owner gets the new one:
-- every person with an ACTIVE admin role and live grants of all FIVE current ones (0187 made it five). person_grants is
-- FORCE ROW LEVEL SECURITY (0014:84), so the block runs with row_security off (the 0166 pattern): only a role RLS cannot
-- filter (doadmin in production) can apply it; any other role fails LOUDLY (SQLSTATE 42501) instead of granting nobody.
--
-- PRECHECKS (read-only, BEGIN READ ONLY; ... ROLLBACK;, run as doadmin with Ian before the push):
--   P0188a  SELECT status, count(*) FROM sales_days GROUP BY status ORDER BY status;      -- informational
--   P0188b  SELECT count(*) FROM sales_days WHERE status = 'verified' AND submitted_at IS NULL;
--           -- informational: historic days verified straight from open; they must NOT break (they do not: WHEN)
--   P0188c  SELECT count(*) FROM sales_days WHERE status = 'submitted' AND submitted_by IS NULL;
--           -- MUST be 0: such a day could never be verified after 0188 (markSubmitted always sets submitted_by)
--   P0188d  SELECT count(*) FROM sales_days WHERE status = 'open';
--           -- informational: days whose people must now press Submit before Verify (tell the store)
--   P0188e  SELECT count(*) FROM sales_days WHERE status = 'verified' AND verified_by = submitted_by;
--           -- informational: days already self-verified
--   P0188f  SELECT p.display_name, r.role, count(DISTINCT g.grant_name) AS grants
--             FROM person_grants g JOIN persons p ON p.id = g.person_id
--             LEFT JOIN person_roles r ON r.person_id = g.person_id AND r.revoked_at IS NULL
--            WHERE g.revoked_at IS NULL AND g.grant_name IN ('approve_item','post_journal_entry','cross_org_access','view_franchise_sales','unlink_store_from_pos')
--            GROUP BY 1, 2 ORDER BY 1;   -- the backfill grants exactly role = 'admin' AND grants = 5 (needs 0187 applied first): Ian confirms only him
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE OR REPLACE FUNCTION "sales_days_check_verify_requires_submitted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'submitted' OR OLD.submitted_by IS NULL THEN
		RAISE EXCEPTION 'A sales day is verified only after it is submitted (T-385): this one is %.', OLD.status
			USING ERRCODE = '23514', CONSTRAINT = 'sales_days_verify_requires_submitted';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sales_days_verify_requires_submitted"
	BEFORE UPDATE ON "sales_days"
	FOR EACH ROW
	WHEN (NEW.status = 'verified' AND OLD.status IS DISTINCT FROM 'verified')
	EXECUTE FUNCTION "sales_days_check_verify_requires_submitted"();
--> statement-breakpoint
-- B0188:begin
SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source")
SELECT g."person_id", 'verify_own_sales_day', NULL, 'owner'
  FROM "person_grants" g
 WHERE g."revoked_at" IS NULL
   AND g."grant_name" IN ('approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales', 'unlink_store_from_pos')
   AND EXISTS (SELECT 1 FROM "person_roles" r
                WHERE r."person_id" = g."person_id" AND r."role" = 'admin' AND r."revoked_at" IS NULL)
   AND NOT EXISTS (SELECT 1 FROM "person_grants" u
                    WHERE u."person_id" = g."person_id" AND u."grant_name" = 'verify_own_sales_day'
                      AND u."revoked_at" IS NULL AND u."store_id" IS NULL)
 GROUP BY g."person_id"
HAVING count(DISTINCT g."grant_name") = 5;
--> statement-breakpoint
SET LOCAL row_security = on;
-- B0188:end
