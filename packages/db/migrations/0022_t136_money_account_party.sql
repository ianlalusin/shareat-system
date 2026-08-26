-- 0022 — T-136 / ADR-010: `journal_lines.party_type` gains 'money_account'.
--
-- ⛔ A separate migration from 0021 on purpose. 0021 is applied, and an applied migration is
-- never edited (RULES.md rule 9) — even one that has only reached a local dev database, because
-- the habit is what protects the ones that have reached more than that.
--
-- It is also a genuinely different change. 0021 creates a table; this widens the JOURNAL's
-- contract, which is the most conservative schema in the repo and the one every module depends on.
--
-- ## Why a party at all, and why only for 1140
--
-- ADR-010 gives each money location a GL account and a custodian. Three of the four cash codes
-- are already unambiguous — 1110 IS the cashier drawer, 1120 a staff float, 1130 the office safe —
-- so a line against them needs nothing further to say where the money is.
--
-- `1140` is the exception: ONE control account covers every wallet the business owns, exactly as
-- `2110` covers every supplier. So the wallet rides on the line as its party, reusing the
-- mechanism `2110`→supplier and `1230`→employee have already proven, rather than inventing a
-- second way to say the same kind of thing.
--
-- ⚠️ This migration only WIDENS the allowed set. It does not make any account require a party —
-- `accounts.requires_party` is per-account data, and flipping 1140 is a separate, later step that
-- must land together with the code that supplies the value. Widening first is the expand half of
-- expand/contract (bible §15.5): every existing posting stays legal.

--> statement-breakpoint
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_party_type_check";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_type_check"
	CHECK (
		"journal_lines"."party_type" is null
		or "journal_lines"."party_type" in ('supplier', 'customer', 'employee', 'store', 'channel', 'money_account')
	);
