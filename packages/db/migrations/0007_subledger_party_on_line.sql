-- 0007 — T-118 (docs/tasks/118-subledger-party-on-line.md): give a journal line a
-- counterparty, so the AP/AR subledgers exist and invariant 6 ("subsidiary ledgers
-- reconcile to control accounts") becomes satisfiable. Closes DEF-037.
--
-- COA-ALIGNMENT specifies "2110 AP — CONTROL + supplier subledger" and the same shape for
-- AR (1210), channel receivable (1220), advances (1230/1240), reimbursements (2130),
-- due-from/due-to (1250/2150) and loans payable (2400) — nine accounts total. Before this
-- migration, a line posting to any of them could not say WHO it was for. Research
-- (docs/discovery/17 §4) found both ERPNext and Odoo put the counterparty ON THE LINE
-- (`party_type`/`party` on ERPNext's GL Entry; `C_BPartner_ID` on iDempiere's Fact_Acct)
-- rather than in a second table — the subledger becomes `GROUP BY party_id` over
-- journal_lines, true by construction, not a parallel structure that can drift out of
-- step with the ledger it's supposed to summarize. Ian decided on this shape; bible §13
-- row 98.
--
-- Drizzle generated everything above this comment from schema/accounts.ts and
-- schema/journal.ts: the `requires_party` column, the two new nullable columns, the
-- (party_type, party_id) index, and both IMMEDIATE per-row CHECKs (both-or-neither;
-- party_type is one of the five allowed values). Hand-added below this point, because
-- neither is expressible as a plain CHECK — same reason journal_lines_check_account_eligible
-- (migration 0003) is a trigger and not a CHECK: it has to look at `accounts`:
--
--   journal_lines_check_party_requirement — BEFORE INSERT OR UPDATE on journal_lines.
--   Rejects in BOTH directions:
--     - the line's account has requires_party = true and the line has no party -> reject,
--       naming the account's CODE (not just its uuid) so the error is actually readable.
--     - the line's account has requires_party = false and the line HAS a party -> reject.
--       A party on a cash or expense line is a data-modelling mistake, and silently
--       allowing it would make the subledger untrustworthy from the other side — nobody
--       would notice for months, per the task spec's own "things that will bite" #1.
--   "Has a party" is tested as party_type IS NOT NULL OR party_id IS NOT NULL (not simply
--   "= exactly one"), so a half-set party (which the both-or-neither CHECK above will
--   reject anyway, once the row reaches constraint validation) still trips the correct
--   branch here rather than silently passing through this trigger first.
--
-- ⚠️ DELIBERATE, RECORDED EXCEPTION to bible §4.2 rule 3 ("foreign keys are always
-- declared"): party_id carries NO foreign key. suppliers/customers/channels are Phase 2
-- tables that do not exist yet, so party_id cannot reference them. This task's Contract §4
-- says explicitly: report this for the planner to record as a temporary divergence, and do
-- NOT invent a generic `parties` table to route around it — stores and persons already
-- exist, and duplicating them into a party table would create exactly the second source of
-- truth this project exists to remove. Phase 2 tightens this: either a real per-type FK or
-- a validating trigger, once the party tables exist.
--
-- NO BACKFILL. There are zero rows in accounts or journal_lines in any real environment
-- today — the chart of accounts seeds per-org (migrations 0001/0006, or
-- seedChartOfAccounts() directly) and no organization exists yet. `requires_party` is
-- NOT NULL DEFAULT false, so the ALTER TABLE itself needs no data migration either way.
-- Which NINE codes get requires_party = true going forward is entirely the seed's job
-- (packages/db/seed/chart-of-accounts.ts) — this migration only adds the column and the
-- rule that enforces it; the corrected seed is what actually sets the flag for future orgs.
--
-- 0000-0006 are already applied and are therefore never edited (bible §2 rule 8).
ALTER TABLE "accounts" ADD COLUMN "requires_party" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "party_type" text;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "party_id" text;--> statement-breakpoint
CREATE INDEX "journal_lines_party_type_party_id_idx" ON "journal_lines" USING btree ("party_type","party_id");--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_both_or_neither_check" CHECK (("journal_lines"."party_type" is null) = ("journal_lines"."party_id" is null));--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_type_check" CHECK ("journal_lines"."party_type" is null or "journal_lines"."party_type" in ('supplier', 'customer', 'employee', 'store', 'channel'));
--> statement-breakpoint

-- ===========================================================================================
-- The cross-table rule: does THIS line's account require, or forbid, a party. Immediate
-- (ordinary, non-deferred) BEFORE trigger — a per-write gate, same shape as
-- journal_lines_check_account_eligible (migration 0003).
-- ===========================================================================================
CREATE FUNCTION "journal_lines_check_party_requirement"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	acct_code text;
	acct_requires_party boolean;
	has_party boolean;
BEGIN
	SELECT code, requires_party INTO acct_code, acct_requires_party FROM accounts WHERE id = NEW.account_id;

	IF acct_code IS NULL THEN
		RAISE EXCEPTION 'account % does not exist', NEW.account_id;
	END IF;

	has_party := (NEW.party_type IS NOT NULL OR NEW.party_id IS NOT NULL);

	IF acct_requires_party AND NOT has_party THEN
		RAISE EXCEPTION 'account % (%) requires a party on every line, but none was given', acct_code, NEW.account_id;
	END IF;

	IF NOT acct_requires_party AND has_party THEN
		RAISE EXCEPTION 'account % (%) does not accept a party, but this line has party_type=%, party_id=%', acct_code, NEW.account_id, NEW.party_type, NEW.party_id;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_lines_party_requirement"
	BEFORE INSERT OR UPDATE ON "journal_lines"
	FOR EACH ROW EXECUTE FUNCTION "journal_lines_check_party_requirement"();
