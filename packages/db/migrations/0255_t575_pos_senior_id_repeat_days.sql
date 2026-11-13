-- 0255 - T-575 (POS repeat senior/PWD card warning): the starting row for pos.senior_id_repeat_days. docs/tasks/575-pos-repeat-senior-id-warning.md as amended 13 Nov 2026; bible row 462; hand-authored per ADR-012 s5.
-- Journal idx 255, `when` = 0252's + 3 x 86400000 (idx 253 and 254 are reserved by other lanes; the grid is one day per index).
--
-- WHY. When a senior or PWD card number was already used at the same store within N business days, the till warns the cashier and the server leaves a trail for a manager (never a block).
-- N is the registry key pos.senior_id_repeat_days (whole days, default 1 = the same business day, 1 to 30), read through readSeniorIdRepeatDays. It is org-wide: business_rule_values has no store_id.
--
-- SHAPE. DATA ONLY, the 0241/0245/0248 pattern: one INSERT ... SELECT over organizations (effective 2000-01-01, set_by NULL, reason 'Starting value'). No schema change. No ON CONFLICT: the table has no unique key.
--
-- LOCK BUDGET: one INSERT ... SELECT, one row per organisation. RLS is FORCEd on the table (0239) and a migration reads every organisation, so row_security is
-- switched off for the statement and back on after, as 0241, 0245 and 0248 did.
--
-- The value equals the registry default; t575-seed-matches-registry pins that 0239, 0241, 0245, 0248 and this file together equal EVERY registry default.

SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", 'pos.senior_id_repeat_days', 1::numeric, DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o;
--> statement-breakpoint
SET LOCAL row_security = on;
