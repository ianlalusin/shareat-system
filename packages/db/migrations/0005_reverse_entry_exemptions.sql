-- 0005 — T-106 (docs/tasks/106-reverse-entry.md): make reversal possible without
-- weakening the rules T-103 already enforces for ordinary postings.
--
-- Three narrow, additive changes, none of them a schema/table shape change (hence no
-- drizzle-kit snapshot, matching 0002 and 0004's own precedent — both hand-written,
-- neither generated one):
--
--   1. journal_lines_check_account_eligible — Contract §5. A reversal line must be
--      allowed to target a POSTABLE-but-non-ACTIVE account (reserved or archived);
--      is_postable stays enforced unconditionally, exactly as before, so a header
--      account is still rejected in every case. The exemption is keyed on a
--      TRANSACTION-LOCAL setting (`set_config(..., true)` — `is_local = true`,
--      cleared automatically at COMMIT/ROLLBACK, never visible to any other
--      transaction), set by reverseEntry's own repo call
--      (journalRepo.beginReversalPostingContext) immediately before it calls postEntry
--      to build the reversal's lines, and by nothing else. Task report: the spec's own
--      suggested mechanism — keying the exemption on the parent entry's
--      `reversal_of_entry_id IS NOT NULL` — does not work, because reversal_of_entry_id
--      cannot be populated before the reversal's LINES are inserted (see point 2 below
--      for why), which is exactly when this trigger fires. A session-local GUC is the
--      substitute that still satisfies "the mechanism is the implementer's call."
--
--   2. journal_entries_check_posted_immutable — Contract §2 requires the new entry's
--      reversal_of_entry_id to point at the original. postEntry (T-105, untouched per
--      this task's Scope) has no field for it, and by the time postEntry returns, the
--      new entry is ALREADY 'posted' — T-103's own immutability trigger then freezes
--      every column except the status transition. There is no point between
--      postEntry's internal insertDraftEntry and postDraftEntry steps that reverseEntry
--      can reach without either modifying postEntry or hand-rolling a second
--      draft->lines->posted sequence — both explicitly forbidden by the task spec.
--      This migration adds ONE additional narrow exception, alongside the existing
--      posted->reversed status transition: a posted entry may have reversal_of_entry_id
--      backfilled EXACTLY ONCE, from NULL to a value, with every other column
--      (including reversal_of_entry_id itself, once set) still frozen. reverseEntry
--      performs this backfill, in the same transaction, immediately after postEntry
--      returns. See the task report for why this is flagged as a spec tension, not
--      silently worked around: the migration this causes is required for Contract §2
--      itself, not only for §5 as the spec text anticipated ("a NEW migration, only if
--      §5 requires one").
--
--   3. journal_lines_check_posted_immutable — a genuine gap found while implementing
--      this task, not requested by T-106's own contract: the UPDATE/DELETE branch
--      added by migration 0004 (DEF-031) only ever checked `entry_status = 'posted'`.
--      T-103/T-105 never produced a 'reversed' entry, so this was dormant. Once T-106
--      introduces the posted -> reversed transition, that check leaves a REVERSED
--      entry's lines mutable by raw SQL — directly threatening invariant 6 ("nothing
--      deleted, no amount changed on the original"). Fixed here by checking
--      `entry_status IN ('posted', 'reversed')` instead of `= 'posted'`. Logged for
--      docs/DEFECTS-REGISTER.md (out of this task's Scope to edit that file directly;
--      reported in the task report instead).
--
-- 0003 and 0004 are already applied and are therefore never edited (bible §2 rule 8).
-- This replaces their trigger functions forward, as a new migration.

CREATE OR REPLACE FUNCTION "journal_lines_check_account_eligible"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	acct_postable boolean;
	acct_status text;
	is_reversal_context boolean;
BEGIN
	SELECT is_postable, status INTO acct_postable, acct_status FROM accounts WHERE id = NEW.account_id;

	IF acct_postable IS NULL THEN
		RAISE EXCEPTION 'account % does not exist', NEW.account_id;
	END IF;

	-- Unconditional, reversal or not: a header was never postable, so no original line
	-- could ever have targeted one (Contract §5's second sentence).
	IF NOT acct_postable THEN
		RAISE EXCEPTION 'account % is not postable (it is a header account)', NEW.account_id;
	END IF;

	-- Transaction-local only (`is_local = true` on the reverseEntry side's
	-- set_config call) — coalesce so an unset GUC (every ordinary postEntry caller,
	-- always) reads as NOT exempt rather than erroring.
	is_reversal_context := coalesce(current_setting('app.reversal_posting', true), '') = 'on';

	IF acct_status <> 'active' AND NOT is_reversal_context THEN
		RAISE EXCEPTION 'account % cannot be posted to (status = %)', NEW.account_id, acct_status;
	END IF;

	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "journal_entries_check_posted_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.status = 'posted' THEN
			RAISE EXCEPTION 'posted journal entry % cannot be deleted', OLD.id;
		END IF;
		RETURN OLD;
	END IF;

	-- TG_OP = 'UPDATE'
	IF OLD.status = 'posted' THEN
		IF NEW.status NOT IN ('posted', 'reversed') THEN
			RAISE EXCEPTION 'posted journal entry % may only remain posted or transition to reversed', OLD.id;
		END IF;

		-- T-106: a freshly-posted reversal entry may have its OWN reversal_of_entry_id
		-- backfilled, exactly once (NULL -> a value), and nothing else may change in
		-- that same UPDATE. Once set, this column is frozen again like every other —
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

CREATE OR REPLACE FUNCTION "journal_lines_check_posted_immutable"() RETURNS trigger
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
		-- Unchanged from 0004: a line may only ever be INSERTed while its parent entry
		-- is still 'draft'. A 'reversed' entry's lines can no more accept a new line
		-- than a 'posted' one's — IS DISTINCT FROM 'draft' covers both, plus a missing
		-- parent (entry_status IS NULL).
		IF entry_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'cannot insert a line onto journal entry % (status = %) -- lines may only be inserted while an entry is draft', v_entry_id, entry_status;
		END IF;
		RETURN NEW;
	END IF;

	-- TG_OP = 'UPDATE' or 'DELETE'. T-106 fix: 0004 only ever froze lines while
	-- entry_status = 'posted'. T-103/T-105 never produced a 'reversed' entry, so a
	-- REVERSED entry's lines were never actually exercised against this check — once
	-- T-106 introduces posted -> reversed, that gap is live: the original's lines would
	-- become mutable again the instant it is reversed. Both terminal statuses are
	-- immutable now.
	IF entry_status IN ('posted', 'reversed') THEN
		RAISE EXCEPTION 'journal entry % is % ; its lines are immutable', v_entry_id, entry_status;
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
