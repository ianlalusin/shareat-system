-- 0234 -- T-510 S2: the owner BACKFILL for `pair_menu_dayparts`, the eighth super-admin-only capability (docs/tasks/510-menu-dayparts.md R8; Ian 2026-11-05: which offer
-- belongs to which daypart, or all day, is super admin only). No schema change: SUPER_ADMIN_ONLY_CAPABILITIES is materialised as `person_grants` once, at createFirstAdmin
-- (new organisations get the new grant by themselves), so an organisation created before today holds seven and would silently lose "super admin may pair a price with a
-- daypart" the day the capability lands. Same shape and reasoning as the B0196 block in 0196 (add_menu_item), 0188 and 0187: every existing OWNER (an active admin holding all
-- SEVEN current super-admin-only grants) is granted the eighth. An admin who is not an owner is untouched. Idempotent: a person who already holds it live is skipped.
-- Test: packages/db/tests/integration/t510-s2-pair-backfill.test.ts runs the block between the B0234 markers in a transaction that is always rolled back.
-- LOCK BUDGET: one INSERT ... SELECT on person_grants (a handful of owners). RLS is switched off for the statement as 0196 did (a migration reads every organisation) and back on after.
-- B0234:begin
SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source")
SELECT g."person_id", 'pair_menu_dayparts', NULL, 'owner'
  FROM "person_grants" g
 WHERE g."revoked_at" IS NULL
   AND g."grant_name" IN ('approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales', 'unlink_store_from_pos', 'verify_own_sales_day', 'add_menu_item')
   AND EXISTS (SELECT 1 FROM "person_roles" r
                WHERE r."person_id" = g."person_id" AND r."role" = 'admin' AND r."revoked_at" IS NULL)
   AND NOT EXISTS (SELECT 1 FROM "person_grants" u
                    WHERE u."person_id" = g."person_id" AND u."grant_name" = 'pair_menu_dayparts'
                      AND u."revoked_at" IS NULL AND u."store_id" IS NULL)
 GROUP BY g."person_id"
HAVING count(DISTINCT g."grant_name") = 7;
--> statement-breakpoint
SET LOCAL row_security = on;
-- B0234:end
