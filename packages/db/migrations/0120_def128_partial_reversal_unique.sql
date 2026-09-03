-- 0120 — DEF-128: stock_layer_consumptions' (layer, movement) uniqueness relaxed to unreversed
-- rows only, so a PARTIAL reversal (T-179) can legitimately split one row into two: the original
-- shrinks to what remains outstanding, and a new row, already reversed, carries what was given
-- back. Found live: `reverseConsumption` used to ignore a partial `give` and always reverse a
-- row's FULL quantity — silently wrong the moment two sequential partial returns crossed one row.
--
-- HAND-WRITTEN, per DEF-073/DEF-121. Never edited after apply.

DROP INDEX "stock_layer_consumptions_layer_movement_key";--> statement-breakpoint

CREATE UNIQUE INDEX "stock_layer_consumptions_layer_movement_key"
	ON "stock_layer_consumptions" ("layer_id", "movement_id")
	WHERE "reversed_by_movement_id" IS NULL;--> statement-breakpoint
