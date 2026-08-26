-- 0025 — ADR-010 / bible row 148: an expense payment names WHICH money account it moved.
--
-- The other half of 0024. That migration made `1140` require a party; this gives the expense
-- payment row somewhere to put one, so an online payment can say which wallet the money left.
--
-- ## Why a real FK here, when the journal's `party_id` is deliberately not one
--
-- `journal_lines.party_id` carries no FK on purpose (DEF-040) — it is a narrow, high-volume table
-- that must accept a supplier, a customer, an employee or a wallet in one column, and Phase 2's
-- party tables did not all exist when it was written. **A source DOCUMENT has no such excuse.**
-- `expense_payments` already references `persons` for the reimbursable party, so referencing
-- `money_accounts` here is the same discipline: catch a bad reference at entry, not at audit.
--
-- ⚠️ `restrict`, not `cascade`. A wallet that has funded a payment can never be deleted, only
-- retired — deleting it would leave a payment row pointing at nothing, which is the DEF-065 class
-- of problem this repo keeps finding in v1.
--
-- ## Nullable, and that is not a loophole
--
-- Only an ONLINE payment needs one; a cash payment's destination is already unambiguous from its
-- sub-route (1110 cashier / 1120 staff float / 1130 office). The rule "online implies a wallet"
-- is enforced in `routeExpense`, where it can name the payment row and the reason, rather than as
-- a CHECK that could only say a constraint failed. ⛔ The database still refuses the POSTING —
-- 1140 requires a party — so a missing wallet cannot reach the ledger by any route.

--> statement-breakpoint
ALTER TABLE "expense_payments" ADD COLUMN "money_account_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_money_account_id_money_accounts_id_fk"
	FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_payments_money_account_id_idx" ON "expense_payments" ("money_account_id");
