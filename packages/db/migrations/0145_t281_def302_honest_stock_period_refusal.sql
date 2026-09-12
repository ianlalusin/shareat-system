-- 0145 — T-281 (DEF-302): make stock_movements_check_period_open's refusal honest about the
-- period override.
-- docs/tasks/281-def-302-honest-stock-period-refusal.md (this lane's APPROVED spec),
-- docs/DEFECTS-REGISTER.md DEF-302, bible §13 row 193.
--
-- ⛔ BEHAVIOUR DOES NOT CHANGE. A stock movement into a period that is 'closed' or 'locked' is
-- refused today, for every role including admin and super_admin, and stays refused after this
-- migration -- disposition (c) (extending the override to stock movements) was explicitly NOT
-- chosen (bible row 193's own text: back-dating a movement recomputes inventory layers and
-- therefore COGS, a decision nobody has made). The ONLY thing that changes is the SENTENCE
-- carried when the caller holds the period-override GUC migration 0143 introduced -- it now
-- says, in terms, that the override does not extend to stock movements, instead of a generic
-- "cannot move stock" message that gives an admin holding the capability no way to tell whether
-- their override was consulted and correctly refused, or never reached at all.
--
-- Same read-only idiom migration 0143 uses (itself migration 0005's, reused rather than
-- invented a second time):
--   is_override_context := coalesce(current_setting('app.period_override', true), '') = 'on';
-- so an unset flag reads as NOT exempt and the refusal is unconditional either way -- this
-- function only ever READS the flag to choose a sentence; it never branches on it to let the
-- INSERT through. Read AFTER the refusal condition is confirmed true, never before, so an
-- open-period insert never evaluates current_setting at all.
--
-- 'locked' and 'closed' get the SAME override wording, deliberately unlike the journal
-- triggers: those give 'locked' its own distinct message because the override bypasses 'closed'
-- but never 'locked' for journal entries -- a real difference worth naming. For stock movements
-- the override bypasses NEITHER status, ever, so there is nothing for a second message to
-- distinguish.
--
-- 0063 (stock_movements_check_period_open) is applied and never edited (bible §2 rule 8) --
-- this replaces the function forward, the same pattern 0143 used to replace 0003's two journal
-- functions forward.
--
-- Hand-authored per ADR-012 §5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE OR REPLACE FUNCTION "stock_movements_check_period_open"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	period_status text;
	is_override_context boolean;
BEGIN
	SELECT "status" INTO period_status
	FROM "fiscal_periods"
	WHERE "org_id" = NEW."org_id"
	  AND (NEW."moved_at" AT TIME ZONE 'UTC')::date BETWEEN "starts_on" AND "ends_on";

	IF period_status IS NOT NULL AND period_status <> 'open' THEN
		-- Read-only: chooses which SENTENCE to raise. Never lets the INSERT through -- that would
		-- be disposition (c), which Ian did not choose (DEF-302; bible row 193).
		is_override_context := coalesce(current_setting('app.period_override', true), '') = 'on';

		IF is_override_context THEN
			RAISE EXCEPTION 'cannot move stock into a % period (moved_at = %) -- the period-override capability does not extend to stock movements: back-dating one recomputes inventory layers and cost of goods sold, a decision the override was never authorised to make', period_status, NEW."moved_at";
		ELSE
			RAISE EXCEPTION 'cannot move stock into a % period (moved_at = %)', period_status, NEW."moved_at";
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
