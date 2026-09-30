-- 0175 — T-372 S2 (DEF-511 DB backstop), docs/tasks/372-def-511-prepared-order-stays-prepared.md
-- §S2, R4 and R5b. (0173 = T-367, 0174 = T-368 S0.)
--
-- R4 — a ready order's ready_at/ready_by are write-once. `trade_orders_ready_is_final_trg` refuses
-- any UPDATE that clears, retimes or re-attributes either column once ready_at is set, for every
-- writer — raw SQL, the ETL, or a future repo helper — not only the domain's own S1 refusal (bible
-- §15.11: the domain gives the sentence, the database gives the guarantee). DELETE is out of its
-- scope, on purpose (Ian's ruling on the 0175 audit): no domain path deletes an order, the app
-- role's DELETE grant on trade_orders is a separate finding (DEF-548, logged), and a DELETE arm
-- here would also refuse the 2027 cutover purge. It judges only OLD and NEW on the same row for
-- the UPDATE it does guard, so it is a history_guard (ENABLE ALWAYS — must keep firing under
-- session_replication_role = replica, T-354's own rule).
--
-- ⛔ Erratum (orchestrator, 2026-10-01, tester RED): R5 (`trade_orders_fees_non_negative_check`)
-- is DROPPED from this migration. It already exists, byte-identical, from
-- 0056_t151_landed_cost_and_branch_price.sql:34-35 — re-adding it would fail 42710
-- (duplicate_object). See t372-ready-at-trigger.test.ts's header for the verification.
--
-- R5b IS new: `trade_order_lines` never got the sibling rule `delivery_lines` already has
-- (0066_t166_deliveries.sql:93). Production precheck (`select count(*) from trade_order_lines
-- where received_quantity < 0`) was run on the lane test DB and shareat_dev: 0 rows both.
--
-- No new table, so there is no classification.ts or rls/registry.ts entry.
--
-- HAND-WRITTEN, per ADR-012 §5 — `drizzle-kit generate` is retired.

CREATE OR REPLACE FUNCTION "trade_orders_ready_is_final"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'order % is ready — ready is final and cannot be cleared or changed (DEF-511)', OLD."id";
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "trade_orders_ready_is_final_trg"
	BEFORE UPDATE OF "ready_at", "ready_by" ON "trade_orders"
	FOR EACH ROW
	WHEN (OLD."ready_at" IS NOT NULL AND (NEW."ready_at" IS DISTINCT FROM OLD."ready_at" OR NEW."ready_by" IS DISTINCT FROM OLD."ready_by"))
	EXECUTE FUNCTION "trade_orders_ready_is_final"();--> statement-breakpoint

ALTER TABLE "trade_orders" ENABLE ALWAYS TRIGGER "trade_orders_ready_is_final_trg";--> statement-breakpoint

ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_received_quantity_non_negative_check"
	CHECK ("received_quantity" IS NULL OR "received_quantity" >= 0);
