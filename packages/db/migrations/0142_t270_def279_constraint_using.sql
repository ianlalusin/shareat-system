-- 0142 — T-270/DEF-279: name the constraint on the five deepest accounting/inventory invariants.
-- docs/tasks/270-def-279-using-constraint-on-five-invariants.md
--
-- These five raise a bare `RAISE EXCEPTION '<hand-written text>'` and never emit Postgres's own
-- `violates check constraint "name"` phrasing, so `recordIfUnmappedConstraint`'s refusal counter
-- has reported a structural zero for all five since it shipped (bible §13 row 189) — the highest-
-- value half of the double-signal rule, silent by construction, not by safety. Ian ruled
-- 2026-09-10: log it, sequence after T-261.
--
-- ⛔ `USING CONSTRAINT = '<name>'` alone is NOT sufficient — verified live (docs/discovery/33-*.md,
-- spec §SPEC CORRECTION 1): it sets `err.constraint_name`, a structured field the counter's
-- `parseConstraintName` never reads (that regex parses the human-readable MESSAGE text, which these
-- hand-written raises don't touch). The other half of this fix — `constraint-messages.ts` preferring
-- `err.constraint_name` over the regex — is a separate, non-DDL change alongside this migration, not
-- in it.
--
-- No new tables: no `rls/registry.ts` or `cutover/classification.ts` entry required
-- (ADR-012 §5 step 4). No RLS touched. No CREATE CONSTRAINT TRIGGER statement is touched —
-- replacing one would change its timing/deferrability, and these are DEFERRABLE INITIALLY DEFERRED
-- by design; only the underlying FUNCTION bodies change, via CREATE OR REPLACE, so the existing
-- triggers (still pointing at the same function names) pick up the new bodies with nothing else
-- to alter.
--
-- ===========================================================================================
-- 1. journal_entries_balance_check / journal_lines_balance_check.
--
--    ⭐ These two constraint triggers share ONE helper, `journal_check_entry_balance`, called via a
--    thin per-table wrapper — NOT a clean 1:1 raise-per-constraint the way the other three are. The
--    shared helper has no way to know which of the two triggers invoked it (docs/discovery/33-*.md
--    §Structural finding), so a hardcoded constraint name in either of its two raises would
--    misattribute every refusal caused by the OTHER trigger — concretely, editing or deleting the
--    lines of an EXISTING draft entry (no new `journal_entries` row in that transaction) fires
--    `journal_lines_balance_check` alone, and would be reported under the wrong name.
--
--    Fix: `journal_check_entry_balance` gains a second parameter, `p_constraint text`, threaded
--    through both of its RAISE statements. Its two callers are its ONLY callers in the world —
--    verified by `git grep` across the repo and by `pg_proc.prosrc` against the live database
--    (spec §SPEC CORRECTION 1) — both already inside this migration, so the signature change is
--    free. Catch-and-re-raise at each wrapper was considered and rejected: it would also catch
--    deadlocks/serialization failures/statement cancellation as if they were constraint violations,
--    and opens a subtransaction on the hot path of every journal write; parameter-threading has
--    neither problem and needs no SQLERRM/SQLSTATE juggling since the original RAISE is never
--    replaced.
--
--    `journal_check_entry_balance(uuid)` is DROPPED, not left as a dead overload — nothing calls it
--    once both wrappers below pass the new second argument.
-- ===========================================================================================
DROP FUNCTION "journal_check_entry_balance"("p_entry_id" uuid);
--> statement-breakpoint

CREATE FUNCTION "journal_check_entry_balance"("p_entry_id" uuid, "p_constraint" text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	v_line_count integer;
	v_debit_sum numeric(14,2);
	v_credit_sum numeric(14,2);
BEGIN
	IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = p_entry_id) THEN
		RETURN;
	END IF;

	SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
	  INTO v_line_count, v_debit_sum, v_credit_sum
	FROM journal_lines WHERE entry_id = p_entry_id;

	IF v_line_count < 2 THEN
		RAISE EXCEPTION 'journal entry % must have at least two lines (has %)', p_entry_id, v_line_count
			USING CONSTRAINT = p_constraint;
	END IF;

	IF v_debit_sum <> v_credit_sum THEN
		RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', p_entry_id, v_debit_sum, v_credit_sum
			USING CONSTRAINT = p_constraint;
	END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "journal_entries_trigger_check_balance"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM journal_check_entry_balance(NEW.id, 'journal_entries_balance_check');
	RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "journal_lines_trigger_check_balance"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_entry_id uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN
		v_entry_id := OLD.entry_id;
	ELSE
		v_entry_id := NEW.entry_id;
	END IF;
	PERFORM journal_check_entry_balance(v_entry_id, 'journal_lines_balance_check');
	RETURN NULL;
END;
$$;
--> statement-breakpoint

-- ===========================================================================================
-- 2. stock_movements_no_negative_on_hand_trg — one function, one trigger, one raise. Straight
--    USING CONSTRAINT addition, nothing else changes.
-- ===========================================================================================
CREATE OR REPLACE FUNCTION "stock_movements_no_negative_on_hand"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	on_hand numeric(14,3);
BEGIN
	SELECT COALESCE(sum("quantity"), 0) INTO on_hand
	FROM "stock_movements"
	WHERE "item_id" = NEW."item_id" AND "location_id" = NEW."location_id";

	IF on_hand < 0 THEN
		RAISE EXCEPTION 'stock would go negative: item % at location % would be % after this movement',
			NEW."item_id", NEW."location_id", on_hand
			USING CONSTRAINT = 'stock_movements_no_negative_on_hand_trg';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint

-- ===========================================================================================
-- 3. stock_layer_consumptions_ties_trg — the FUNCTION is named `stock_layers_subledger_ties`
--    (0064's own naming), which differs from the TRIGGER's name; USING CONSTRAINT cites the
--    trigger's name, matching every other constraint trigger's own name, not the function's.
-- ===========================================================================================
CREATE OR REPLACE FUNCTION "stock_layers_subledger_ties"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	layer record;
	consumed numeric(14,3);
	target_layer uuid;
BEGIN
	target_layer := COALESCE(NEW."layer_id", OLD."layer_id");

	SELECT "quantity", "remaining_quantity" INTO layer
	FROM "stock_layers" WHERE "id" = target_layer;

	IF NOT FOUND THEN RETURN NULL; END IF;

	SELECT COALESCE(sum("quantity"), 0) INTO consumed
	FROM "stock_layer_consumptions"
	WHERE "layer_id" = target_layer AND "reversed_by_movement_id" IS NULL;

	IF layer."quantity" - layer."remaining_quantity" <> consumed THEN
		RAISE EXCEPTION 'layer % does not tie: quantity % minus remaining % is %, but its subledger sums to %',
			target_layer, layer."quantity", layer."remaining_quantity",
			layer."quantity" - layer."remaining_quantity", consumed
			USING CONSTRAINT = 'stock_layer_consumptions_ties_trg';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint

-- ===========================================================================================
-- 4. order_wastage_allocations_sum_100_trg — one function, one trigger, one raise.
-- ===========================================================================================
CREATE OR REPLACE FUNCTION "order_wastage_allocations_sum_100"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	target_wastage uuid;
	total numeric(7,2);
BEGIN
	target_wastage := COALESCE(NEW."wastage_id", OLD."wastage_id");

	SELECT COALESCE(sum("percent"), 0) INTO total
	FROM "order_wastage_allocations"
	WHERE "wastage_id" = target_wastage;

	-- Zero allocations is lawful (a tracked wastage may have none yet, or an instant/absorbed one
	-- may never need any). Only a NON-ZERO total that is not exactly 100 is refused.
	IF total <> 0 AND total <> 100 THEN
		RAISE EXCEPTION 'order_wastage % allocations sum to %, not 100', target_wastage, total
			USING CONSTRAINT = 'order_wastage_allocations_sum_100_trg';
	END IF;
	RETURN NULL;
END;
$$;
