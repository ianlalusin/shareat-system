-- 0266 -- T-534 S4: a POS-derived sales day may carry refunds. docs/tasks/534-pos-convert-correction-refund.md (S4, "The end-of-day close, the cash count and the books"); bible rows 272, 391.
-- Hand-authored per ADR-012 s5. Journal head on main when written: 0261; 0265 is S1 of this task, so this is idx 266 and `when` is one day after it (DEF-039).
--
-- WHY. 0183 (T-375) let ONLY a v1 feed day carry `refunds` (CHECK sales_days_refunds_only_on_feed_days_check: source = 'pos_v1_day_feed' or refunds = 0). The Z now
-- derives a day from the POS receipts (source = 'pos_receipts', 0247) and a refund of a receipt (S4) must reach it: the day's `refunds` = the refunds the Z collected, and
-- `routeSalesDay` already books that figure as Dr 4950 with cash and wallets net of it (T-375 W11, no posting code is added). Without this change the Z of any day with a refund
-- would be refused by the database. A typed day (legacy_typed) still can have none.
--
-- WHAT CHANGES. One CHECK is dropped and re-added (the constraint name is kept so every reference stays true): source in ('pos_v1_day_feed', 'pos_receipts') or refunds = 0.
-- NOT CHANGED: the figure-lock triggers (0185 / 0187 / 0247 already lock `refunds` with the other figures), the non-negative and finite CHECKs on `refunds`, every grant, no table.
-- Existing rows all satisfy the new CHECK (it only admits more).
ALTER TABLE "sales_days" DROP CONSTRAINT "sales_days_refunds_only_on_feed_days_check";
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_refunds_only_on_feed_days_check" CHECK ("source" IN ('pos_v1_day_feed', 'pos_receipts') OR "refunds" = 0);
