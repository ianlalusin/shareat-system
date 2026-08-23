-- 0004 — DEF-031: close the INSERT hole in posted-entry immutability.
--
-- T-103 (0003_journal_entries_and_lines.sql) scoped `journal_lines_posted_immutable` to
-- BEFORE UPDATE OR DELETE only, deliberately, because blocking INSERT unconditionally
-- made it impossible to build an already-posted entry's lines inside the same
-- transaction that inserts the entry as status='posted'. See that migration's header
-- comment and docs/DEFECTS-REGISTER.md DEF-031 for the full history, including the
-- xmin/txid_current() approach that was considered and correctly rejected as
-- unnecessary machinery.
--
-- docs/tasks/105-posting-engine.md's answer: nothing needs to distinguish "still being
-- built" from "already committed" via transaction-id tricks, because postEntry (T-105)
-- never builds a posted entry any other way. It ALWAYS writes draft-first: insert the
-- entry as 'draft', insert every line while it is still 'draft', then flip it to
-- 'posted' as the LAST statement of the transaction. Under that ordering, "a line may
-- never be INSERTed onto an entry whose status is not draft" is both the closed rule
-- AND the rule every legitimate caller already satisfies — no relaxation needed for the
-- one construction sequence T-103 had to keep working.
--
-- This migration replaces the trigger (BEFORE UPDATE OR DELETE -> BEFORE INSERT OR
-- UPDATE OR DELETE) and its function. UPDATE/DELETE behaviour on a posted entry's lines
-- is UNCHANGED from T-103 (frozen while status='posted'); only the INSERT branch is
-- new — see the task report for a scope note on 'reversed' entries (T-106, out of
-- scope here).
--
-- 0003 is already applied and is therefore never edited (bible §2 rule 8). This
-- replaces its trigger forward, as a new migration.
DROP TRIGGER "journal_lines_posted_immutable" ON "journal_lines";
--> statement-breakpoint
DROP FUNCTION "journal_lines_check_posted_immutable"();
--> statement-breakpoint

CREATE FUNCTION "journal_lines_check_posted_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_entry_id uuid;
	entry_status text;
BEGIN
	IF TG_OP = 'DELETE' THEN
		v_entry_id := OLD.entry_id;
	ELSE
		v_entry_id := NEW.entry_id;
	END IF;

	SELECT status INTO entry_status FROM journal_entries WHERE id = v_entry_id;

	IF TG_OP = 'INSERT' THEN
		-- DEF-031: a line may never be INSERTed onto an entry whose status is not
		-- 'draft'. This is the whole fix — draft-first ordering (T-105's postEntry)
		-- means every legitimate line INSERT happens while its parent entry is still
		-- 'draft', so this closes the hole (raw SQL appending a balanced pair of lines
		-- to an already-posted entry, in a later transaction, without tripping the
		-- balance trigger) without blocking the one construction sequence T-103 needed
		-- to keep working. `IS DISTINCT FROM` (not `<>`) so a NEW.entry_id matching no
		-- row at all (entry_status IS NULL) is also rejected here, synchronously,
		-- rather than silently passing this check.
		IF entry_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'cannot insert a line onto journal entry % (status = %) -- lines may only be inserted while an entry is draft', v_entry_id, entry_status;
		END IF;
		RETURN NEW;
	END IF;

	-- TG_OP = 'UPDATE' or 'DELETE' — unchanged from T-103: a posted entry's lines are
	-- frozen. (Reversal, T-106, is out of scope here; see the task report.)
	IF entry_status = 'posted' THEN
		RAISE EXCEPTION 'journal entry % is posted; its lines are immutable', v_entry_id;
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_lines_posted_immutable"
	BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
	FOR EACH ROW EXECUTE FUNCTION "journal_lines_check_posted_immutable"();
