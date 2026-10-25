-- P0217 - READ ONLY pre-check for migration 0217 (T-475 S3: admins may verify their own supplier invoice).
-- Run as doadmin BEFORE the merge that deploys 0217. Selects only, inside a read-only transaction; changes nothing.
-- None of these blocks the deploy: they tell Ian what changes. P0217b is the one to read: those people GAIN the power
-- to verify a supplier invoice they logged themselves (flagged "verified by its own creator" and audited).

BEGIN READ ONLY;

-- P0217a (informational): invoices where the verifier is the creator today. Historic rows stay legal; they are not flagged.
SELECT 'P0217a historic self-verified invoices' AS check, count(*) AS n
FROM supplier_invoices WHERE verified_by = created_by;

-- P0217b (Ian confirms): the people who gain the capability, per organisation (admin and super_admin by role only).
SELECT 'P0217b gains self-verify' AS check, o.name AS org, p.display_name, r.role
FROM person_roles r
JOIN persons p ON p.id = r.person_id
JOIN organizations o ON o.id = r.org_id
WHERE r.revoked_at IS NULL AND r.role IN ('admin', 'super_admin')
ORDER BY o.name, r.role, p.display_name;

-- P0217c (informational): pending invoices an admin logged, which that admin can now verify.
SELECT 'P0217c pending invoices an admin logged' AS check, count(*) AS n
FROM supplier_invoices i
JOIN person_roles r ON r.person_id = i.created_by AND r.org_id = i.org_id
  AND r.revoked_at IS NULL AND r.role IN ('admin', 'super_admin')
WHERE i.status = 'pending';

ROLLBACK;
