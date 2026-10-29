-- 0221 -- T-498 S1 / DEF-799 (docs/tasks/498-pay-rates-append-only-csv-formula.md, S1): a pay rate is
-- never rewritten or removed.
--
-- THE DEFECT. T-189 section 5.1 forbids UPDATE and DELETE on `pay_rates`: a wrong rate is superseded
-- by a NEW row, so a saved payslip's basis stays explainable (`packages/db/schema/payroll.ts` calls the
-- table append-only). But 0105 created it with no history trigger, 0011:68 granted the app role
-- SELECT/INSERT/UPDATE/DELETE on every table, 0169 narrowed FUTURE tables only, and 0170's six revokes
-- omit it. An `UPDATE pay_rates SET amount = 1.00` committed as `shareat_app` with an org principal, and
-- a re-run of a voided pay run then priced at the rewritten rate.
--
-- THE THREE LOCKS (the 0168 / 0170 pattern; no layer is the only lock, bible section 15.11):
--   1. TRIGGER `pay_rates_append_only`, BEFORE UPDATE OR DELETE ... FOR EACH ROW, refuses with SQLSTATE
--      23001 (restrict_violation), as `audit_log` does. Unconditional: it decides from TG_OP only, so a
--      future column cannot slip past it (DEF-036).
--   2. ENABLE ALWAYS on that trigger (0168), so it still fires under `session_replication_role =
--      'replica'`, the usual hand-rolled bulk-load bypass.
--   3. REVOKE UPDATE, DELETE ON "pay_rates" FROM "shareat_app": a loud 42501 at the statement, before RLS.
--
-- WHY EACH IS SAFE.
--   * The app never rewrites a rate: `packages/db/src/repo/payroll.ts` only INSERTs (`insertPayRate`) and
--     SELECTs (`rateInForceOn`, `listPayRates`).
--   * UPDATE is revoked too, which would break any `SELECT ... FOR UPDATE / FOR SHARE` on the table
--     (0170's `stock_movements` case). Re-checked for this migration: no `FOR UPDATE` / `FOR SHARE` /
--     `.for(...)` row lock on `pay_rates` exists anywhere in `packages` or `apps` (the payroll repo and
--     domain payroll code take none), so UPDATE is revoked as well as DELETE.
--   * Foreign keys: `pay_rates.employment_id` and `payslips.pay_rate_id` are ON DELETE RESTRICT, so no
--     cascade deletes a rate; RI checks run as the table owner anyway (0170 header).
--   * The cutover purge classes `pay_rates` as `keep` (`cutover/classification.ts`), so nothing
--     TRUNCATEs or deletes it; a TRUNCATE is not a row event and was never granted to the app role.
--   * Existing rows are not re-checked and none is rewritten: a trigger on UPDATE/DELETE only sees
--     FUTURE statements, so there is nothing a precheck could find that would block this migration.
--
-- HAND-WRITTEN, per ADR-012 section 5 (`drizzle-kit generate` is retired and cannot emit REVOKE or
-- ENABLE ALWAYS). Every statement is its own breakpoint, except the last.

CREATE OR REPLACE FUNCTION "pay_rates_refuse_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A pay rate is never changed or removed (% on rate % is refused). Enter a new rate with a later effective date instead.',
		TG_OP, COALESCE(OLD.id::text, '?')
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pay_rates_refuse_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pay_rates_append_only"
	BEFORE UPDATE OR DELETE ON "pay_rates"
	FOR EACH ROW EXECUTE FUNCTION "pay_rates_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "pay_rates" ENABLE ALWAYS TRIGGER "pay_rates_append_only";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "pay_rates" FROM "shareat_app";
