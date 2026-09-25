-- 0160 — T-344 / DEF-422: audit columns and ordering guard for a fiscal period created by the
-- admin "fill a missing month inside closed books" action. docs/tasks/344-def-422-fiscal-period-
-- holes.md §3.5. Depends on 0159 (T-341, person_grants store scoping) — unrelated tables, journal
-- order only.
--
-- Hand-authored per ADR-012 §5.
--
-- Two independent additions:
--   1. `created_by`/`fill_reason` on `fiscal_periods`, write-once at INSERT (never edited after),
--      so a period an admin created to fill a hole is told apart from one the ordinary monthly
--      seed job created. DELETE stays allowed and untriggered — the 2027 cutover purge (R1.6) — so
--      this is immutable, not permanent.
--   2. `fiscal_periods_order_guard` — TWO invariants, both R1.2/R1.1, checked in the same function
--      under the same per-org advisory lock: (a) an `open` period may never start before a
--      `closed`/`locked` one, checked from BOTH directions (either row of the pair can be the one
--      that writes second); (b) no calendar year may hold both an `open` period and a `locked` one
--      for the same org — distinct from (a), since a `locked` month earlier in the SAME year as an
--      `open` one satisfies (a) trivially. STATEMENT-level, with a transition table, so a multi-row
--      `UPDATE` (`lockYearPeriods`, `closeYearPeriodsDirectly`) checks the shape once, after
--      everything it touched is already applied, rather than per row in scan order. The monthly
--      seed job's own coverage-hole read and its insert are two separate statements under READ
--      COMMITTED, and `closeYear`'s own `hasEarlierOpenPeriod` gate is a plain SELECT outside any
--      lock — the per-org advisory lock inside this trigger, acquired on every insert or status/date
--      change (not only when it raises), is what actually serialises a write against either race.
--   3. A pre-flight check (below, before either trigger exists) that refuses to apply this
--      migration at all if existing data already violates either invariant in (2) — silently
--      shipping the guard over already-bad data would apply cleanly and then fail every SUBSEQUENT
--      write to that org's fiscal_periods, with the guard unable to tell "this was already broken"
--      from "you just broke it."
--
-- Never edited after apply (RULES §1 rule 9).

-- ---------------------------------------------------------------------------------------------
-- Part 0 — pre-flight: refuse to apply over data that already violates the guard this migration
-- is about to add (review finding). Read-only; runs before either invariant has a trigger, so a
-- violation here means the DATA is already wrong, not that this migration caused it — fix the data
-- first, then re-run. Reports the first offender found, not every one; that is enough to stop the
-- deploy and point at the org.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
	"r" record;
BEGIN
	SELECT "p1"."org_id" AS "org_id", "p1"."starts_on" AS "open_starts_on", "p2"."starts_on" AS "closed_starts_on"
	INTO "r"
	FROM "fiscal_periods" "p1"
	JOIN "fiscal_periods" "p2" ON "p2"."org_id" = "p1"."org_id"
	WHERE "p1"."status" = 'open'
		AND "p2"."status" IN ('closed', 'locked')
		AND "p2"."starts_on" > "p1"."starts_on"
	LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'fiscal_periods: cannot apply 0160 — org % already has an open period starting %, with a closed/locked period starting % after it. Fix this org''s data, then re-run the migration.',
			"r"."org_id", "r"."open_starts_on", "r"."closed_starts_on";
	END IF;

	SELECT "p1"."org_id" AS "org_id", "p1"."starts_on" AS "open_starts_on", EXTRACT(YEAR FROM "p1"."starts_on")::int AS "bad_year"
	INTO "r"
	FROM "fiscal_periods" "p1"
	WHERE "p1"."status" = 'open'
		AND EXISTS (
			SELECT 1 FROM "fiscal_periods" "p2"
			WHERE "p2"."org_id" = "p1"."org_id" AND "p2"."status" = 'locked'
				AND EXTRACT(YEAR FROM "p2"."starts_on") = EXTRACT(YEAR FROM "p1"."starts_on")
		)
	LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'fiscal_periods: cannot apply 0160 — org % already has an open period starting % in year %, which already has a locked period. Fix this org''s data, then re-run the migration.',
			"r"."org_id", "r"."open_starts_on", "r"."bad_year";
	END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Part 1 — audit columns.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "fiscal_periods"
	ADD COLUMN "created_by" uuid REFERENCES "persons"("id") ON DELETE RESTRICT,
	ADD COLUMN "fill_reason" text;--> statement-breakpoint

-- A filled row always carries all four: a non-blank reason, its creator, and the close stamp
-- (closed_by/closed_at) — never `open`. A plain row (the ordinary monthly seed, or any pre-0160
-- period) carries none of them.
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_fill_shape_check" CHECK (
	"fill_reason" IS NULL OR (
		btrim("fill_reason") <> ''
		AND "created_by" IS NOT NULL
		AND "closed_by" IS NOT NULL
		AND "closed_at" IS NOT NULL
		AND "status" <> 'open'
	)
);--> statement-breakpoint

-- Write-once: `fill_reason`/`created_by` are set only at INSERT. Any UPDATE that changes either —
-- NULL to a value, or value to a different value — is refused. DELETE is untouched by this trigger
-- on purpose (R1.6): the 2027 cutover purge must still work, and journal FKs (ON DELETE RESTRICT)
-- already stop deleting a period with postings.
CREATE OR REPLACE FUNCTION "fiscal_periods_fill_immutable"() RETURNS trigger AS $$
BEGIN
	IF NEW."fill_reason" IS DISTINCT FROM OLD."fill_reason" OR NEW."created_by" IS DISTINCT FROM OLD."created_by" THEN
		RAISE EXCEPTION 'fiscal_periods: a filled period''s creator and reason are set only when it is created';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "fiscal_periods_fill_immutable_trg"
	BEFORE UPDATE ON "fiscal_periods"
	FOR EACH ROW EXECUTE FUNCTION "fiscal_periods_fill_immutable"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Part 2 — R1.2: the order guard. Acquires the per-org lock on EVERY insert or status/date change
-- (not only the ones that go on to raise), so a concurrent writer always queues behind it — that is
-- what closes the TOCTOU the seed job's own read-then-write otherwise leaves open under READ
-- COMMITTED (see the corrected comment at scheduler/index.ts's fiscal-period-seed job).
-- ---------------------------------------------------------------------------------------------
-- ⚠️ Checked from BOTH directions (review finding, HIGH): a row turning OPEN and a row turning
-- CLOSED/LOCKED are two separate trigger firings, and only ONE of them may be the row that races
-- past the other. Checking only the open-turning side (as first written) missed the case where the
-- close/lock side commits second: `closePeriod(July)` reads "is June open?" (the application-level
-- `hasEarlierOpenPeriodBefore` check, a plain SELECT the lock never touches) before an in-flight
-- seed-job insert of June lands, sees no violation, and closes July — leaving June open, before it,
-- after July has closed. Both directions raise the SAME message, naming the earliest OPEN period,
-- because that is the one row of the pair the invariant is actually about.
--
-- ⚠️ **STATEMENT-level, with a transition table — not FOR EACH ROW (self-caught, LOW-turned-real
-- during verification).** `lockYearPeriods`/`closeYearPeriodsDirectly` flip several rows of the
-- SAME year `closed -> locked` (or `open -> closed`) in ONE multi-row UPDATE. A FOR EACH ROW BEFORE
-- trigger fires once per row AS Postgres reaches it, in scan order — not necessarily chronological
-- — so a row reached early can find a SIBLING row of the SAME statement still showing its OLD
-- status and raise on a "violation" that is really just "this other row hasn't been processed yet."
-- A statement-level check, run once after every row the statement touches is already applied
-- (visible within this transaction, whether or not the whole thing later commits), has no such
-- ordering dependency: it evaluates the ACTUAL post-statement shape, which is the shape that
-- matters. The advisory lock moves here too, so the whole check-and-lock is one atomic unit; it is
-- still acquired unconditionally, not only on the branch that goes on to raise (this is what closes
-- the TOCTOU — see the corrected comment at scheduler/index.ts's fiscal-period-seed job).
-- ⚠️ A SECOND, DISTINCT invariant lives in this same function (review finding, restored H13b): R1.1
-- forbids an open period inside a YEAR the org has already locked, and that is not the same fact
-- as the ordering check above. A month locked EARLIER in the same year as an open one — Nov 2025
-- locked, Dec 2025 open — satisfies "closed/locked starts before open" trivially (11-01 < 12-01),
-- so the ordering check alone lets it through; it is exactly the shape Q1/R1.1 forbid regardless.
-- `closeYear`'s own `hasEarlierOpenPeriod` gate is a plain SELECT outside this lock, so a concurrent
-- insert of the missing December can land either before or after `closeYear`'s own write without
-- that gate ever seeing it — this trigger is the backstop that re-validates the ACTUAL shape, under
-- the lock, after every write, regardless of which side landed first.
CREATE OR REPLACE FUNCTION "fiscal_periods_order_guard"() RETURNS trigger AS $$
DECLARE
	"r" record;
	"v_max_closed" date;
	"v_min_open" date;
	"v_bad_year" int;
BEGIN
	-- ORDER BY 1 (review finding, LOW) — a statement touching more than one org must always take
	-- these advisory locks in the SAME order every time, or two such statements taking them in
	-- opposite orders could deadlock each other instead of one simply waiting.
	FOR "r" IN SELECT DISTINCT "org_id" FROM "new_rows" ORDER BY 1 LOOP
		PERFORM pg_advisory_xact_lock(hashtextextended('fiscal_periods:' || "r"."org_id"::text, 0));

		SELECT max("starts_on") INTO "v_max_closed" FROM "fiscal_periods"
		WHERE "org_id" = "r"."org_id" AND "status" IN ('closed', 'locked');
		SELECT min("starts_on") INTO "v_min_open" FROM "fiscal_periods"
		WHERE "org_id" = "r"."org_id" AND "status" = 'open';

		IF "v_max_closed" IS NOT NULL AND "v_min_open" IS NOT NULL AND "v_max_closed" > "v_min_open" THEN
			RAISE EXCEPTION 'fiscal_periods: an open period cannot start on % — a closed period starts after it', "v_min_open";
		END IF;

		-- R1.1 — same calendar year, open vs. locked. `starts_on`'s own year is used, the same way
		-- `closeYear`/`lockYearPeriods` identify a year's periods (a period is always inside one
		-- calendar month, so it is always inside exactly one calendar year too).
		SELECT EXTRACT(YEAR FROM "p1"."starts_on")::int INTO "v_bad_year"
		FROM "fiscal_periods" "p1"
		WHERE "p1"."org_id" = "r"."org_id" AND "p1"."status" = 'open'
			AND EXISTS (
				SELECT 1 FROM "fiscal_periods" "p2"
				WHERE "p2"."org_id" = "r"."org_id" AND "p2"."status" = 'locked'
					AND EXTRACT(YEAR FROM "p2"."starts_on") = EXTRACT(YEAR FROM "p1"."starts_on")
			)
		LIMIT 1;
		IF "v_bad_year" IS NOT NULL THEN
			RAISE EXCEPTION 'fiscal_periods: % has an open period in a year that is already locked', "v_bad_year";
		END IF;
	END LOOP;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Two trigger declarations, not one `INSERT OR UPDATE` — Postgres refuses a transition table on a
-- trigger firing for more than one event, so INSERT and UPDATE each get their own, both naming the
-- same "new_rows" and calling the same function. ⚠️ No `OF "status", ...` column list on the UPDATE
-- one either — Postgres refuses that combination with a transition table too. Firing on every
-- update (including one that only touches `fill_reason`/`created_by`) costs an extra pair of cheap
-- aggregates; the check itself is a no-op unless the org actually has both an open and a
-- closed/locked period, so this is not worth a second trigger just to narrow the column list.
CREATE TRIGGER "fiscal_periods_order_guard_ins_trg"
	AFTER INSERT ON "fiscal_periods"
	REFERENCING NEW TABLE AS "new_rows"
	FOR EACH STATEMENT EXECUTE FUNCTION "fiscal_periods_order_guard"();--> statement-breakpoint

CREATE TRIGGER "fiscal_periods_order_guard_upd_trg"
	AFTER UPDATE ON "fiscal_periods"
	REFERENCING NEW TABLE AS "new_rows"
	FOR EACH STATEMENT EXECUTE FUNCTION "fiscal_periods_order_guard"();--> statement-breakpoint
