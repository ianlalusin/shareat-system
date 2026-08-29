-- 0061 — T-153: the till float. A side pocket, not a balance.
--
-- HAND-WRITTEN, like 0020-0060. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ WHY. Ian, 2026-08-29: *"the money is from office/admin, it's not part of the sales that is
-- not remitted. This is extra cash float that sits on till forever. The staff just makes sure if
-- the configured budget is 20k, every day opening and closing it is 20k. It is separated from the
-- money being remitted. It's on a side pocket of the cashier."*
--
-- Today that money is agreed verbally and recorded nowhere, so cash is understated at every store
-- that holds a float and overstated at the office by the same amount. The company total is right
-- and the split — the two accounts a cash count is checked against — is wrong.
--
-- ⛔ AN EARLIER DESIGN MODELLED THIS AS A RESIDUE of the takings account ("the part of the drawer
-- that is not remitted") and concluded it needed no schema at all. The arithmetic was right and
-- the model was wrong: *"not remitted"* is what HAPPENS to the float, not what it IS. A side
-- pocket is a separate pot with its own invariant. T-153 §2 keeps the error and its cause.

-- ---------------------------------------------------------------------------------------------
-- 1. `1115` — the side pocket's own account.
--
-- ⭐ Its own account rather than a corner of `1110`, because a cash account answers "where is the
-- money" and this money is somewhere else: a different pocket, counted separately, on a different
-- rule. Three things follow that a shared account cannot give:
--
--   1. Its balance is an INVARIANT — always the configured target — so a discrepancy is found by
--      comparing two figures, not by reading history. The control is arithmetic, not diligence.
--   2. `1110` stays purely takings, so remittance cannot sweep the float even by accident.
--   3. "How much of our cash is tied up in tills" becomes one balance.
--
-- ⚠️ NOT `requires_party`. One float pot per till, named by its money account like any other cash
-- account — the party dimension exists for accounts where one GL row covers many holders (1120
-- staff floats, 1140 wallets), and this is not one of those.
INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '1115', 'Cash on hand — till float', 'asset', 'debit', h.id, true, true, false, 'active'
FROM "accounts" h
WHERE h.code = '1000'
  AND NOT EXISTS (
	SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '1115'
);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. The configured amount, on the money account that holds it.
--
-- ⭐ NON-NULL MARKS THE ACCOUNT AS A FLOAT POT. Every other money account leaves it null, so the
-- column doubles as the flag and there is no second thing to keep in step with it.
--
-- ⚠️ It lives on the money account rather than on `stores` because the POT is the thing with a
-- target — a store with two tills would have two. That is the opposite of T-152's un-remitted
-- ceiling, which is a store-wide risk limit and correctly sits on `stores`.
--
-- ⛔ A TARGET IS NOT A DUPLICATE, and an earlier draft refused this column on the grounds that it
-- would be a second source of truth. That misapplied bible rows 143/145/147: those forbid storing
-- a COPY of a figure the ledger computes, because the copy drifts and the two then disagree about
-- the same pesos. A target is not a copy — it is the other operand, and `balance <> target` is not
-- drift to be prevented, it IS the finding. T-152's ceiling is exactly the same shape.
ALTER TABLE "money_accounts"
  ADD COLUMN "float_target" numeric(14, 2);--> statement-breakpoint

-- A float pot of zero would mean "this till holds a float of nothing", which is what NULL already
-- says, and far more likely to be an unfilled form than an intention.
ALTER TABLE "money_accounts"
  ADD CONSTRAINT "money_accounts_float_target_positive_check"
  CHECK ("float_target" IS NULL OR "float_target" > 0);--> statement-breakpoint

-- ⭐ A float pot is CASH, held by the CASHIER, rolling into 1115. Any other shape is a mistake
-- that would put a target on a wallet or an office safe and make the off-target detector nonsense.
ALTER TABLE "money_accounts"
  ADD CONSTRAINT "money_accounts_float_target_shape_check"
  CHECK (
    "float_target" IS NULL
    OR ("instrument" = 'cash' AND "custodian" = 'cashier' AND "gl_account_code" = '1115')
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. ⭐ ONE float pot per store, enforced.
--
-- ⚠️ This is not tidiness — it is what makes the pot's BALANCE knowable. `balanceOf` scopes a
-- non-`1140` money account by (gl_account_code, store_id) rather than by party, because those
-- accounts are not `requires_party`. With two pots in one store their balances would be
-- indistinguishable and the off-target detector would compare a shared figure against two targets.
--
-- Ian, 2026-08-29: *"1 store 1 till."* So the model and the business agree, and the database now
-- says so rather than relying on them continuing to.
CREATE UNIQUE INDEX "money_accounts_one_float_per_store"
  ON "money_accounts" ("store_id")
  WHERE "float_target" IS NOT NULL;
