-- 0167 — T-350 S3 / DEF-169 / DEF-477, bible §13 row 238. Ian, 2026-09-28: "record payout account
-- changes in the audit log." docs/tasks/350-def-477-change-channel-payout-account.md §S3.
--
-- `audit_log` has existed since 0011 (docs/tasks/101-core-schema.md Contract §7) with no writer
-- and no org column — `rls/registry.ts` classified it `system_only` for exactly one stated reason:
-- "no org column today … until Phase 2 adds the column." This is that column. Once it carries
-- `org_id` it is an ordinary tenant table, not the captured-PII exception `etl_*` still is
-- (`client.ts`'s zero-policy sentence, amended alongside this migration to drop `audit_log` from
-- it) — S3's own decision record rejected a per-setting table (a `channel_payout_history` would be
-- a one-off, and the next audited setting would need another) and rejected `systemTransaction`
-- (its caller list is closed to tables that genuinely have no org, which this no longer is).
--
-- Two policies, deliberately NOT `FOR ALL`: SELECT (an org reads its own rows) and INSERT (an org
-- appends its own rows). There is no UPDATE or DELETE policy, so under FORCE ROW LEVEL SECURITY
-- (already on since 0011) the app role can never touch a written row through Postgres's own
-- permission system — the append-only trigger below is the SECOND, independent lock, because a
-- future SUPERUSER-run migration or a role granted BYPASSRLS would otherwise still be able to
-- UPDATE/DELETE through the table's own permissions alone.
--
-- **DEF-183 pattern on the INSERT policy's WITH CHECK** (S3 orchestrator amendment M6, bible
-- §15.11 layering): `org_id = app_current_org()` alone asks "is this row LABELLED with my org?",
-- not "does its ACTOR belong to my org?" — the same gap 0129 closed on `person_roles`. A row
-- naming another org's person as `actor_person_id` would satisfy the FK (that person genuinely
-- exists) and the bare org_id check, and would be a believable but false audit trail: this org's
-- log naming someone who was never in it. `actor_person_id IS NULL OR EXISTS (...)` keeps the
-- column's own nullability (a system/cron action has no actor) without opening that gap for a
-- user-initiated one.
--
-- Guard first: `audit_log` has never had a writer (DEF-169; the 2026-08-24 purge review counted
-- zero rows), so backfilling an `org_id` onto an existing row is not a question this migration
-- expects to answer. If one somehow exists, stop rather than guess an org.
--
-- Append-only trigger modelled on `0082:141-153` (`attendance_punches_refuse_mutation`) — refuses
-- every UPDATE and DELETE unconditionally, for every role including the owner, so no future state
-- column can grow a bypass the way DEF-036 did. The cutover purge TRUNCATEs (`cutover/purge.ts`),
-- and row triggers do not fire on TRUNCATE, so `purge` (classification unchanged, reason rewritten
-- alongside this migration — M3) still works.
--
-- HAND-WRITTEN, per ADR-012 §5 (packages/db/migrations/README.md) — `drizzle-kit generate` is
-- retired. Every statement below is its own breakpoint, including the DO guard and the trigger
-- function (ADR-012 §5 item 2). Never edited after apply (RULES §1 rule 9).

-- ---------------------------------------------------------------------------------------------
-- Guard — audit_log has never had a writer (DEF-169). If it somehow has rows, stop rather than
-- assign them an org by guesswork.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "audit_log") THEN
		RAISE EXCEPTION 'audit_log has rows; 0167 cannot assign them an org';
	END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "audit_log" ADD COLUMN "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "audit_log_org_occurred_at_idx" ON "audit_log" ("org_id", "occurred_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Policies. Deliberately two, not `FOR ALL` — there is no UPDATE/DELETE policy, so under FORCE
-- ROW LEVEL SECURITY the app role cannot touch a written row through Postgres permissions at all.
-- `app_current_org()` only, never raw `current_setting(...)` (DEF-077). ENABLE/FORCE are already
-- on (0011) — this migration adds no RLS statement for either.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY "audit_log_org_read" ON "audit_log" FOR SELECT
	USING ("org_id" = app_current_org());--> statement-breakpoint

-- M6 (DEF-183 pattern) — the actor, if one is named, must belong to the org the row is labelled
-- with. `actor_person_id IS NULL` stays legal: a system/cron action has no actor by design.
CREATE POLICY "audit_log_org_append" ON "audit_log" FOR INSERT
	WITH CHECK (
		"org_id" = app_current_org()
		AND (
			"actor_person_id" IS NULL
			OR EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "audit_log"."actor_person_id" AND p."org_id" = app_current_org())
		)
	);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Append-only. Modelled on attendance_punches_refuse_mutation (migration 0082). Unconditional —
-- no state argument for a future column to slip past, same lesson DEF-036 recorded.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_refuse_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only (bible §4.2 rule 9): % on row % is refused.',
		TG_OP, COALESCE(OLD.id::text, '?')
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
	BEFORE UPDATE OR DELETE ON "audit_log"
	FOR EACH ROW EXECUTE FUNCTION audit_log_refuse_mutation();
