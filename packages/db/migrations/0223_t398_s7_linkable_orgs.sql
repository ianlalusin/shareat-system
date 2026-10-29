-- 0223 - T-398 S7d / DEF-747: the customer-link picker lists only companies the caller has a franchise agreement with.
-- docs/tasks/398-s7/S7-REFRESH.md s3, s9 (Q-S7-3 = a, Ian 2026-10-29).
--
-- Before this, the picker read `organizations` directly and listed every other company in the system. Under row-level security a franchisee
-- cannot read its franchisor's organisation row anyway, so the read has to go through a definer. The function below is that door, and it is
-- the only change: no table, no policy, no grant on a table.
--
--   linkable_counterparty_orgs() RETURNS TABLE (org_id, name, code)
--     the active organisations that share a franchise_agreements row with app_current_org(), in EITHER direction (the caller is the franchisee or the
--     franchisor), never the caller's own organisation, and nothing at all when app_current_org() is null. It returns no business figure and writes
--     nothing (no franchise_access_log row): a company name and code are what the person picking would see on the customer form anyway.
--
-- The application side (createCustomer) checks the same agreement before it writes, so this list is a convenience and the check is the rule.
--
-- SECURITY DEFINER, SET search_path = public, pg_temp, REVOKEd from PUBLIC, EXECUTE to shareat_app only (as in 0220).
--
-- LOCK BUDGET (ADR-012 s5). First statement SET LOCAL lock_timeout = '5s'; the last RESET lock_timeout. CREATE FUNCTION takes no lock on any live table.
-- No precheck: one function.
--
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE FUNCTION "linkable_counterparty_orgs"() RETURNS TABLE ("org_id" uuid, "name" text, "code" text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
	RETURN QUERY
	SELECT o."id", o."name", o."code"
	FROM "organizations" o
	WHERE app_current_org() IS NOT NULL
	  AND o."id" <> app_current_org()
	  AND o."is_active"
	  AND EXISTS (
		SELECT 1 FROM "franchise_agreements" f
		WHERE (f."org_id" = app_current_org() AND f."franchisor_org_id" = o."id")
		   OR (f."franchisor_org_id" = app_current_org() AND f."org_id" = o."id")
	  )
	ORDER BY o."name", o."id";
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "linkable_counterparty_orgs"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "linkable_counterparty_orgs"() TO "shareat_app";
--> statement-breakpoint
RESET lock_timeout;
