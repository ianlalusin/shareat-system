-- 0208 - T-439 (bible row 362): the built-in position "Cook" is renamed "Kitchen Staff".
-- A rename in place: same id, so employment_positions and position_capability_defaults (keyed by id) are untouched.
-- Only the org-wide canonical row; a store's own "Cook" is its invention and stays. Skipped for an org that somehow already holds a
-- canonical "Kitchen Staff" (the unique name index would refuse a second one) - that org's "Cook" is left for a person to merge.
UPDATE "positions" p
SET "name" = 'Kitchen Staff', "updated_at" = now()
WHERE p."is_canonical" AND p."name" = 'Cook'
  AND NOT EXISTS (
    SELECT 1 FROM "positions" k
    WHERE k."org_id" = p."org_id" AND k."is_canonical" AND lower(btrim(k."name")) = 'kitchen staff'
  );
