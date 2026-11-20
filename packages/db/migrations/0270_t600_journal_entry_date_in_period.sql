-- 0270 - T-600 S6 / DEF-902: a journal entry's date must fall inside its fiscal period.
-- docs/tasks/600-money-commissary-rate-and-parsers.md DEF-902. Hand-authored per ADR-012 s5. Reserved as 0262; renumbered
-- to 0270 (the next free number on shareat-coord/BOARD.md) because main already holds 0267 and 0268/0269 are reserved.
--
-- WHY. 0003 and 0143 check only the period's STATUS (open / closed / locked). Nothing ties journal_entries.entry_date to the
-- period named by period_id, so a writer that picked the wrong period would book a date into a month it does not belong to
-- and no check would notice. Today every writer resolves the period from the date, so this is a missing BACKSTOP (RULES s6
-- item 3), not wrong money. Same organisation is already covered (0213: composite FK on period_id).
--
-- THE TRIGGER. A new function journal_entries_check_entry_date_in_period() and a new trigger
-- journal_entries_entry_date_in_period, BEFORE INSERT OR UPDATE OF entry_date, period_id, FOR EACH ROW. A separate trigger on
-- purpose: the period-open function (0143) is not replaced a third time. Raises
-- 'journal entry date % is outside fiscal period % (% to %)'.
--
-- PRE-FLIGHT, fail closed. The DO block counts entries already dated outside their period and RAISEs before any trigger
-- exists; it changes nothing. The same query is docs/ops/P0270-precheck.sql, READ ONLY, for Ian to run as doadmin before the
-- deploy (expect 0).
--
-- LOCK BUDGET. First statement SET LOCAL lock_timeout = '5s' (resets at commit). CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- journal_entries (blocks writes, not reads) until the migration transaction commits; nothing is rewritten; the only scan is
-- the pre-flight's one read-only join. Do not deploy 05:30-07:00 Manila (the T-396 POS import writes sales days).
--
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
	n bigint;
BEGIN
	SELECT count(*) INTO n
	FROM public.journal_entries je
	JOIN public.fiscal_periods fp ON fp.id = je.period_id
	WHERE je.entry_date NOT BETWEEN fp.starts_on AND fp.ends_on;
	IF n > 0 THEN
		RAISE EXCEPTION '0270: % journal entries are dated outside their period; fix them before this migration', n;
	END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION "journal_entries_check_entry_date_in_period"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
	p_start date;
	p_end date;
BEGIN
	SELECT starts_on, ends_on INTO p_start, p_end FROM fiscal_periods WHERE id = NEW.period_id;
	-- A missing period is the period-open trigger's refusal (0143), not this one's.
	IF p_start IS NOT NULL AND NEW.entry_date NOT BETWEEN p_start AND p_end THEN
		RAISE EXCEPTION 'journal entry date % is outside fiscal period % (% to %)', NEW.entry_date, NEW.period_id, p_start, p_end;
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "journal_entries_entry_date_in_period"
	BEFORE INSERT OR UPDATE OF "entry_date", "period_id" ON "journal_entries"
	FOR EACH ROW EXECUTE FUNCTION "journal_entries_check_entry_date_in_period"();
