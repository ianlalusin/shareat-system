-- P0271 - READ ONLY pre-check for migration 0271 (T-598 S10: clock_terminals revoke reason must be non-blank; shareat_app loses DELETE on trade_orders).
-- Run as doadmin BEFORE the merge that deploys 0271. Selects only, inside a read-only transaction; changes nothing.
-- Expected: P0271a n = 0. Anything above 0 REFUSES the migration (it never rewrites a reason): fix each row's revoke_reason first.

BEGIN READ ONLY;
SET LOCAL row_security = off;

-- P0271a: revoked clock terminals with a blank revoke reason (the exact count the migration's own pre-check makes).
SELECT 'P0271a blank revoke reason' AS check, count(*) AS n
FROM clock_terminals WHERE revoked_at IS NOT NULL AND btrim(revoke_reason) = '';

-- P0271a rows (store code / terminal label), empty when n = 0.
SELECT s.code AS store, t.label, t.id, t.revoked_at
FROM clock_terminals t JOIN stores s ON s.org_id = t.org_id AND s.id = t.store_id
WHERE t.revoked_at IS NOT NULL AND btrim(t.revoke_reason) = ''
ORDER BY s.code, t.label;

ROLLBACK;
