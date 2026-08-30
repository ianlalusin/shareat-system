-- 0065 — T-163: the receipt posts its value. `2120` wakes up and `5450` is born.
--
-- HAND-WRITTEN, like 0020-0064. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ **What this closes, measured rather than asserted.** ADR-009 counted the share of deliveries
-- carrying a linked expense: 91% (May), 86% (Jun), 89% (Jul), **76% (Aug — the WORST month, not
-- the best)**. If linking were a new habit bedding in, August would be highest. It is lowest, and
-- the shape fits one explanation: *expensing LAGS delivery.* Goods arrive; the expense document is
-- created later, when the invoice is processed.
--
-- ⚠️ And ADR-009's inversion makes it worse exactly where it matters: stock on hand at any date is
-- disproportionately RECENT deliveries (1–2 week turnover), and recent deliveries are
-- disproportionately the UNLINKED ones. **The cost basis is weakest for precisely the stock that
-- needs valuing.**
--
-- ⛔ That is not a discipline problem and cannot be fixed by asking people to be more diligent. It
-- is the direct consequence of treating "receive the goods" and "recognise the cost" as one act
-- performed once, whenever a human gets to it. **Splitting them is the fix**, and it needs exactly
-- two accounts.

-- ---------------------------------------------------------------------------------------------
-- 1. `2120 Goods received not invoiced` — reserved since T-102, funded from today.
--
-- ⭐ It was provisioned and never activated: ADR-009's amendment asked for exactly this account
-- ("a provisional posting with nowhere to put the credit is not a design, it is a gap") and the
-- chart already had it waiting. This is the status flip, not a new account.
--
-- ⚠️ A CLEARING liability, NOT accounts payable. Nobody is owed a stated amount until a supplier
-- says so, and crediting 2110 at receipt would invent a payable with no invoice and no party.
-- ERPNext calls its equivalent `stock_received_but_not_billed`; same idea, one document instead of
-- two.
UPDATE "accounts" SET "status" = 'active', "updated_at" = now()
WHERE "code" = '2120' AND "status" = 'reserved';--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. `5450 Purchase price variance` — new.
--
-- Where the difference lands when the invoice disagrees with what was typed at receipt.
--
-- ⭐ v1 arrived at the right JUDGEMENT here without the machinery to express it. Its own comment:
-- *"The cost variance is no longer a hard reject... bookkeepers must be able to link a
-- centavo-rounded supplier invoice even when it doesn't reconcile to the kg × unitCost figure
-- exactly."* Odoo embodies the same judgement in `price_diff_value` on the valuation layer.
-- **Keep the judgement — never block a real invoice over a rounding gap — and give the difference
-- somewhere honest to go instead of an "unsettled" badge nobody clears.**
INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '5450', 'Purchase price variance', 'expense', 'debit', h.id, true, true, false, 'active'
FROM "accounts" h
WHERE h.code = '5000'
  AND NOT EXISTS (
	SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '5450'
);--> statement-breakpoint
