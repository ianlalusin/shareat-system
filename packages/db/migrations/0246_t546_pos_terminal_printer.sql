-- 0246 - T-546 (POS till printer settings): the receipt paper width and copy count live on the till (pos_terminals), not on the tablet.
-- docs/tasks/546-pos-terminal-printer-settings.md R1; hand-authored per ADR-012 s5. Journal idx 246 (reserved), on the one-day-per-index grid.
--
-- WHY. Ian's standing rule (5 Nov): no business or device setting is hard-coded. T-528 shipped with a fixed 58 mm / Font A layout and 1 copy
-- (two `shortcut:` constants). v1 kept these in each tablet's local settings and lost them when a tablet was replaced. Here they sit on the till: a
-- replaced tablet takes over the till's number series (DEF-587) AND its printer settings. The snapshot hands them to the tablet (R3).
--
-- SHAPE. Two NOT NULL columns with defaults (58, 1), so every existing row reads the defaults and a till made without them does too. CHECKs keep the
-- closed lists (paper 58 or 80; copies 1 to 3) in the database, whoever writes. The column UPDATE grant gains the two columns; terminal_no stays frozen.
-- No new table: the cutover class and the RLS registry entry of pos_terminals are unchanged (0238).
--
-- LOCK BUDGET: ALTER TABLE ... ADD COLUMN with a constant DEFAULT is a catalogue-only change (no rewrite); the table holds a handful of rows per store.

ALTER TABLE "pos_terminals" ADD COLUMN "receipt_paper_mm" smallint DEFAULT 58 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD COLUMN "receipt_copies" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_receipt_paper_mm_check" CHECK ("receipt_paper_mm" IN (58, 80));
--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_receipt_copies_check" CHECK ("receipt_copies" BETWEEN 1 AND 3);
--> statement-breakpoint
GRANT UPDATE ("receipt_paper_mm","receipt_copies") ON "pos_terminals" TO "shareat_app";
