-- 0272 - T-602 S1: indexes for the POS receipt lists and for on-hand. docs/tasks/602-performance-first-pass.md S1;
-- hand-authored per ADR-012 s5. Journal idx 272 follows 0270 (0271 is reserved by T-598 S10 and may reach main after this file;
-- the journal test allows the gap). The spec called this 0263; main had moved on, so it takes the next free number from the board.
--
-- WHY. pos_sales_receipts has only UNIQUE constraints, so every receipt list reads the whole table: the till's open-window list
-- (listReceiptsSinceForList), the Z reading of one close (listReceiptsOfClose) and the unclosed receipts of a till (listOpenReceipts).
-- stock_movements has (org_id, store_id, moved_at) and (item_id, location_id, moved_at) but nothing that answers
-- "sum quantity per item for one store", which lowStock and the findings on-hand CTEs run on every dashboard view.
--
-- WHAT IT ADDS (no data changes, no table changes).
--   X1 pos_sales_receipts_store_issued_idx   (store_id, issued_at_device DESC, id DESC)
--   X2 pos_sales_receipts_day_close_idx      (day_close_id, issued_at_device, id) WHERE day_close_id IS NOT NULL
--   X3 pos_sales_receipts_open_idx           (terminal_id, issued_at_device, id) WHERE day_close_id IS NULL   (stays tiny: the unclosed day only)
--   X4 stock_movements_store_item_qty_idx    (org_id, store_id, item_id) INCLUDE (quantity)                    (index-only on-hand sums)
--
-- NO new table, so no classification or RLS registry entry (the build guard keys on tables; 0261 is the precedent).
--
-- LOCK BUDGET. The migrator (packages/db/migrate.ts) applies every pending migration in ONE transaction, and CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction, so it is not used (same choice as 0045, 0218, 0261). A plain CREATE INDEX takes a SHARE lock: reads go on, inserts WAIT until
-- the migration commits. pos_sales_receipts is near-empty before go-live (milliseconds); stock_movements holds the ETL history, so BOSS reads
-- `select count(*) from stock_movements` (read-only) before deploy; the build is seconds. First statement SET LOCAL lock_timeout = '5s' (resets at
-- commit) so a busy table fails the deploy instead of queueing every POS insert behind it; a failed deploy is re-run, never edited.
-- Not 05:30-07:00 Manila. Ship before go-live, while the tables are small. Every statement is its own breakpoint.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX "pos_sales_receipts_store_issued_idx" ON "pos_sales_receipts" ("store_id", "issued_at_device" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "pos_sales_receipts_day_close_idx" ON "pos_sales_receipts" ("day_close_id", "issued_at_device", "id") WHERE "day_close_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pos_sales_receipts_open_idx" ON "pos_sales_receipts" ("terminal_id", "issued_at_device", "id") WHERE "day_close_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "stock_movements_store_item_qty_idx" ON "stock_movements" ("org_id", "store_id", "item_id") INCLUDE ("quantity");
