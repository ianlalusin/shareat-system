-- 0035 — T-144: 1120 becomes party-requiring. Bible row 159.
--
-- ⭐ v1 does not do this, and POSTING-PATTERNS.md records why it looked unnecessary there: "1120 is
-- NOT a requires_party account — it is a plain asset, not a control account with a subledger."
--
-- ⛔ But one store has ONE staff-float account (T-142) and TWO PEOPLE CAN HOLD FLOATS AT ONCE, and
-- one person can hold two. With no party, P2,000 with Ana and P3,000 with Ben is P5,000 at 1120 and
-- the ledger cannot say whose is whose — so "who still owes a liquidation?" would have to come from
-- a second register, which is how v1's loans ended up with three.
--
-- Third time this reasoning applies: the wallet (row 142), the loan (row 158), now the float.
--
-- ⚠️ The chart is per-org and already seeded, so existing rows are updated too. There is nothing to
-- backfill on the LINES: v2 has posted nothing to 1120 yet — this task is what starts.

--> statement-breakpoint
UPDATE "accounts" SET "requires_party" = true WHERE "code" = '1120';
