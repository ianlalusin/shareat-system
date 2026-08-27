-- 0041 — a cashier drawer's overdraft is CAPPED, not unlimited.
--
-- HAND-WRITTEN, like 0020-0040. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ Ian, 2026-08-27: "how deep can a cashier account be negative — it can't be unlimited, so admin
-- can set it. If the set is 20,000 that is the only allowable negative balance a cashier is
-- allowed to."
--
-- Bible row 154 made a cashier shortfall a WARNING rather than a block, because the till's true
-- balance is unknowable until the day is verified — the cash is in the drawer before it is in the
-- ledger. ⚠️ That reasoning is sound and it has no floor: it justified a drawer being ₱2,000 behind
-- and equally a drawer being ₱2,000,000 behind, which is not a bookkeeping lag, it is a missing
-- drawer. The cap is where "legitimately behind" stops.
--
-- ⚠️ Only a CASHIER account uses it. Office and staff balances are complete — nothing is waiting to
-- be posted into them — so a shortfall there is real and still blocks at zero regardless.
--
-- ⚠️ PER ACCOUNT, not per org: a busier store carries a bigger float, and a single number for
-- everywhere would be set to the largest store's need and mean nothing anywhere else.
--
-- The 20,000 default is Ian's own example, and it is a starting value rather than a policy — every
-- account is admin-editable from /money-accounts.

ALTER TABLE "money_accounts" ADD COLUMN "overdraft_limit" numeric(14, 2) DEFAULT '20000.00' NOT NULL;--> statement-breakpoint
-- ⛔ Stored POSITIVE, and zero is meaningful: this drawer may never go below zero at all.
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_overdraft_limit_not_negative_check"
	CHECK ("overdraft_limit" >= 0);
