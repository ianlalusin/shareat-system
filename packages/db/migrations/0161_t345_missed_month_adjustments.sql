-- 0161 — T-345 / T-344 Q5: an adjustment naming a missed month counts as that month's depreciation
-- or amortisation. docs/tasks/345-missed-month-depreciation-adjustment.md §3.1.
--
-- `missed_month_adjustments` links a catch-up journal entry (dated in an open month, memo prefixed
-- "[prior period]") to the missed month P it counts as booked for. It is the target-period record
-- bible row 103 asks for, scoped to scheduled charges. The amount is NOT enforced here — the
-- schedule is pure TypeScript (schedule.ts / prepaidSchedule) by design; that is the one stated gap
-- in "the database enforces the rules" for this feature.
--
-- Hand-authored per ADR-012 §5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE TABLE "missed_month_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"schedule" text NOT NULL,
	"fixed_asset_id" uuid,
	"prepaid_item_id" uuid,
	"belongs_to_period" text NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"booked_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missed_month_adjustments_journal_entry_id_unique" UNIQUE("journal_entry_id"),
	CONSTRAINT "missed_month_adjustments_schedule_check"
		CHECK ("schedule" IN ('depreciation', 'amortisation')),
	-- Exactly one subject column is set, matching `schedule`.
	CONSTRAINT "missed_month_adjustments_subject_shape_check"
		CHECK (("schedule" = 'depreciation') = ("fixed_asset_id" IS NOT NULL)
			AND ("schedule" = 'amortisation') = ("prepaid_item_id" IS NOT NULL)),
	CONSTRAINT "missed_month_adjustments_belongs_to_period_check"
		CHECK ("belongs_to_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "missed_month_adjustments_reason_not_blank_check"
		CHECK (btrim("reason") <> '')
);--> statement-breakpoint

ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_fixed_asset_id_fixed_assets_id_fk"
	FOREIGN KEY ("fixed_asset_id") REFERENCES "fixed_assets"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_prepaid_item_id_prepaid_items_id_fk"
	FOREIGN KEY ("prepaid_item_id") REFERENCES "prepaid_items"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- ON DELETE CASCADE -- period_overrides' own lineage off journal_entries: the property that makes
-- "a link with no entry" structurally unrepresentable. This table is ALSO classified 'purge' for
-- the 2027 cutover, but that purge TRUNCATEs (no row-level DELETE, so this FK never fires for it --
-- see the DELETE trigger's own comment below for what this CASCADE actually serves).
ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_journal_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ADD CONSTRAINT "missed_month_adjustments_booked_by_persons_id_fk"
	FOREIGN KEY ("booked_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- One per subject per month. NULLs are distinct in a unique index, so each index covers only its
-- own kind -- an asset row and a prepaid row can share a belongs_to_period freely.
CREATE UNIQUE INDEX "missed_month_adjustments_org_asset_period_unique"
	ON "missed_month_adjustments" ("org_id", "fixed_asset_id", "belongs_to_period");--> statement-breakpoint
CREATE UNIQUE INDEX "missed_month_adjustments_org_prepaid_period_unique"
	ON "missed_month_adjustments" ("org_id", "prepaid_item_id", "belongs_to_period");--> statement-breakpoint

-- ===========================================================================================
-- missed_month_adjustments_guard -- BEFORE INSERT. Six checks (spec §3.1, check 6 added by
-- Amendment R3.1), each raising SQLSTATE P0001 with a message prefixed "missed_month_adjustments: "
-- (bible §13 rules pin this convention project-wide, and the tester's own D1 asserts it literally).
-- ===========================================================================================
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

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "missed_month_adjustments_guard_trg"
	BEFORE INSERT ON "missed_month_adjustments"
	FOR EACH ROW EXECUTE FUNCTION "missed_month_adjustments_guard"();--> statement-breakpoint

-- ===========================================================================================
-- Immutability. Rows are write-once: no UPDATE, ever.
--
-- ⚠️ Audit correction (2026-09-26): the DELETE escape below is NOT for the 2027 cutover purge.
-- A POSTED journal entry can never be deleted at all -- journal_entries_check_posted_immutable
-- (migration 0005) refuses it unconditionally, before this table's own trigger ever runs -- and
-- the cutover purge itself TRUNCATEs journal_entries (repo/cutover.ts only ever DELETEs a 'draft'
-- entry), which fires no row-level trigger on either table. What this escape actually serves is
-- the ONE row-level delete this journal entry CAN legitimately undergo: a REVERSED catch-up entry
-- being deleted (status='reversed' is not blocked by the 0005 trigger) cascades here via the FK
-- above, and that cascade must not be refused as a "direct" DELETE. pg_trigger_depth() is 1 for a
-- genuinely direct top-level DELETE on this table and > 1 when this row is being removed as part
-- of that FK CASCADE, so that is the distinction the DELETE trigger checks.
-- ===========================================================================================
CREATE OR REPLACE FUNCTION "missed_month_adjustments_no_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'missed_month_adjustments: rows are immutable';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "missed_month_adjustments_no_update_trg"
	BEFORE UPDATE ON "missed_month_adjustments"
	FOR EACH ROW EXECUTE FUNCTION "missed_month_adjustments_no_update"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "missed_month_adjustments_no_direct_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF pg_trigger_depth() > 1 THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'missed_month_adjustments: rows are immutable';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "missed_month_adjustments_no_direct_delete_trg"
	BEFORE DELETE ON "missed_month_adjustments"
	FOR EACH ROW EXECUTE FUNCTION "missed_month_adjustments_no_direct_delete"();--> statement-breakpoint

-- RLS -- ENABLE and FORCE as the table is created (bible row 112), app_current_org() never a raw
-- current_setting(...)::uuid (DEF-077), WITH CHECK as well as USING (DEF-183).
ALTER TABLE "missed_month_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "missed_month_adjustments_org_isolation" ON "missed_month_adjustments"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
