-- 0055 — T-133 corrected: a branch transfer moves COST, because there is no inventory to move.
--
-- HAND-WRITTEN, like 0020-0054. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⛔ WHAT WAS WRONG, found by Ian's question on 2026-08-28: *"if raw materials are from Lipa say
-- meat slab then Lipa processed it incurring processing cost like 10 per kg and it moves to
-- Malvar, how will the books of 2 stores look? How can Malvar expense it?"*
--
-- 0054 implemented `POSTING-PATTERNS.md` §commissary_dispatch.transfer faithfully — one entry,
-- four legs, `1330` inventory out of the seller and into the buyer. ⭐ **That pattern assumes
-- PERPETUAL inventory, and this system is PERIODIC.** Verified, not assumed: every expense
-- category maps to a 5xxx COGS account (`seed/expense-categories.ts` — Meat → 5110), there is no
-- capitalisation path anywhere, and before 0054 **nothing in the entire codebase debited 1310,
-- 1330 or 1340**. A purchase is expensed the day it is bought.
--
-- So the four-leg inventory transfer drove the seller's `1330` NEGATIVE — an asset account that
-- nothing had ever funded — while the cost of the goods stayed stranded in the seller's P&L.
-- Answering Ian's question directly: Malvar could NOT expense it, and Lipa carried 100% of a cost
-- for goods it no longer had.
--
-- ⭐ THE FIX IS THE ONE THE CHART ALREADY DESCRIBED. `5170 COGS — commissary transfers` carries
-- this comment, written at T-102b: *"CONSOLIDATED it must ELIMINATE against the commissary's
-- transfer-out."* That transfer-out account was never created. This is it.
--
--     Lipa (seller)    DR 1250 Due from related store   /  CR 5175 Cost transferred to branches
--     Malvar (buyer)   DR 5170 COGS — commissary transfers /  CR 2150 Due to related store
--
-- Worked with Ian's own numbers — 100 kg slab at ₱300, processed at ₱10/kg, all of it shipped:
--
--     Lipa    5110 Meat            30,000   (bought)
--             6xxx processing       1,000   (labour, already expensed)
--             5175 transferred out (31,000)
--             ---------------------------------
--             net cost at Lipa           0   ✅ it kept nothing
--     Malvar  5170 commissary       31,000  ✅ it expenses what it received
--     Group   5170 + 5175 = 0, so only the original 31,000 remains, counted ONCE
--
-- ⚠️ The transfer PRICE is what carries the processing cost — ₱310/kg, not ₱300. Ian sets it per
-- order today; Phase 3 computes it from real cost. That is the whole mechanism by which Lipa's
-- ₱10/kg of work reaches Malvar's books.
--
-- ⛔ 1330/1340 are NOT wrong — they are EARLY. When Phase 3 brings perpetual inventory, the
-- transfer moves inventory again and 5175 retires into the capitalisation credit. Recorded in
-- POSTING-PATTERNS.md so the next reader sees both shapes and which era each belongs to.

INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '5175', 'Cost transferred to branches', 'expense', 'credit', h.id, true, true, false, 'active'
FROM "accounts" h
WHERE h.code = '5000'
  AND NOT EXISTS (
	SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '5175'
);
