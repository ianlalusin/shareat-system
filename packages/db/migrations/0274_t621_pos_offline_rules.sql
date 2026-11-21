-- 0274 - T-621 S2: the starting rows for pos.offline_unsent_warn_amount and pos.offline_xslip_hours. docs/tasks/621-pos-offline-safety-rails.md S2;
-- hand-authored per ADR-012 s5. Journal idx 274, `when` = 0273's + 86400000 (one day per index).
--
-- WHY. The POS v2 design promised two offline safety rails (docs/plans/pos-v2-design.md lines 149-150, 385; bible row 276): a warning when the unsent
-- offline sales reach PHP 50,000, and an offline X-slip every 4 hours offline. Both are business values, so they become registry keys shown on
-- Settings > Business rules: pos.offline_unsent_warn_amount (pesos, default 50000, 1000 to 1000000) and pos.offline_xslip_hours (whole hours,
-- default 4, 1 to 24). The tablet reads both from its snapshot; the server never enforces either.
--
-- SHAPE. DATA ONLY, the 0245/0255/0273 pattern: one INSERT ... SELECT over organizations per key (effective 2000-01-01, set_by NULL, reason
-- 'Starting value'). No schema change.
-- LOCK BUDGET: two INSERT ... SELECT, one row per organisation each. RLS is FORCEd on the table (0239); row_security is switched off for the
-- statements and back on after.
-- The values equal the registry defaults; the seed-matches-registry test pins that every seed file together equals EVERY registry default.

SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", 'pos.offline_unsent_warn_amount', 50000::numeric, DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o;
--> statement-breakpoint
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", 'pos.offline_xslip_hours', 4::numeric, DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o;
--> statement-breakpoint
SET LOCAL row_security = on;
