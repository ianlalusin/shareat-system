-- 0267 - T-608 / DEF-931: an account may OPTIONALLY carry a party of one named type.
--
-- Why: when a platform docks a loan repayment out of a payout, T-608 splits it into principal (2400, party = the loan) and
-- interest (7200). To find a loan's settlement interest the ledger must know WHICH loan a 7200 line belongs to, and the only
-- place that fits is the line's own party. But `journal_lines_check_party_requirement` (0007) refuses a party on any account
-- whose `requires_party` is false, and 7200 is such an account (it is not a control account: most 7200 lines have no loan).
--
-- The rule becomes three-way, and it is DATA on the account, never a hard-coded account code in the trigger (Ian: no hard-coded business settings):
--   requires_party = true            -> a party is required, any allowed type (unchanged)
--   optional_party_type = '<type>'   -> no party, or a party of exactly that type
--   neither                          -> no party (unchanged)
-- A CHECK stops an account being both. Backfill: every org's 7200 gets 'loan' (the seed sets it for new orgs).
-- Existing 7200 lines carry no party, so nothing is re-validated or rewritten.
ALTER TABLE "accounts" ADD COLUMN "optional_party_type" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_party_mode_check" CHECK (NOT ("requires_party" AND "optional_party_type" IS NOT NULL));--> statement-breakpoint
UPDATE "accounts" SET "optional_party_type" = 'loan' WHERE "code" = '7200';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "journal_lines_check_party_requirement"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	acct_code text;
	acct_requires_party boolean;
	acct_optional_party_type text;
	has_party boolean;
BEGIN
	SELECT code, requires_party, optional_party_type INTO acct_code, acct_requires_party, acct_optional_party_type FROM accounts WHERE id = NEW.account_id;

	IF acct_code IS NULL THEN
		RAISE EXCEPTION 'account % does not exist', NEW.account_id;
	END IF;

	has_party := (NEW.party_type IS NOT NULL OR NEW.party_id IS NOT NULL);

	IF acct_requires_party AND NOT has_party THEN
		RAISE EXCEPTION 'account % (%) requires a party on every line, but none was given', acct_code, NEW.account_id;
	END IF;

	IF NOT acct_requires_party AND has_party THEN
		-- T-608: an account that allows an optional party takes exactly that type and no other.
		IF acct_optional_party_type IS NULL THEN
			RAISE EXCEPTION 'account % (%) does not accept a party, but this line has party_type=%, party_id=%', acct_code, NEW.account_id, NEW.party_type, NEW.party_id;
		ELSIF NEW.party_type IS DISTINCT FROM acct_optional_party_type THEN
			RAISE EXCEPTION 'account % (%) accepts only a % party, but this line has party_type=%, party_id=%', acct_code, NEW.account_id, acct_optional_party_type, NEW.party_type, NEW.party_id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
