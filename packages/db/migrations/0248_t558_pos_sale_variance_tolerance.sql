-- 0248 - T-558 (POS sale variance tolerance): the starting row for pos.sale_variance_tolerance. docs/tasks/558-pos-sale-variance-tolerance.md R1; bible row 453; hand-authored per ADR-012 s5.
-- Journal idx 248, `when` = 0247's + 86400000. Merges AFTER T-531 (0247).
--
-- WHY. A sale paid a few centavos short of the server's total (the tablet priced it offline) is now recorded as a variance, never refused. The largest gap that
-- counts as routine is the registry key pos.sale_variance_tolerance (default 0.01, ceiling 0.10), read through readPosRules.
--
-- SHAPE. DATA ONLY, the 0241/0245 pattern: one INSERT ... SELECT over organizations (effective 2000-01-01, set_by NULL, reason 'Starting value'). No schema change: nothing in
-- the database assumes payments >= total (checked: pos_sales_receipts / pos_sales_receipt_payments carry no such CHECK or trigger). No ON CONFLICT: the table has no unique key.
--
-- LOCK BUDGET: one INSERT ... SELECT, one row per organisation. RLS is FORCEd on the table (0239) and a migration reads every organisation, so row_security is
-- switched off for the statement and back on after, as 0241 and 0245 did.
--
-- The value equals the registry default; t558-seed-matches-registry pins that 0239, 0241, 0245 and this file together equal EVERY registry default.

SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", 'pos.sale_variance_tolerance', 0.01::numeric, DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o;
--> statement-breakpoint
SET LOCAL row_security = on;
