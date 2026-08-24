-- 0011 — T-120: org isolation enforced by PostgreSQL, not by application filters.
--
-- ADR-008 §9, bible row 112. `WHERE org_id = :org` on every query works until the one query
-- that forgets, and that query WILL exist. A franchise with a separate owner is already live
-- (Padre Garcia), so the failure mode is not a broken page — it is showing one business owner
-- another business owner's books.
--
-- THREE THINGS HERE ARE EASY TO GET WRONG, AND EACH IS SILENT WHEN WRONG:
--
--   1. A SUPERUSER BYPASSES RLS ENTIRELY — always, regardless of any policy or of FORCE. The
--      app must therefore connect as, or SET ROLE to, a non-superuser. That is why this
--      migration creates `shareat_app`. Running the app as `postgres` disables every policy
--      below while all the tests still pass.
--
--   2. A TABLE'S OWNER BYPASSES RLS BY DEFAULT. `ENABLE ROW LEVEL SECURITY` alone leaves the
--      owner exempt, so the very role that created the tables ignores every policy. `FORCE ROW
--      LEVEL SECURITY` closes it. This is the most commonly missed step in a Postgres RLS
--      setup and it silently disables the whole feature.
--
--   3. `current_setting(name, true)` returns NULL when the setting is absent, and every
--      comparison against NULL is NULL — so a query with NO principal set matches NO rows.
--      DEFAULT DENY falls out of the semantics rather than being bolted on. That is the
--      correct failure direction: a missing principal breaks a feature loudly instead of
--      leaking data quietly.
--
-- The GUCs are set with `set_config(..., true)` — TRANSACTION-scoped, cleared at commit or
-- rollback. Never `SET`, which is session-scoped and would leak the previous request's
-- identity into the next user of a pooled connection: silent, intermittent, and exactly the
-- breach this migration exists to prevent. Migration 0005 already uses this same mechanism
-- for the reversal exemption.
--
-- 0000-0010 are applied and are therefore never edited (bible §2 rule 8).

-- ---------------------------------------------------------------------------------------
-- The principal, read from transaction-scoped settings.
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION "app_current_org"() RETURNS uuid
LANGUAGE sql STABLE AS $$
	SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
$$;
--> statement-breakpoint

CREATE FUNCTION "app_principal_kind"() RETURNS text
LANGUAGE sql STABLE AS $$
	SELECT NULLIF(current_setting('app.principal_kind', true), '');
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- The application role. Deliberately NOLOGIN: sessions connect as the owner and then
-- `SET LOCAL ROLE shareat_app` inside the transaction, so the role switch is transaction
-- scoped exactly like the GUCs and cannot outlive a request on a pooled connection.
-- NOLOGIN also means this role has no password to leak or rotate.
-- ---------------------------------------------------------------------------------------

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shareat_app') THEN
		CREATE ROLE "shareat_app" NOLOGIN;
	END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "shareat_app";
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "shareat_app";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "shareat_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- org_column tables — the org is on the row.
-- USING governs what is visible; WITH CHECK governs what may be written, so a tenant can
-- neither read another org's row NOR insert one carrying another org's id.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "stores_org_isolation" ON "stores" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

ALTER TABLE "persons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "persons" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "persons_org_isolation" ON "persons" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "accounts_org_isolation" ON "accounts" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

ALTER TABLE "fiscal_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fiscal_periods" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fiscal_periods_org_isolation" ON "fiscal_periods" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journal_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "journal_entries_org_isolation" ON "journal_entries" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- self — the organizations table is scoped by its own id.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organizations_self_isolation" ON "organizations" FOR ALL
	USING ("id" = app_current_org()) WITH CHECK ("id" = app_current_org());
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- derived — no org_id of their own; reachable only through a parent that has one.
-- Scoping via the parent rather than denormalising an org_id keeps ONE source of truth for
-- which org a row belongs to. A copied column could drift, and a line whose org disagreed
-- with its entry would be invisible, or visible to the wrong tenant.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journal_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "journal_lines_via_entry" ON "journal_lines" FOR ALL
	USING (EXISTS (SELECT 1 FROM "journal_entries" e WHERE e."id" = "journal_lines"."entry_id" AND e."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "journal_entries" e WHERE e."id" = "journal_lines"."entry_id" AND e."org_id" = app_current_org()));
--> statement-breakpoint

ALTER TABLE "person_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "person_identities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "person_identities_via_person" ON "person_identities" FOR ALL
	USING (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_identities"."person_id" AND p."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_identities"."person_id" AND p."org_id" = app_current_org()));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- system_only — RLS enabled with NO policy at all.
--
-- Not an oversight: a table with RLS enabled and no policy is invisible to every non-owner
-- role. `audit_log` has no org column yet and therefore CANNOT be org-scoped — saying so and
-- failing closed is honest, where inventing a policy that looks like scoping would not be.
-- The ETL tables hold captured production PII and no tenant has any business reading them.
-- The migrator, crons and the audit connect as the owner and are unaffected.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "etl_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "etl_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "etl_source_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "etl_source_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "etl_quarantine" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "etl_quarantine" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "etl_reconciliation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "etl_reconciliation" FORCE ROW LEVEL SECURITY;
