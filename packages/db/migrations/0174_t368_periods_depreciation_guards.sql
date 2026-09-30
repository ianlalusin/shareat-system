-- 0174 — T-368 S0 (DEF-424, DEF-426, DEF-435, DEF-436 backstops), docs/tasks/368-periods-depreciation.md
-- §S0. T-367 landed first and took 0173 (Ian, 2026-09-30: T-366 = 0172, T-368 next = 0174,
-- T-372 after). No new table, so there is no classification.ts or rls/registry.ts entry.
--
-- Four independent guards:
--   1. DEF-426 — an OPEN period is always one whole calendar month. Pre-flight, then a CHECK.
--   2. DEF-424 — no close or lock may leave a missing month behind it. A statement-level trigger
--      on fiscal_periods, the same per-org advisory-lock shape as 0160's order guard.
--   3. DEF-435 — a reversed catch-up can be linked again. The two UNIQUE indexes on
--      missed_month_adjustments become plain indexes (findLink still reads by them), and the
--      guard function gains a check refusing a second link only while the FIRST one's entry is
--      still posted.
--   4. DEF-436 — a posted month's terms never change. A row-level trigger on fixed_assets, gated
--      on the four immutable columns actually changing, and excluding a fully reversed original
--      (bible §13 row 214's "reason" for the reversal_of_entry_id filter is in the trigger's own
--      comment below). Stays 'origin'/'validator', never 'always' (Ian, ruling on the 0174 audit):
--      under session_replication_role=replica (the cutover ETL) this guard is silent by design; a
--      posted asset's terms are not otherwise protected on that path.
--
-- HAND-WRITTEN, per ADR-012 §5 — `drizzle-kit generate` is retired.

-- ---------------------------------------------------------------------------------------------
-- Part 1 — DEF-426: an OPEN period is a whole calendar month.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
	"r" record;
BEGIN
	SELECT "org_id", "starts_on", "ends_on"
	INTO "r"
	FROM "fiscal_periods"
	WHERE "status" = 'open'
		AND ("starts_on" <> date_trunc('month', "starts_on")::date
			OR "ends_on" <> (date_trunc('month', "starts_on") + interval '1 month - 1 day')::date)
	LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'fiscal_periods: cannot apply 0174 — org % has an open period % to % that is not a whole calendar month. Fix this org''s data, then re-run the migration.',
			"r"."org_id", "r"."starts_on", "r"."ends_on";
	END IF;
END $$;--> statement-breakpoint

ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_open_whole_month_check" CHECK (
	"status" <> 'open' OR (
		"starts_on" = date_trunc('month', "starts_on")::date
		AND "ends_on" = (date_trunc('month', "starts_on") + interval '1 month - 1 day')::date
	)
);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Part 2 — DEF-424: no close or lock over a missing month. STATEMENT-level with a transition
-- table, the same reason as 0160's order guard: `lockYearPeriods`/`closeYearPeriodsDirectly` flip
-- several rows of one year in ONE multi-row UPDATE, and a FOR EACH ROW trigger would see sibling
-- rows of the SAME statement in scan order, not chronological order. Fires on every UPDATE (no
-- `OF` column list, matching 0160): the check is a no-op unless a row's status actually moved INTO
-- closed/locked. INSERT is deliberately not guarded — T-344's fill inserts closed pieces, and
-- filling holes in any order is harmless.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "fiscal_periods_gap_guard"() RETURNS trigger AS $$
DECLARE
	"r" record;
	"v_gap_start" date;
BEGIN
	FOR "r" IN
		SELECT DISTINCT "n"."org_id", "n"."starts_on"
		FROM "new_rows" "n"
		JOIN "old_rows" "o" ON "o"."id" = "n"."id"
		WHERE "n"."status" IN ('closed', 'locked') AND "o"."status" IS DISTINCT FROM "n"."status"
		ORDER BY 1, 2
	LOOP
		PERFORM pg_advisory_xact_lock(hashtextextended('fiscal_periods:' || "r"."org_id"::text, 0));

		-- Every period of this org starting before the row being closed/locked, plus a sentinel
		-- boundary row AT the row's own starts_on — so a gap between the LAST existing period and
		-- the row itself is caught too, not only gaps between two existing rows.
		WITH "bounded" AS (
			SELECT "starts_on", "ends_on" FROM "fiscal_periods"
			WHERE "org_id" = "r"."org_id" AND "starts_on" < "r"."starts_on"
			UNION ALL
			SELECT "r"."starts_on", "r"."starts_on"
		),
		"gapped" AS (
			SELECT "starts_on", lag("ends_on") OVER (ORDER BY "starts_on") AS "prev_ends_on"
			FROM "bounded"
		)
		SELECT min("prev_ends_on" + 1) INTO "v_gap_start"
		FROM "gapped"
		WHERE "prev_ends_on" IS NOT NULL AND "starts_on" > "prev_ends_on" + 1;

		IF "v_gap_start" IS NOT NULL THEN
			RAISE EXCEPTION 'fiscal_periods: % cannot close or lock — % has no fiscal period. Periods close in order.',
				"r"."starts_on", "v_gap_start";
		END IF;
	END LOOP;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "fiscal_periods_gap_guard_trg"
	AFTER UPDATE ON "fiscal_periods"
	REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
	FOR EACH STATEMENT EXECUTE FUNCTION "fiscal_periods_gap_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Part 3 — DEF-435: a reversed catch-up can be linked again. The two UNIQUE indexes become plain
-- (non-unique) indexes — `findLink` still reads by them — and the guard function gains a check
-- refusing a second link only while the FIRST link's entry is still posted. A plain SELECT, never
-- FOR UPDATE/FOR SHARE: 0170 revoked shareat_app's UPDATE on this history table, and the trigger
-- runs as shareat_app, so a locking read would raise 42501. The race between two re-books is
-- serialised by the journal's own (org_id, idempotency_key) unique index — both would compute the
-- same #N.
-- ---------------------------------------------------------------------------------------------
DROP INDEX "missed_month_adjustments_org_asset_period_unique";--> statement-breakpoint
CREATE INDEX "missed_month_adjustments_org_asset_period_idx"
	ON "missed_month_adjustments" ("org_id", "fixed_asset_id", "belongs_to_period");--> statement-breakpoint
DROP INDEX "missed_month_adjustments_org_prepaid_period_unique";--> statement-breakpoint
CREATE INDEX "missed_month_adjustments_org_prepaid_period_idx"
	ON "missed_month_adjustments" ("org_id", "prepaid_item_id", "belongs_to_period");--> statement-breakpoint

-- Checks 1-6 are byte-identical to migration 0161 (check 6 was Amendment R3.1, landed after this
-- task's census was written against an earlier HEAD — this new check is therefore check 7, not
-- check 6 as the task spec's own text says).
CREATE OR REPLACE FUNCTION "missed_month_adjustments_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	entry record;
	subject_id uuid;
	line_count int;
	month_starts_on date;
	month_ends_on date;
	open_overlap boolean;
	earliest_period_start date;
BEGIN
	subject_id := coalesce(NEW."fixed_asset_id", NEW."prepaid_item_id");

	SELECT "id", "org_id", "status", "source_type", "source_id", "entry_date", "idempotency_key"
	INTO entry
	FROM "journal_entries"
	WHERE "id" = NEW."journal_entry_id";

	IF entry IS NULL THEN
		RAISE EXCEPTION 'missed_month_adjustments: journal entry % does not exist', NEW."journal_entry_id";
	END IF;

	-- Check 1 -- the linked entry has the same org, is posted, and names this exact subject.
	IF entry."org_id" <> NEW."org_id" OR entry."status" <> 'posted' OR entry."source_type" <> NEW."schedule"
		OR entry."source_id" <> subject_id::text THEN
		RAISE EXCEPTION 'missed_month_adjustments: journal entry % is not a posted % entry for this subject',
			NEW."journal_entry_id", NEW."schedule";
	END IF;

	-- Check 2 -- the idempotency key is exactly the schedule key for (subject, belongs_to_period),
	-- optionally followed by "#N" (a re-post after a reversal, prepaidRepo.nextRevisionKey's shape).
	-- The name and the key cannot disagree.
	IF NEW."schedule" = 'depreciation' THEN
		IF entry."idempotency_key" !~ ('^asset:' || subject_id::text || ':depreciation:' || NEW."belongs_to_period" || '(#[0-9]+)?$') THEN
			RAISE EXCEPTION 'missed_month_adjustments: the entry''s key does not name asset % for %',
				subject_id, NEW."belongs_to_period";
		END IF;
	ELSE
		IF entry."idempotency_key" !~ ('^prepaid:' || subject_id::text || ':amortisation:' || NEW."belongs_to_period" || '(#[0-9]+)?$') THEN
			RAISE EXCEPTION 'missed_month_adjustments: the entry''s key does not name prepaid item % for %',
				subject_id, NEW."belongs_to_period";
		END IF;
	END IF;

	-- Check 3 -- booked in a month LATER than belongs_to_period. An entry dated at or before P is
	-- not a catch-up of P at all.
	IF to_char(entry."entry_date", 'YYYY-MM') <= NEW."belongs_to_period" THEN
		RAISE EXCEPTION 'missed_month_adjustments: the entry is dated % -- not after %',
			entry."entry_date", NEW."belongs_to_period";
	END IF;

	-- Check 4 -- no OPEN fiscal_periods row of this org overlaps belongs_to_period's calendar
	-- month. An open month is posted by the run itself, never adjusted.
	month_starts_on := to_date(NEW."belongs_to_period" || '-01', 'YYYY-MM-DD');
	month_ends_on := (month_starts_on + interval '1 month - 1 day')::date;
	SELECT EXISTS (
		SELECT 1 FROM "fiscal_periods"
		WHERE "org_id" = NEW."org_id" AND "status" = 'open'
			AND "starts_on" <= month_ends_on AND "ends_on" >= month_starts_on
	) INTO open_overlap;
	IF open_overlap THEN
		RAISE EXCEPTION 'missed_month_adjustments: % is still open -- the monthly run books it in its own month',
			NEW."belongs_to_period";
	END IF;

	-- Check 5 -- exactly two lines, on the pattern's own accounts (POSTING-PATTERNS.md
	-- depreciation.monthly / amortization.monthly): DR 6700 / CR 1590, or DR 6750 / CR 1400.
	SELECT count(*) INTO line_count FROM "journal_lines" WHERE "entry_id" = NEW."journal_entry_id";
	IF line_count <> 2 THEN
		RAISE EXCEPTION 'missed_month_adjustments: the entry has % line(s), expected exactly 2', line_count;
	END IF;

	IF NEW."schedule" = 'depreciation' THEN
		IF NOT EXISTS (
			SELECT 1 FROM "journal_lines" jl JOIN "accounts" a ON a."id" = jl."account_id"
			WHERE jl."entry_id" = NEW."journal_entry_id" AND a."code" = '6700' AND jl."debit" > 0
		) OR NOT EXISTS (
			SELECT 1 FROM "journal_lines" jl JOIN "accounts" a ON a."id" = jl."account_id"
			WHERE jl."entry_id" = NEW."journal_entry_id" AND a."code" = '1590' AND jl."credit" > 0
		) THEN
			RAISE EXCEPTION 'missed_month_adjustments: the entry''s lines are not DR 6700 / CR 1590';
		END IF;
	ELSE
		IF NOT EXISTS (
			SELECT 1 FROM "journal_lines" jl JOIN "accounts" a ON a."id" = jl."account_id"
			WHERE jl."entry_id" = NEW."journal_entry_id" AND a."code" = '6750' AND jl."debit" > 0
		) OR NOT EXISTS (
			SELECT 1 FROM "journal_lines" jl JOIN "accounts" a ON a."id" = jl."account_id"
			WHERE jl."entry_id" = NEW."journal_entry_id" AND a."code" = '1400' AND jl."credit" > 0
		) THEN
			RAISE EXCEPTION 'missed_month_adjustments: the entry''s lines are not DR 6750 / CR 1400';
		END IF;
	END IF;

	-- Check 6 (Amendment R3.1) -- belongs_to_period must not precede the org's earliest fiscal
	-- period. Earlier months precede the books; their depreciation or amortisation belongs in the
	-- opening balance, and booking them here would double-count 1590/1400. An org with no fiscal
	-- periods at all has no valid floor, so it refuses unconditionally.
	SELECT min("starts_on") INTO earliest_period_start FROM "fiscal_periods" WHERE "org_id" = NEW."org_id";
	IF earliest_period_start IS NULL OR NEW."belongs_to_period" < to_char(earliest_period_start, 'YYYY-MM') THEN
		RAISE EXCEPTION 'missed_month_adjustments: % is before the books began', NEW."belongs_to_period";
	END IF;

	-- Check 7 (T-368 S0 / DEF-435) -- now that the unique index is gone, a second link for the
	-- same subject and month is legal ONLY once the first link's entry has been reversed. This is
	-- the one remaining guard against a DOUBLE catch-up for a month whose original still stands.
	IF NEW."schedule" = 'depreciation' THEN
		IF EXISTS (
			SELECT 1 FROM "missed_month_adjustments" mma
			JOIN "journal_entries" je ON je."id" = mma."journal_entry_id"
			WHERE mma."org_id" = NEW."org_id" AND mma."fixed_asset_id" = NEW."fixed_asset_id"
				AND mma."belongs_to_period" = NEW."belongs_to_period" AND je."status" = 'posted'
		) THEN
			RAISE EXCEPTION 'missed_month_adjustments: asset % already has a posted link for % -- reverse it before booking another',
				NEW."fixed_asset_id", NEW."belongs_to_period";
		END IF;
	ELSE
		IF EXISTS (
			SELECT 1 FROM "missed_month_adjustments" mma
			JOIN "journal_entries" je ON je."id" = mma."journal_entry_id"
			WHERE mma."org_id" = NEW."org_id" AND mma."prepaid_item_id" = NEW."prepaid_item_id"
				AND mma."belongs_to_period" = NEW."belongs_to_period" AND je."status" = 'posted'
		) THEN
			RAISE EXCEPTION 'missed_month_adjustments: prepaid item % already has a posted link for % -- reverse it before booking another',
				NEW."prepaid_item_id", NEW."belongs_to_period";
		END IF;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Part 4 — DEF-436: a posted month's terms never change. Fires only when one of the four
-- immutable columns actually changes (the WHEN clause), and only refuses when a POSTED,
-- NON-REVERSAL depreciation entry exists for this asset. The reversal filter is load-bearing:
-- `reverseEntry` copies source_type/source_id onto the reversal entry, and the reversal is itself
-- posted, so without the filter a fully reversed asset would lock forever. An original whose
-- reversal exists reads 'reversed', not 'posted', and is excluded by the status test alone; the
-- filter guards the case where BOTH the original and its reversal are, for one moment, 'posted'
-- inside `reverseEntry`'s own transaction.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "fixed_assets_terms_freeze"() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "journal_entries"
		WHERE "source_type" = 'depreciation' AND "source_id" = NEW."id"::text
			AND "status" = 'posted' AND "reversal_of_entry_id" IS NULL
	) THEN
		RAISE EXCEPTION 'fixed_assets: % already has depreciation posted; its useful life, interval, salvage value and cost can no longer change',
			NEW."id";
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "fixed_assets_terms_freeze_trg"
	BEFORE UPDATE ON "fixed_assets"
	FOR EACH ROW
	WHEN ((OLD."useful_life_months", OLD."interval", OLD."salvage_value", OLD."cost")
		IS DISTINCT FROM (NEW."useful_life_months", NEW."interval", NEW."salvage_value", NEW."cost"))
	EXECUTE FUNCTION "fixed_assets_terms_freeze"();
