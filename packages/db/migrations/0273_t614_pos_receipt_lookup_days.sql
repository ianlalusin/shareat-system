-- 0273 - T-614 S2 (DEF-937 follow-up): the starting row for pos.receipt_lookup_days. docs/tasks/614-pos-follow-ups.md S2; hand-authored per ADR-012 s5.
-- Journal idx 273, `when` = 0269's + 4 x 86400000 (idx 270 to 272 are reserved by other lanes; the grid is one day per index).
--
-- WHY. "Find a receipt" on the POS looked back a hard-coded 30 days (T-613 D4). That is a business value, so it becomes the registry key
-- pos.receipt_lookup_days (whole days, default 30, 1 to 365), read by findSalesReceiptByNo and shown on Settings > Business rules.
--
-- SHAPE. DATA ONLY, the 0245/0255 pattern: one INSERT ... SELECT over organizations (effective 2000-01-01, set_by NULL, reason 'Starting value'). No schema change.
-- LOCK BUDGET: one INSERT ... SELECT, one row per organisation. RLS is FORCEd on the table (0239); row_security is switched off for the statement and back on after.
-- The value equals the registry default; the seed-matches-registry test pins that every seed file together equals EVERY registry default.

SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", 'pos.receipt_lookup_days', 30::numeric, DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o;
--> statement-breakpoint
SET LOCAL row_security = on;
