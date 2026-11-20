-- P0270 - READ ONLY pre-check for migration 0270 (T-600 DEF-902: a journal entry's date must fall inside its fiscal period).
-- Run as doadmin BEFORE the deploy that applies 0270. Selects only, inside a read-only transaction; changes nothing.
-- Expect n = 0. Any other number means the migration will refuse to apply; list the rows with P0270b and fix them first.

BEGIN READ ONLY;

SELECT 'P0270a entries dated outside their period' AS check, count(*) AS n
FROM journal_entries je JOIN fiscal_periods fp ON fp.id = je.period_id
WHERE je.entry_date NOT BETWEEN fp.starts_on AND fp.ends_on;

-- P0270b (only if P0270a is not 0): the rows.
SELECT je.id, je.org_id, je.entry_date, fp.starts_on, fp.ends_on, je.source_type, je.source_id
FROM journal_entries je JOIN fiscal_periods fp ON fp.id = je.period_id
WHERE je.entry_date NOT BETWEEN fp.starts_on AND fp.ends_on
ORDER BY je.entry_date LIMIT 50;

ROLLBACK;
