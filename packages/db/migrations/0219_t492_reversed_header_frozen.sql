-- 0219 -- T-492 S2 / DEF-786 (docs/tasks/492-ledger-hardening.md, S2): a REVERSED journal_entries
-- header is frozen and undeletable.
--
-- Why: 0005's journal_entries_check_posted_immutable guarded only OLD.status = 'posted'. Once an
-- entry became 'reversed' nothing stopped a raw-SQL client rewriting its entry_date, memo,
-- period_id or status, or deleting the header (the lines trigger froze the lines of a reversed
-- entry, but the header itself was open). A reversed entry is as much history as a posted one.
--
-- What changes (CREATE OR REPLACE of the one function; the trigger journal_entries_posted_immutable
-- from 0003 already fires BEFORE UPDATE OR DELETE, so it needs no re-creation):
--   * DELETE is refused for status 'posted' OR 'reversed'.
--   * 'reversed' is fully frozen on UPDATE: status stays 'reversed' and every column except
--     updated_at is unchanged.
--   * 'posted' keeps today's rules exactly: posted -> posted | reversed only, the one-time
--     reversal_of_entry_id backfill (T-106), every other column frozen.
--
-- NOTE on 0161 (applied files are never edited): 0161's reasoning that "a REVERSED catch-up entry
-- being deleted (status='reversed' is not blocked by the 0005 trigger) cascades" into
-- missed_month_adjustments is superseded. This trigger now refuses that delete, so the
-- pg_trigger_depth() cascade escape in 0161's missed_month_adjustments delete guard is dead code
-- for journal headers. The FK to journal_lines already refused it; now the trigger does too.
CREATE OR REPLACE FUNCTION "journal_entries_check_posted_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.status = 'posted' THEN
			RAISE EXCEPTION 'posted journal entry % cannot be deleted', OLD.id;
		END IF;
		IF OLD.status = 'reversed' THEN
			RAISE EXCEPTION 'reversed journal entry % cannot be deleted', OLD.id;
		END IF;
		RETURN OLD;
	END IF;

	-- TG_OP = 'UPDATE'
	IF OLD.status = 'reversed' THEN
		IF NEW.status IS DISTINCT FROM 'reversed'
		   OR (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
			RAISE EXCEPTION 'reversed journal entry % is immutable (only updated_at may change)', OLD.id;
		END IF;
		RETURN NEW;
	END IF;

	IF OLD.status = 'posted' THEN
		IF NEW.status NOT IN ('posted', 'reversed') THEN
			RAISE EXCEPTION 'posted journal entry % may only remain posted or transition to reversed', OLD.id;
		END IF;

		-- T-106: a freshly-posted reversal entry may have its OWN reversal_of_entry_id
		-- backfilled, exactly once (NULL -> a value), and nothing else may change in
		-- that same UPDATE. Once set, this column is frozen again like every other --
		-- there is no path back to NULL and no path from one value to a different one.
		IF OLD.reversal_of_entry_id IS NULL AND NEW.reversal_of_entry_id IS NOT NULL THEN
			IF (to_jsonb(NEW) - 'updated_at' - 'status' - 'reversal_of_entry_id')
			   IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status' - 'reversal_of_entry_id') THEN
				RAISE EXCEPTION 'posted journal entry % is immutable except for the reversed status transition and a one-time reversal_of_entry_id backfill', OLD.id;
			END IF;
			RETURN NEW;
		END IF;

		IF (to_jsonb(NEW) - 'updated_at' - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status') THEN
			RAISE EXCEPTION 'posted journal entry % is immutable except for the reversed status transition', OLD.id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
