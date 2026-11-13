-- 0256 - T-576 (POS manager PIN for line actions): the starting row for pos.require_pin_line_actions. docs/tasks/576-pos-manager-pin-setting-line-actions.md as amended 13 Nov 2026; bible row 460; hand-authored per ADR-012 s5.
-- Journal idx 256, `when` = 0255's + 86400000. Merges AFTER T-575 (0255), whose `flag` unit this rule is the first user of.
--
-- WHY. When this switch is on, cancelling a line, giving a line discount (custom, preset or "every line") and removing a line discount need a manager PIN at the till
-- (offline they go ahead and are flagged for a manager). The registry key pos.require_pin_line_actions is a flag: 0 = off, 1 = on, default 0. It is org-wide:
-- business_rule_values has no store_id. Read through readPosRules (requirePinLineActions), so it travels in the POS snapshot.
--
-- SHAPE. DATA ONLY, the 0241/0245/0248/0255 pattern: one INSERT ... SELECT over organizations (effective 2000-01-01, set_by NULL, reason 'Starting value'). No schema change. No ON CONFLICT: the table has no unique key.
--
-- LOCK BUDGET: one INSERT ... SELECT, one row per organisation. RLS is FORCEd on the table (0239) and a migration reads every organisation, so row_security is
-- switched off for the statement and back on after, as 0241, 0245, 0248 and 0255 did.
--
-- The value equals the registry default (OFF: nothing changes on deploy); t576-seed-matches-registry pins that 0239, 0241, 0245, 0248, 0255 and this file together equal EVERY registry default.

SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", 'pos.require_pin_line_actions', 0::numeric, DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o;
--> statement-breakpoint
SET LOCAL row_security = on;
