# 33 — DEF-279: live bodies of the five constraint-trigger invariants

T-270 Part 1 — verification pass against `shareat_test_lanea` (migrated to 0141), required before
writing migration 0142. Read-only: `pg_get_functiondef(p.oid)` against `pg_proc`.

⚠️ **Filename note:** the spec named this `docs/discovery/30-def-279-live-trigger-bodies.md`, but
`30` is already `30-tutorials-assessment.md` (31 and 32 are also taken — `31-def-249-…`,
`32-production-caller-census.md`). Filed as **33**, the true next number. Reported as `[A] QUESTION`
alongside the structural finding below rather than treated as self-evidently correct to rename.

---

## Verdict summary

| Constraint trigger | Function(s) that actually raise | Live vs migration-file | RAISE sites |
|---|---|---|---|
| `journal_entries_balance_check` | `journal_check_entry_balance` (shared, via thin wrapper `journal_entries_trigger_check_balance`) | **identical** | 2 (shared with the row below) |
| `journal_lines_balance_check` | `journal_check_entry_balance` (shared, via thin wrapper `journal_lines_trigger_check_balance`) | **identical** | 2 (shared with the row above) |
| `stock_movements_no_negative_on_hand_trg` | `stock_movements_no_negative_on_hand` | **identical** | 1 |
| `stock_layer_consumptions_ties_trg` | `stock_layers_subledger_ties` | **identical** | 1 |
| `order_wastage_allocations_sum_100_trg` | `order_wastage_allocations_sum_100` | **identical** | 1 |

**No drift found.** Every live body matches its migration-file copy byte-for-byte (whitespace and
all) for all six functions involved. No RAISE statement anywhere in this population currently
carries `ERRCODE`, `HINT`, or `DETAIL` — every one is a plain `RAISE EXCEPTION '<text>', <args>`.
Migration-file source confirmed as the LAST (and only) migration defining each: `0003` (journal
pair), `0063` (stock movements), `0064` (stock layers — `0126` only *mentions* it in a comment,
does not redefine it), `0126` (order wastage).

---

## ⛔ Structural finding: the journal pair shares ONE function with TWO raises, not five 1:1 raise↔constraint pairs

The spec's Contract reads *"each of the five RAISE EXCEPTION statements gains `USING CONSTRAINT =
'<its own constraint name>'`"*, as if there is a clean 1:1 mapping between the 5 named constraint
triggers and 5 RAISE sites, each owned by exactly one trigger. That holds for 3 of the 5. It does
**not** hold for the journal pair:

```
CREATE FUNCTION journal_check_entry_balance(p_entry_id uuid) RETURNS void ...
  RAISE EXCEPTION 'journal entry % must have at least two lines (has %)', ...   -- raise A
  RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', ...   -- raise B

CREATE FUNCTION journal_entries_trigger_check_balance() RETURNS trigger  -- thin wrapper
  PERFORM journal_check_entry_balance(NEW.id);
CREATE CONSTRAINT TRIGGER journal_entries_balance_check
  AFTER INSERT ON journal_entries ... EXECUTE FUNCTION journal_entries_trigger_check_balance();

CREATE FUNCTION journal_lines_trigger_check_balance() RETURNS trigger  -- thin wrapper
  PERFORM journal_check_entry_balance(v_entry_id);
CREATE CONSTRAINT TRIGGER journal_lines_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines ... EXECUTE FUNCTION journal_lines_trigger_check_balance();
```

Both constraint triggers call the SAME shared function through a thin wrapper. Raises A and B live
**only** inside `journal_check_entry_balance`, which has no way to know — and does not currently
receive as an argument — which of the two named triggers is the one whose deferred firing invoked
it. A single hardcoded `USING CONSTRAINT` value in either raise would be wrong whenever the OTHER
trigger is the one that actually fired.

**This is not a hypothetical edge case.** `journal_entries_balance_check` only fires on `INSERT INTO
journal_entries`; `journal_lines_balance_check` fires on `INSERT OR UPDATE OR DELETE` on
`journal_lines`. Editing or deleting the lines of an **existing** (e.g. draft) entry — with no new
`journal_entries` row in that transaction — fires `journal_lines_balance_check` alone. Hardcoding
`journal_entries_balance_check` (the name that would be right for the far more common
insert-entry-and-lines-together path, since `journal_entries` must exist before `journal_lines` can
FK to it, so its deferred trigger is always queued first when both fire together) would misattribute
every draft-line-edit refusal to a trigger that never fired in that transaction.

Reported as `[A] QUESTION` — see the message alongside this doc for the proposed resolution
(catch-and-re-raise at each 1:1 wrapper, `journal_check_entry_balance` itself untouched) and the
alternative considered and rejected (threading `TG_NAME` through the shared function's own
signature).

---

## Full live bodies

### `journal_check_entry_balance(p_entry_id uuid)` — shared by both journal triggers

```sql
CREATE OR REPLACE FUNCTION public.journal_check_entry_balance(p_entry_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
		RAISE EXCEPTION 'journal entry % must have at least two lines (has %)', p_entry_id, v_line_count;
	END IF;

	IF v_debit_sum <> v_credit_sum THEN
		RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', p_entry_id, v_debit_sum, v_credit_sum;
	END IF;
END;
$function$
```

### `journal_entries_trigger_check_balance()` — wrapper for `journal_entries_balance_check`

```sql
CREATE OR REPLACE FUNCTION public.journal_entries_trigger_check_balance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	PERFORM journal_check_entry_balance(NEW.id);
	RETURN NULL;
END;
$function$
```

### `journal_lines_trigger_check_balance()` — wrapper for `journal_lines_balance_check`

```sql
CREATE OR REPLACE FUNCTION public.journal_lines_trigger_check_balance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
	v_entry_id uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN
		v_entry_id := OLD.entry_id;
	ELSE
		v_entry_id := NEW.entry_id;
	END IF;
	PERFORM journal_check_entry_balance(v_entry_id);
	RETURN NULL;
END;
$function$
```

### `stock_movements_no_negative_on_hand()` — `stock_movements_no_negative_on_hand_trg`

```sql
CREATE OR REPLACE FUNCTION public.stock_movements_no_negative_on_hand()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
	on_hand numeric(14,3);
BEGIN
	SELECT COALESCE(sum("quantity"), 0) INTO on_hand
	FROM "stock_movements"
	WHERE "item_id" = NEW."item_id" AND "location_id" = NEW."location_id";

	IF on_hand < 0 THEN
		RAISE EXCEPTION 'stock would go negative: item % at location % would be % after this movement',
			NEW."item_id", NEW."location_id", on_hand;
	END IF;
	RETURN NULL;
END;
$function$
```

### `stock_layers_subledger_ties()` — `stock_layer_consumptions_ties_trg`

⚠️ Function name (`stock_layers_subledger_ties`) differs from the constraint trigger name
(`stock_layer_consumptions_ties_trg`) — noted so the migration edits the right object under its
`CREATE OR REPLACE FUNCTION` name while citing the trigger's name in `USING CONSTRAINT`.

```sql
CREATE OR REPLACE FUNCTION public.stock_layers_subledger_ties()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
			layer."quantity" - layer."remaining_quantity", consumed;
	END IF;
	RETURN NULL;
END;
$function$
```

### `order_wastage_allocations_sum_100()` — `order_wastage_allocations_sum_100_trg`

```sql
CREATE OR REPLACE FUNCTION public.order_wastage_allocations_sum_100()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
	target_wastage uuid;
	total numeric(7,2);
BEGIN
	target_wastage := COALESCE(NEW."wastage_id", OLD."wastage_id");

	SELECT COALESCE(sum("percent"), 0) INTO total
	FROM "order_wastage_allocations"
	WHERE "wastage_id" = target_wastage;

	IF total <> 0 AND total <> 100 THEN
		RAISE EXCEPTION 'order_wastage % allocations sum to %, not 100', target_wastage, total;
	END IF;
	RETURN NULL;
END;
$function$
```
