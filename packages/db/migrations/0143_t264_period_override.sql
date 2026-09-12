-- 0143 — T-264 slice 3 (DEF-284): the fiscal-period override.
-- docs/tasks/264-def-284-fiscal-period-lock.md (the SLICE 3 BUILD NOTE at the end governs over
-- the slice 3 section above it), docs/plans/264-slice3-plan.md (this lane's APPROVED spec),
-- bible §13 rows 193, 194, 195, 196.
--
-- An admin or super_admin may post ONE authorised entry into a CLOSED fiscal period, through a
-- transaction-local exemption -- migration 0005's app.reversal_posting idiom, reused exactly, per
-- the build note's "do not invent a second mechanism":
--
--   is_override_context := coalesce(current_setting('app.period_override', true), '') = 'on';
--
-- so an unset flag reads as NOT exempt, and any bug, crash, or forgotten line fails CLOSED. The
-- flag is set only by journalRepo.beginPeriodOverrideContext (packages/db/src/repo/journal.ts),
-- called only after authorize(actor, 'override_period_lock') has confirmed the capability
-- (packages/domain/src/ledger/post-entry.ts) -- never from a caller-supplied parameter.
--
-- ⛔ LOCKED periods are explicitly OUT of the override -- system32-85's ruling, 2026-09-12
-- (docs/plans/264-slice3-plan.md): `locked` means a later fiscal year's close has already
-- CONSUMED this period's balances (ADR-006 §7.5). Letting an entry land there would change
-- numbers a subsequent year-close entry was computed from and already posted -- a different and
-- worse thing than a closed-period correction, and nobody has been asked about widening the
-- override that far. `locked` is branched FIRST in both trigger functions below and given its OWN
-- error text, distinct from the ordinary "not open" refusal, so an admin holding
-- override_period_lock can tell -- from the message alone -- that their capability was consulted
-- and correctly refused to apply, rather than reading a generic "(status = locked)" and filing a
-- bug report against a correctly-working system.
--
-- 0003 (journal_entries_check_period_open, journal_lines_check_period_open) is applied and never
-- edited (bible §2 rule 8) -- this replaces both trigger functions forward, the same pattern 0005
-- used to replace 0003's journal_lines_check_account_eligible forward.
--
-- Hand-authored per ADR-012 §5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE OR REPLACE FUNCTION "journal_entries_check_period_open"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	period_status text;
	is_override_context boolean;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.period_id IS NOT DISTINCT FROM OLD.period_id
		   AND NOT (OLD.status = 'draft' AND NEW.status = 'posted') THEN
			RETURN NEW;
		END IF;
	END IF;

	SELECT status INTO period_status FROM fiscal_periods WHERE id = NEW.period_id;

	IF period_status IS NULL THEN
		RAISE EXCEPTION 'fiscal period % does not exist', NEW.period_id;
	END IF;

	-- Transaction-local only (set by beginPeriodOverrideContext AFTER authorize() has confirmed
	-- 'override_period_lock'). coalesce so an unset GUC -- every ordinary postEntry caller,
	-- always -- reads as NOT exempt rather than erroring. Migration 0005's exact idiom.
	is_override_context := coalesce(current_setting('app.period_override', true), '') = 'on';

	IF period_status = 'locked' THEN
		RAISE EXCEPTION 'cannot post journal entry into period % -- period is locked (a later fiscal year''s close already depends on its balances) and the period-override capability does not apply to locked periods', NEW.period_id;
	ELSIF period_status <> 'open' THEN
		-- only 'closed' (or any future non-open, non-locked status) reaches here.
		IF period_status = 'closed' AND is_override_context THEN
			-- authorised, transaction-local exemption -- fall through, allowed.
			NULL;
		ELSE
			RAISE EXCEPTION 'cannot post journal entry into period % (status = %)', NEW.period_id, period_status;
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "journal_lines_check_period_open"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	period_status text;
	is_override_context boolean;
BEGIN
	SELECT p.status INTO period_status
	FROM journal_entries e JOIN fiscal_periods p ON p.id = e.period_id
	WHERE e.id = NEW.entry_id;

	IF period_status IS NULL THEN
		RAISE EXCEPTION 'journal entry % does not exist or has no period', NEW.entry_id;
	END IF;

	is_override_context := coalesce(current_setting('app.period_override', true), '') = 'on';

	IF period_status = 'locked' THEN
		RAISE EXCEPTION 'cannot post journal line into period with status locked -- period is locked (a later fiscal year''s close already depends on its balances) and the period-override capability does not apply to locked periods';
	ELSIF period_status <> 'open' THEN
		IF period_status = 'closed' AND is_override_context THEN
			NULL;
		ELSE
			RAISE EXCEPTION 'cannot post journal line into period with status %', period_status;
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ===========================================================================================
-- period_overrides -- the audit row for every override invocation.
-- packages/db/schema/period-overrides.ts's header carries the full "what a row means" contract:
-- a row means "the override_period_lock capability was invoked for this entry", NOT "the period
-- lock was bypassed" -- those differ exactly when period_status_at_post = 'open' (authorize() and
-- this row both run unconditionally whenever postEntry's caller passes periodOverride, because
-- the period's status can be changed by a concurrent transaction between postEntry's read and
-- this row's write -- over-recording is the safe direction for an audit trail).
-- ===========================================================================================
CREATE TABLE "period_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"actor_person_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"period_status_at_post" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_overrides_reason_check"
		CHECK ("reason" IN ('late_supplier_invoice', 'regulatory_correction', 'data_entry_error', 'other')),
	-- 'other' needs its own sentence, not a checkbox -- same shape as
	-- ar_write_offs_reason_not_blank_check (0049_t131_accounts_receivable.sql:123).
	CONSTRAINT "period_overrides_other_needs_note_check"
		CHECK ("reason" <> 'other' OR ("note" IS NOT NULL AND btrim("note") <> '')),
	CONSTRAINT "period_overrides_status_at_post_check"
		CHECK ("period_status_at_post" IN ('open', 'closed'))
);--> statement-breakpoint

-- ⛔ entry_id is NOT NULL with ON DELETE CASCADE, mirroring journal_lines.entry_id
-- (0003_journal_entries_and_lines.sql:82) -- this is the property that makes "an override with no
-- entry" structurally unrepresentable, which was the whole reason audit_log (a single
-- jsonb-backed entity_id) did not fit this table's shape.
ALTER TABLE "period_overrides" ADD CONSTRAINT "period_overrides_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "period_overrides" ADD CONSTRAINT "period_overrides_period_id_fiscal_periods_id_fk"
	FOREIGN KEY ("period_id") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "period_overrides" ADD CONSTRAINT "period_overrides_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
-- NOT NULL, unlike audit_log's actor column -- there is no system-actor case here; a machine can
-- never hold override_period_lock.
ALTER TABLE "period_overrides" ADD CONSTRAINT "period_overrides_actor_person_id_persons_id_fk"
	FOREIGN KEY ("actor_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "period_overrides_entry_idx" ON "period_overrides" ("entry_id");--> statement-breakpoint
CREATE INDEX "period_overrides_period_idx" ON "period_overrides" ("period_id");--> statement-breakpoint

-- RLS -- ENABLE and FORCE as the table is created (bible row 112), app_current_org() never a raw
-- current_setting(...)::uuid (DEF-077), and WITH CHECK as well as USING (DEF-183).
ALTER TABLE "period_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "period_overrides" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "period_overrides_org_isolation" ON "period_overrides"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
