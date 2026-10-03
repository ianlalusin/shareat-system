-- 0179 — T-372 S6b (DEF-513), docs/tasks/372-def-511-prepared-order-stays-prepared.md §S6, amendment 2
-- (Ian, 2026-10-01). (0178 = T-370; 0177 = T-369 S7.)
--
-- A branch that COUNTS MORE than the commissary dispatched is an over-receipt. `confirmReceipt` now books only what
-- was sent (the cap) and raises a `trade_discrepancies` row with direction 'over' for the excess, so the same table,
-- the same day-open block and the same manager decision cover both directions. This migration gives the row its
-- direction, the two over-only dispositions, and the rule that an over row's value may be 0.
--
--   direction 'short'  (the default; every existing row)   audit | loss | charge | late_receipt   — as today
--   direction 'over'                                        audit | extra_dispatch | return
--
-- `extra_dispatch` is the commissary manager confirming it really sent the extra: it books the extra at both stores
-- in one entry (no 1340 leg). `return` posts nothing — the excess was never booked, so a reversal would take the
-- branch below what it holds. Amendment 2 WITHDRAWS amendment 1's `top_up` (no `top_up_order_line_id` column, unique
-- index or shape CHECK, and `trade_discrepancies_resolution_terminal()` is NOT replaced).
--
-- PRECHECK (run on every database BEFORE applying; each must be 0):
--   select count(*) from trade_discrepancies where value <= 0;
--   select count(*) from trade_discrepancies
--     where disposition is not null and disposition not in ('audit','loss','charge','late_receipt');
-- The first: every existing row is a shortfall, and the old CHECK required value > 0. The second: the old
-- disposition CHECK already forbade anything else, and every existing row defaults to direction 'short', so each
-- of its dispositions is in the new allowed set. If either is non-zero on some database, the ADD CONSTRAINT below
-- fails and the apply STOPS — Ian decides; this migration does no data surgery.
--
-- The new CHECKs validate EXISTING rows, which is why the precheck matters.
--
-- No new table, so no classification.ts or rls/registry.ts entry; the app role already has UPDATE on
-- trade_discrepancies (resolve and defer write it), so there is no GRANT either.
--
-- HAND-WRITTEN, per ADR-012 §5 — `drizzle-kit generate` is retired.

ALTER TABLE "trade_discrepancies" ADD COLUMN "direction" text NOT NULL DEFAULT 'short';--> statement-breakpoint

ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_direction_check"
	CHECK ("direction" IN ('short','over'));--> statement-breakpoint

ALTER TABLE "trade_discrepancies" DROP CONSTRAINT "trade_discrepancies_disposition_check";--> statement-breakpoint

ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_disposition_check"
	CHECK ("disposition" IS NULL OR "disposition" IN ('audit','loss','charge','late_receipt','extra_dispatch','return'));--> statement-breakpoint

-- Which dispositions belong to which direction. `audit` is the decision to WAIT and fits both.
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_disposition_direction_check"
	CHECK (
		"disposition" IS NULL
		OR "disposition" = 'audit'
		OR ("direction" = 'short' AND "disposition" IN ('loss','charge','late_receipt'))
		OR ("direction" = 'over' AND "disposition" IN ('extra_dispatch','return'))
	);--> statement-breakpoint

-- A shortfall is always worth something; an over row's value is informational (it posts nothing) and may be 0 when
-- the line's dispatch cost is 0.
ALTER TABLE "trade_discrepancies" DROP CONSTRAINT "trade_discrepancies_value_positive_check";--> statement-breakpoint

ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_value_check"
	CHECK ("value" > 0 OR ("direction" = 'over' AND "value" >= 0));--> statement-breakpoint

-- ⛔ The direction is fixed when the receipt raises the row. Every disposition rule above hangs off it, so changing
-- it afterwards would let a short row become an over row (or back) and slip past them. A history_guard: it judges
-- only OLD and NEW on the same row, and fires under session_replication_role = replica (T-354's rule).
CREATE OR REPLACE FUNCTION "trade_discrepancies_direction_fixed"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'discrepancy % is %: its direction is fixed when the receipt raises it', OLD."id", OLD."direction";
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "trade_discrepancies_direction_fixed_trg"
	BEFORE UPDATE OF "direction" ON "trade_discrepancies"
	FOR EACH ROW
	WHEN (NEW."direction" IS DISTINCT FROM OLD."direction")
	EXECUTE FUNCTION "trade_discrepancies_direction_fixed"();--> statement-breakpoint

ALTER TABLE "trade_discrepancies" ENABLE ALWAYS TRIGGER "trade_discrepancies_direction_fixed_trg";
