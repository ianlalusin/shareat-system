-- 0249 - T-557 (store the chosen option ids on session lines and receipt lines; follow-up to T-556 / audit P-001): a line keeps WHICH options were chosen, not only their names.
-- docs/tasks/557-store-option-ids-on-lines.md; hand-authored per ADR-012 s5. Journal idx 249 (reserved), on the one-day-per-index grid.
--
-- WHY. A table_session_lines row keeps its options only inside `name` (" + A, B"), so T-556's replay check compared names: it broke when an option was renamed
-- between the order and a replay, and the options of a frozen receipt line could never be recovered later. Store the ids now, before go-live.
--
-- SHAPE. One nullable uuid[] on each table, no default: NULL = "a line written before 0249" (its options exist only in the name; not backfillable), {} = "no options
-- chosen". Written at INSERT only (sorted, distinct): the session-line column gets no UPDATE grant (the guard freezes it like every non-kitchen column) and the receipt
-- line stays append-only. No new table: the cutover class and the RLS registry entries are unchanged; the table-level INSERT grants of 0238 already cover the new columns.
--
-- LOCK BUDGET: ALTER TABLE ... ADD COLUMN with no default is a catalogue-only change (no rewrite); brief ACCESS EXCLUSIVE lock, the POS tables are small.

ALTER TABLE "table_session_lines" ADD COLUMN "option_value_ids" uuid[];
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ADD COLUMN "option_value_ids" uuid[];
