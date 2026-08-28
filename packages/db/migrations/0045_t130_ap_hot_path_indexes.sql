-- 0045 — T-130 follow-up: the four indexes AP's hot paths were missing.
--
-- HAND-WRITTEN, like 0020-0044. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⚠️ Every one of these backs a query that runs on ordinary writes or on a screen that loads per
-- supplier, and every one was a sequential scan before this migration. Found by the 2026-08-28
-- audit; confirmed absent by querying `pg_indexes` on the live database rather than by reading
-- the schema file.
--
--   1. `expenses.supplier_invoice_id` — the `expenses_check_invoice_open_for_recording` trigger
--      SUMs `expenses` by this column on EVERY insert AND every update of an expense (a void and
--      a post are both updates). Unindexed, the cost of recording one expense grew with the
--      total number of expenses ever recorded.
--   2. `ap_payment_allocations.expense_id` — `openItems` and `aging` both join through it. The
--      table's only index was the `(ap_payment_id, expense_id)` unique, whose leading column is
--      the wrong one for this direction.
--   3. `ap_payments (org_id, supplier_id)` — the supplier detail screen's payment history.
--   4. `ap_payments (store_id)` — store-scoped AP, added the same day (Ian: "make it store scoped
--      not org but store").
--
-- ⭐ Deliberately NOT `CREATE INDEX CONCURRENTLY`: drizzle runs each migration inside one
-- transaction (verified in `pg-core/dialect`), and CONCURRENTLY cannot run in a transaction
-- block. These tables are small and pre-cutover, so a brief ACCESS SHARE-blocking build is the
-- right trade. ⚠️ If one of these ever needs re-creating against a live, loaded production
-- database, it must be done OUTSIDE the migrator for that reason.

CREATE INDEX "expenses_supplier_invoice_idx" ON "expenses" USING btree ("supplier_invoice_id");--> statement-breakpoint
CREATE INDEX "ap_payment_allocations_expense_idx" ON "ap_payment_allocations" USING btree ("expense_id");--> statement-breakpoint
CREATE INDEX "ap_payments_org_supplier_idx" ON "ap_payments" USING btree ("org_id","supplier_id");--> statement-breakpoint
CREATE INDEX "ap_payments_store_idx" ON "ap_payments" USING btree ("store_id");
