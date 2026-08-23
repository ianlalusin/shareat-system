-- 0002 — correct 3200 Owner's drawings to contra-equity (debit normal balance).
--
-- Migration 0001 seeded 3200 as equity/credit, following the T-102 spec literally. The
-- spec was wrong: it stated SIX accounts break the derive-normal_balance-from-type rule
-- but enumerated only five (1590 + the four contra-revenue accounts). Owner's drawings is
-- the sixth. Drawings REDUCE equity, so the normal balance is debit.
--
-- 0001 is already applied and is therefore never edited (PROJECT_BIBLE.md §2 rule 8).
-- This corrects it forward.
UPDATE "accounts"
   SET "normal_balance" = 'debit',
       "updated_at"     = now()
 WHERE "code" = '3200'
   AND "normal_balance" <> 'debit';
