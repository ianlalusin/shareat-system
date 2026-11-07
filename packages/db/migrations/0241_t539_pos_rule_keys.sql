-- 0241 - T-539 (POS business rule keys): the starting rows for the two new POS rules. docs/tasks/539-pos-business-rule-keys.md R3; hand-authored per ADR-012 s5.
-- Journal idx 241. 0240 (T-524, POS v2 domain) is not on main at the time of writing; the rebase order is 0239, 0240, 0241.
--
-- WHY. Ian's standing rule (5 Nov): no business value is hard-coded. The senior/PWD discount percent (20) and the hour a POS business day starts (4) are
-- now registry keys (packages/domain/src/business-rules/registry.ts) shown on Settings > Business rules, and the POS reads them through readPosRules.
-- tax.vat_percent already has its 0239 row; it is only relabelled in code.
--
-- SHAPE. DATA ONLY: one INSERT ... SELECT over organizations, the 0239 seed pattern (effective 2000-01-01, set_by NULL, reason 'Starting value'). No schema
-- change, no trigger, no audit action, no RLS policy, no cutover class: business_rule_values already has all of them.
-- No ON CONFLICT: the table has no unique key (a same-day correction is a newer row) and a migration runs once.
--
-- LOCK BUDGET: one INSERT ... SELECT, two rows per organisation. RLS is FORCEd on the table (0239) and a migration reads every organisation, so row_security is
-- switched off for the statement and back on after, as 0234 did.
--
-- The values equal the registry defaults; t539-seed-matches-registry pins that 0239's rows and these together equal EVERY registry default.

SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", r."key", r."value", DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o
CROSS JOIN (VALUES
	('pos.senior_pwd_discount_percent', 20::numeric),
	('pos.business_day_start_hour', 4::numeric)
) AS r("key", "value");
--> statement-breakpoint
SET LOCAL row_security = on;
