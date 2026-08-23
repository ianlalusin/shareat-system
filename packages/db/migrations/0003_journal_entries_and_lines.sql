-- Hand-augmented per docs/tasks/103-journal-tables.md Method step 3 and Contract §4-§7.
-- Drizzle generated the table DDL, the immediate per-row CHECKs, the FKs, and the plain
-- and partial indexes above (nothing hand-added there). Everything below this point is
-- hand-added, because none of it is expressible through drizzle-kit generate:
--
--   1. Balance (Sum(debit)=Sum(credit)) and minimum-two-lines-per-entry. PostgreSQL
--      forbids DEFERRABLE CHECK constraints ("ERROR: CHECK constraints cannot be marked
--      DEFERRABLE") — only FK / UNIQUE / PK / EXCLUDE / CONSTRAINT TRIGGER may be
--      deferred, and this rule is inherently multi-row (only correct as of COMMIT, not
--      after any single line write). Implemented as a CONSTRAINT TRIGGER ... DEFERRABLE
--      INITIALLY DEFERRED on BOTH tables — journal_entries (AFTER INSERT) as well as
--      journal_lines (AFTER INSERT OR UPDATE OR DELETE). The journal_entries copy closes
--      a gap a lines-only trigger would miss: an entry inserted with literally zero
--      lines, ever, would never cause any journal_lines event to fire, so nothing would
--      ever check it — see the task report ("bonus" tests in journal.test.ts).
--   2. Account eligibility — is_postable=true and status='active' on the account a line
--      targets. Cross-table (looks up `accounts`), so it cannot be a plain CHECK.
--      BEFORE INSERT OR UPDATE trigger on journal_lines.
--   3. Period-open — "no posting into a closed period, by any path" (bible invariant 7).
--      Cross-table (looks up `fiscal_periods`), on BOTH tables, because Contract §6 says
--      "insert or update of an entry OR LINE": a line added to an already-existing draft
--      entry after its period closed must be rejected too, not only the entry's own
--      initial insert. See the task report for the scoping decision on UPDATE (period-id
--      changes and the draft->posted transition are checked; the posted->reversed
--      transition deliberately is not, per Contract §7 — that conflict is the spec
--      ambiguity flagged in the report).
--   4. Posted immutability — once status='posted', an entry's financial data (and its
--      lines, in full) cannot change. BEFORE UPDATE OR DELETE on journal_lines and on
--      journal_entries, matching the Contract's literal "trigger blocking UPDATE/DELETE"
--      scope exactly (NOT insert — an earlier draft of this migration also blocked INSERT
--      on journal_lines to close what looked like a gap, but that breaks constructing an
--      already-posted entry's lines within the SAME transaction that inserts it as
--      status='posted' in the first place — the trigger cannot tell "still being built"
--      from "already committed and now being appended to" from inside plpgsql without
--      resorting to xmin/txid tricks the spec does not ask for. Reverted; the residual gap
--      — a raw-SQL client could INSERT a new balanced pair of lines into an
--      already-committed posted entry in a later transaction, changing its financial
--      content without tripping the balance rule — is flagged in the task report as a
--      known limitation for T-105's postEntry/reverseEntry service layer to close via
--      authorization, not a table constraint). journal_entries: every column frozen
--      except the explicit posted -> reversed status transition Contract §7 requires to
--      remain legal, plus updated_at bookkeeping.
--
-- Once applied, this file is never edited (bible §2 rule 8) — a further change is a new
-- migration.
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"period_id" uuid NOT NULL,
	"memo" text,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"idempotency_key" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"reversal_of_entry_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "journal_entries_status_check" CHECK ("journal_entries"."status" in ('draft', 'posted', 'reversed'))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"store_id" uuid,
	"channel_id" text,
	"debit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"line_memo" text,
	CONSTRAINT "journal_lines_amounts_nonnegative_check" CHECK ("journal_lines"."debit" >= 0 AND "journal_lines"."credit" >= 0),
	CONSTRAINT "journal_lines_exactly_one_side_check" CHECK (("journal_lines"."debit" = 0) <> ("journal_lines"."credit" = 0))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_persons_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_org_id_idempotency_key_unique" ON "journal_entries" USING btree ("org_id","idempotency_key") WHERE "journal_entries"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "journal_entries_org_id_entry_date_idx" ON "journal_entries" USING btree ("org_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_source_type_source_id_idx" ON "journal_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_entries_period_id_idx" ON "journal_entries" USING btree ("period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_id_line_no_unique" ON "journal_lines" USING btree ("entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_id_idx" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_store_id_idx" ON "journal_lines" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "journal_lines_channel_id_idx" ON "journal_lines" USING btree ("channel_id");
--> statement-breakpoint

-- ===========================================================================================
-- 1. Balance and minimum-two-lines — DEFERRABLE INITIALLY DEFERRED constraint triggers.
--    Shared logic in one helper function; a thin trigger function per table calls it with
--    the affected entry's id. If the entry itself no longer exists (fully deleted, e.g. a
--    draft entry's CASCADE-deleted lines), there is nothing left to check — that is what
--    makes deleting a draft entry legal (invariant 16).
-- ===========================================================================================
CREATE FUNCTION "journal_check_entry_balance"("p_entry_id" uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	v_line_count integer;
	v_debit_sum numeric(14,2);
	v_credit_sum numeric(14,2);
BEGIN
	IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = p_entry_id) THEN
		RETURN;
	END IF;

	SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
	  INTO v_line_count, v_debit_sum, v_credit_sum
	FROM journal_lines WHERE entry_id = p_entry_id;

	IF v_line_count < 2 THEN
		RAISE EXCEPTION 'journal entry % must have at least two lines (has %)', p_entry_id, v_line_count;
	END IF;

	IF v_debit_sum <> v_credit_sum THEN
		RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', p_entry_id, v_debit_sum, v_credit_sum;
	END IF;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION "journal_entries_trigger_check_balance"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM journal_check_entry_balance(NEW.id);
	RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "journal_entries_balance_check"
	AFTER INSERT ON "journal_entries"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "journal_entries_trigger_check_balance"();
--> statement-breakpoint

CREATE FUNCTION "journal_lines_trigger_check_balance"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_entry_id uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN
		v_entry_id := OLD.entry_id;
	ELSE
		v_entry_id := NEW.entry_id;
	END IF;
	PERFORM journal_check_entry_balance(v_entry_id);
	RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "journal_lines_balance_check"
	AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "journal_lines_trigger_check_balance"();
--> statement-breakpoint

-- ===========================================================================================
-- 2. Account eligibility — a line may only target an account that is postable and active.
--    Immediate (ordinary, non-deferred) BEFORE trigger: this is a per-write gate, not a
--    multi-row rule, so it must reject the bad row itself, synchronously.
-- ===========================================================================================
CREATE FUNCTION "journal_lines_check_account_eligible"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	acct_postable boolean;
	acct_status text;
BEGIN
	SELECT is_postable, status INTO acct_postable, acct_status FROM accounts WHERE id = NEW.account_id;

	IF acct_postable IS NULL THEN
		RAISE EXCEPTION 'account % does not exist', NEW.account_id;
	END IF;

	IF NOT acct_postable THEN
		RAISE EXCEPTION 'account % is not postable (it is a header account)', NEW.account_id;
	END IF;

	IF acct_status <> 'active' THEN
		RAISE EXCEPTION 'account % cannot be posted to (status = %)', NEW.account_id, acct_status;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_lines_account_eligible"
	BEFORE INSERT OR UPDATE ON "journal_lines"
	FOR EACH ROW EXECUTE FUNCTION "journal_lines_check_account_eligible"();
--> statement-breakpoint

-- ===========================================================================================
-- 3. Period-open — "no posting into a closed period, by any path" (bible §16.1 invariant 7).
--    journal_entries: checked on every INSERT, and on UPDATE only when this update is
--    itself a new act of posting — the period_id is changing, or the entry is transitioning
--    draft -> posted. A posted -> reversed transition is NOT a new posting and must remain
--    legal even after the period has since closed (Contract §7); reversals of entries in
--    already-closed periods are the primary real-world use of a reversal, so a blanket
--    "any update to an entry in a closed period is rejected" reading would make Contract
--    §7's own promise impossible — see the task report.
--    journal_lines: checked on every INSERT and UPDATE, against the CURRENT status of the
--    line's own entry's period, regardless of what the period's status was when the entry
--    itself was first created.
-- ===========================================================================================
CREATE FUNCTION "journal_entries_check_period_open"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	period_status text;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.period_id IS NOT DISTINCT FROM OLD.period_id
		   AND NOT (OLD.status = 'draft' AND NEW.status = 'posted') THEN
			RETURN NEW;
		END IF;
	END IF;

	SELECT status INTO period_status FROM fiscal_periods WHERE id = NEW.period_id;

	IF period_status IS NULL THEN
		RAISE EXCEPTION 'fiscal period % does not exist', NEW.period_id;
	END IF;

	IF period_status <> 'open' THEN
		RAISE EXCEPTION 'cannot post journal entry into period % (status = %)', NEW.period_id, period_status;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_entries_period_open"
	BEFORE INSERT OR UPDATE ON "journal_entries"
	FOR EACH ROW EXECUTE FUNCTION "journal_entries_check_period_open"();
--> statement-breakpoint

CREATE FUNCTION "journal_lines_check_period_open"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	period_status text;
BEGIN
	SELECT p.status INTO period_status
	FROM journal_entries e JOIN fiscal_periods p ON p.id = e.period_id
	WHERE e.id = NEW.entry_id;

	IF period_status IS NULL THEN
		RAISE EXCEPTION 'journal entry % does not exist or has no period', NEW.entry_id;
	END IF;

	IF period_status <> 'open' THEN
		RAISE EXCEPTION 'cannot post journal line into period with status %', period_status;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_lines_period_open"
	BEFORE INSERT OR UPDATE ON "journal_lines"
	FOR EACH ROW EXECUTE FUNCTION "journal_lines_check_period_open"();
--> statement-breakpoint

-- ===========================================================================================
-- 4. Posted immutability — bible §16.1 invariant 5. Once status='posted':
--      journal_entries: every column is frozen except the explicit posted -> reversed
--      status transition, and updated_at bookkeeping. This freezes memo/entry_date/etc
--      too, not only "financial" columns narrowly read — the broader, safer reading of
--      bible invariant 5 ("posted entries are immutable"), flagged in the task report as
--      a resolution of a Contract-vs-bible wording gap.
--      journal_lines: once the parent entry is posted, its lines cannot be inserted,
--      updated, or deleted at all — there is no lesser status a line can be in.
-- ===========================================================================================
CREATE FUNCTION "journal_entries_check_posted_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.status = 'posted' THEN
			RAISE EXCEPTION 'posted journal entry % cannot be deleted', OLD.id;
		END IF;
		RETURN OLD;
	END IF;

	-- TG_OP = 'UPDATE'
	IF OLD.status = 'posted' THEN
		IF NEW.status NOT IN ('posted', 'reversed') THEN
			RAISE EXCEPTION 'posted journal entry % may only remain posted or transition to reversed', OLD.id;
		END IF;

		IF (to_jsonb(NEW) - 'updated_at' - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'status') THEN
			RAISE EXCEPTION 'posted journal entry % is immutable except for the reversed status transition', OLD.id;
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_entries_posted_immutable"
	BEFORE UPDATE OR DELETE ON "journal_entries"
	FOR EACH ROW EXECUTE FUNCTION "journal_entries_check_posted_immutable"();
--> statement-breakpoint

CREATE FUNCTION "journal_lines_check_posted_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_entry_id uuid;
	entry_status text;
BEGIN
	IF TG_OP = 'DELETE' THEN
		v_entry_id := OLD.entry_id;
	ELSE
		v_entry_id := NEW.entry_id;
	END IF;

	SELECT status INTO entry_status FROM journal_entries WHERE id = v_entry_id;

	IF entry_status = 'posted' THEN
		RAISE EXCEPTION 'journal entry % is posted; its lines are immutable', v_entry_id;
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "journal_lines_posted_immutable"
	BEFORE UPDATE OR DELETE ON "journal_lines"
	FOR EACH ROW EXECUTE FUNCTION "journal_lines_check_posted_immutable"();