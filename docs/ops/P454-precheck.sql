-- P454 - READ ONLY pre-check for T-454 (Banay-Banay closes 31 Dec 2026 and is never loaded into v2). Ian runs it as doadmin.
-- Selects only; changes nothing. EXPECTED RESULT: the first query returns NO ROW.
-- If a row appears: deactivate it on /admin/stores/<id> (deactivateStoreAction). Any pilot rows on it are purged by the
-- 1 Jan purge like every other pilot row (T-394). Delete nothing by hand.

-- 1. Is there a Banay-Banay store in v2?
SELECT s.id, s.org_id, s.code, s.name, s.is_active
FROM stores s
WHERE s.name ILIKE '%banay%' OR s.code = 'BNBN';

-- 2. Rows pointing at it (only matters if query 1 returned a row; all counts are 0 when it returned none).
SELECT 'journal_lines' AS tbl, count(*) AS rows_pointing FROM journal_lines t JOIN stores s ON s.id = t.store_id WHERE s.name ILIKE '%banay%' OR s.code = 'BNBN'
UNION ALL
SELECT 'stock_movements', count(*) FROM stock_movements t JOIN stores s ON s.id = t.store_id WHERE s.name ILIKE '%banay%' OR s.code = 'BNBN'
UNION ALL
SELECT 'sales_days', count(*) FROM sales_days t JOIN stores s ON s.id = t.store_id WHERE s.name ILIKE '%banay%' OR s.code = 'BNBN'
UNION ALL
SELECT 'employments', count(*) FROM employments t JOIN stores s ON s.id = t.store_id WHERE s.name ILIKE '%banay%' OR s.code = 'BNBN'
UNION ALL
SELECT 'pos_v1_store_links', count(*) FROM pos_v1_store_links t JOIN stores s ON s.id = t.store_id WHERE s.name ILIKE '%banay%' OR s.code = 'BNBN'
UNION ALL
SELECT 'clock_terminals', count(*) FROM clock_terminals t JOIN stores s ON s.id = t.store_id WHERE s.name ILIKE '%banay%' OR s.code = 'BNBN';
