-- 0245 - T-539 S3 (POS business rule keys): the starting row for pos.table_warn_minutes. docs/tasks/539-pos-business-rule-keys.md Slice S3; hand-authored per ADR-012 s5.
-- Journal idx 245. 0242-0244 belong to the settlement lane.
--
-- WHY. Ian's standing rule (5 Nov): no business value is hard-coded. T-527 shipped the "table seated too long" warning as a constant (90 minutes); it is now the
-- registry key pos.table_warn_minutes (packages/domain/src/business-rules/registry.ts), shown on Settings > Business rules and read through readPosRules into the
-- T-525 snapshot. Must land before the Lipa go-live.
--
-- SHAPE. DATA ONLY, the 0241 pattern: one INSERT ... SELECT over organizations (effective 2000-01-01, set_by NULL, reason 'Starting value'). No schema change,
-- no trigger, no audit action, no RLS policy, no cutover class: business_rule_values already has all of them. No ON CONFLICT: the table has no unique key.
--
-- LOCK BUDGET: one INSERT ... SELECT, one row per organisation. RLS is FORCEd on the table (0239) and a migration reads every organisation, so row_security is
-- switched off for the statement and back on after, as 0241 did.
--
-- The value equals the registry default; t539-seed-matches-registry pins that 0239, 0241 and this file together equal EVERY registry default.

SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "business_rule_values" ("org_id", "key", "value", "effective_from", "set_by", "reason")
SELECT o."id", 'pos.table_warn_minutes', 90::numeric, DATE '2000-01-01', NULL, 'Starting value'
FROM "organizations" o;
--> statement-breakpoint
SET LOCAL row_security = on;
