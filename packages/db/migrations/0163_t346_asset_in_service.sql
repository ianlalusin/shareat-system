-- 0163 — T-346 S2 (DEF-427): an asset depreciates from the day it is IN SERVICE, not from
-- acquisition, when its store has not opened yet. docs/tasks/346-store-opening-and-in-service-date.md
-- §3.3, Amendment R1 items 1/2/5/8 and R4 items 1/2/3 (all folded into §3.3's body; this migration
-- follows the folded text).
--
-- CIP as a STATE, not an account (PAS 16): no 1520 "Construction in progress", no reclass entry.
-- `in_service_on`/`in_service_source` are new columns on `fixed_assets`; a NULL `in_service_on` on
-- a non-shell row means HELD — on the books at cost in 1510, depreciating nothing, until its store
-- opens. Two triggers keep this derived and guarded (RULES §6.3 — the database enforces the rules):
--   `fixed_assets_in_service_a_fill`   -- BEFORE INSERT, and BEFORE UPDATE OF the columns it reads,
--                                         derives in_service_source/in_service_on (§3.3 step 4).
--   `fixed_assets_in_service_b_guard`  -- BEFORE UPDATE (no column list, WHEN in_service_on
--                                         changes), refuses a move that would leave a POSTED
--                                         depreciation month illegal (§3.3 step 5). Named to sort
--                                         after the fill ("_a_" < "_b_"): Postgres fires same-timing
--                                         triggers in NAME order, so the fill's own recompute is
--                                         what the guard checks, on the SAME statement.
-- `stores_opening_date_propagate` (on `stores`) re-touches every `store_opening` follower so the
-- fill/guard pair above re-runs for it whenever the store's own opening date changes.
--
-- Hand-authored per ADR-012 §5 -- `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "fixed_assets"
	ADD COLUMN "in_service_on" date,
	ADD COLUMN "in_service_source" text;--> statement-breakpoint

-- Backfill -- shells stay NULL/NULL; every other existing asset is 'acquired', in_service_on =
-- acquired_on. ZERO existing schedules change (schedule.ts's ScheduleInput.startsOn now reads
-- in_service_on, and this backfill sets it to exactly what acquired_on already was). Spans every
-- org, so it must not run RLS-filtered -- see 0162's own header for why (SET LOCAL row_security).
SET LOCAL row_security = off;--> statement-breakpoint
UPDATE "fixed_assets" SET "in_service_source" = 'acquired', "in_service_on" = "acquired_on"
	WHERE "status" <> 'pending_valuation';--> statement-breakpoint
SET LOCAL row_security = on;--> statement-breakpoint

ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_in_service_source_check"
	CHECK ("in_service_source" IS NULL OR "in_service_source" IN ('acquired', 'store_opening', 'set'));--> statement-breakpoint

ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_in_service_shape_check" CHECK (
	("status" = 'pending_valuation' AND "in_service_source" IS NULL AND "in_service_on" IS NULL)
	OR (
		"status" <> 'pending_valuation' AND "in_service_source" IS NOT NULL
		AND ("in_service_source" <> 'acquired' OR "in_service_on" = "acquired_on")
		AND ("in_service_source" <> 'set' OR "in_service_on" IS NOT NULL)
	)
);--> statement-breakpoint

ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_in_service_on_after_acquired_check"
	CHECK ("in_service_on" IS NULL OR "in_service_on" >= "acquired_on");--> statement-breakpoint

-- ===========================================================================================
-- fixed_assets_in_service_a_fill -- derives in_service_source/in_service_on (§3.3 step 4).
--
-- Effective source: whatever NEW.in_service_source already carries (an explicit INSERT value, or
-- OLD's value surviving into an UPDATE that did not touch it); when that is NULL, infer it --
-- 'set' if a value was supplied with no source named (R1.8), else 'store_opening' when the store
-- has no opening date or opens AFTER this asset's acquisition, else 'acquired'.
--
-- 'acquired' always re-derives in_service_on := acquired_on (so correcting acquired_on on an
-- 'acquired' asset just re-derives it, R4.2) -- UNLESS the very statement that changed something
-- also supplies a DIFFERENT in_service_on itself, which raises rather than silently overwriting it
-- (R1.8/R4.2). On INSERT that is "a non-NULL value <> acquired_on"; on UPDATE it is "in_service_on
-- was itself changed by this statement, to a value <> the new acquired_on" -- OLD is only ever
-- read in the UPDATE branch, since it does not exist on INSERT.
--
-- 'store_opening' always re-reads the CURRENT store's opening_date and recomputes: NULL while the
-- store has none, else greatest(opening_date, acquired_on) -- never Postgres's bare greatest(),
-- which ignores NULL arguments and would treat "no opening date" as "already open" and silently
-- defeat the whole HELD concept.
--
-- 'set' is never touched -- the supplied value stands, validated by the CHECK constraints above.
-- ===========================================================================================
CREATE OR REPLACE FUNCTION "fixed_assets_in_service_a_fill"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_source text;
	v_store_opening date;
BEGIN
	IF NEW."status" = 'pending_valuation' THEN
		NEW."in_service_source" := NULL;
		NEW."in_service_on" := NULL;
		RETURN NEW;
	END IF;

	v_source := NEW."in_service_source";

	IF v_source IS NULL THEN
		IF NEW."in_service_on" IS NOT NULL THEN
			v_source := 'set';
		ELSE
			SELECT "opening_date" INTO v_store_opening FROM "stores" WHERE "id" = NEW."store_id";
			IF v_store_opening IS NULL OR v_store_opening > NEW."acquired_on" THEN
				v_source := 'store_opening';
			ELSE
				v_source := 'acquired';
			END IF;
		END IF;
	END IF;

	IF v_source = 'acquired' THEN
		IF TG_OP = 'INSERT' THEN
			IF NEW."in_service_on" IS NOT NULL AND NEW."in_service_on" <> NEW."acquired_on" THEN
				RAISE EXCEPTION 'fixed_assets: an in-service date on the acquisition date must equal it';
			END IF;
		ELSE
			IF NEW."in_service_on" IS NOT NULL AND NEW."in_service_on" <> NEW."acquired_on"
				AND NEW."in_service_on" IS DISTINCT FROM OLD."in_service_on" THEN
				RAISE EXCEPTION 'fixed_assets: an in-service date on the acquisition date must equal it';
			END IF;
		END IF;
		NEW."in_service_source" := 'acquired';
		NEW."in_service_on" := NEW."acquired_on";
	ELSIF v_source = 'store_opening' THEN
		SELECT "opening_date" INTO v_store_opening FROM "stores" WHERE "id" = NEW."store_id";
		NEW."in_service_source" := 'store_opening';
		IF v_store_opening IS NULL THEN
			NEW."in_service_on" := NULL;
		ELSE
			NEW."in_service_on" := greatest(v_store_opening, NEW."acquired_on");
		END IF;
	ELSE
		NEW."in_service_source" := 'set';
		-- in_service_on stays exactly as supplied.
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- Two triggers, not one combined event list -- OLD is referenced (in the UPDATE branch above) and
-- Postgres refuses OLD in a trigger that also fires on INSERT if the two are declared as one
-- "INSERT OR UPDATE" trigger sharing a transition context; separate triggers calling the same
-- function, branching on TG_OP, is this codebase's own established shape (migration 0160).
--
-- ⛔ Amendment R4.4 -- "status" stays in the UPDATE column list below even though the fill
-- function's own pending_valuation branch is the only place status is READ. The propagation
-- trigger below (stores_opening_date_propagate) deliberately SKIPS non-active rows, so a
-- disposed-then-reactivated 'store_opening' follower would otherwise sit frozen on a stale
-- in_service_on forever -- firing THIS trigger on any status change (a hypothetical reactivation
-- path included) is what re-derives it. Do not remove "status" from this column list.
CREATE TRIGGER "fixed_assets_in_service_a_fill_ins_trg"
	BEFORE INSERT ON "fixed_assets"
	FOR EACH ROW EXECUTE FUNCTION "fixed_assets_in_service_a_fill"();--> statement-breakpoint

CREATE TRIGGER "fixed_assets_in_service_a_fill_upd_trg"
	BEFORE UPDATE OF "acquired_on", "store_id", "in_service_source", "status" ON "fixed_assets"
	FOR EACH ROW EXECUTE FUNCTION "fixed_assets_in_service_a_fill"();--> statement-breakpoint

-- ===========================================================================================
-- fixed_assets_in_service_b_guard -- BEFORE UPDATE, no column list, fires whenever in_service_on's
-- value actually changes (WHEN clause) -- including a change made by the fill trigger itself
-- above (a store_id move, or a store's own opening_date propagating), not only a direct write.
-- Named to sort after "_a_fill" (Postgres fires same-timing FOR EACH ROW triggers by name), so it
-- always sees the fill's own recomputed value.
--
-- The month comes from the KEY (asset:{id}:depreciation:{YYYY-MM}), never entry_date (R1.2): a
-- T-345 catch-up is dated on the booking day, and a quarterly/semiannual/annual entry is dated at
-- its PERIOD'S END (shared/straight-line.ts), so entry_date names the wrong month for both. A key
-- month is illegal when: NEW.in_service_on is NULL (nothing posted can ever be legitimate for a
-- HELD asset); or the period it belongs to STARTED before in_service_on's month (monthly: the key
-- month itself; interval > 1: key month minus (step-1) months); or the key month is AFTER the new
-- schedule's final period (in-service month + ceil(life/step)*step - 1 months, R1.5 -- moving
-- in-service EARLIER can shorten the schedule and strand a late posted month past its new end).
-- ===========================================================================================
CREATE OR REPLACE FUNCTION "fixed_assets_in_service_b_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	r record;
	v_step int;
	v_in_service_idx int;
	v_last_idx int;
	v_key_month text;
	v_key_idx int;
	v_period_start_idx int;
BEGIN
	v_step := CASE NEW."interval"
		WHEN 'monthly' THEN 1
		WHEN 'quarterly' THEN 3
		WHEN 'semiannual' THEN 6
		WHEN 'annually' THEN 12
		ELSE 1
	END;

	IF NEW."in_service_on" IS NOT NULL THEN
		v_in_service_idx := extract(year FROM NEW."in_service_on")::int * 12 + extract(month FROM NEW."in_service_on")::int - 1;
		v_last_idx := v_in_service_idx + (ceil(NEW."useful_life_months"::numeric / v_step)::int * v_step) - 1;
	END IF;

	FOR r IN
		SELECT je."idempotency_key" AS key
		FROM "journal_entries" je
		WHERE je."org_id" = NEW."org_id" AND je."source_type" = 'depreciation'
			AND je."source_id" = NEW."id"::text AND je."status" = 'posted'
	LOOP
		v_key_month := substring(r.key from ':depreciation:(\d{4}-\d{2})');
		IF v_key_month IS NULL THEN
			CONTINUE;
		END IF;
		v_key_idx := substring(v_key_month from 1 for 4)::int * 12 + substring(v_key_month from 6 for 2)::int - 1;
		v_period_start_idx := v_key_idx - (v_step - 1);

		IF v_in_service_idx IS NULL OR v_period_start_idx < v_in_service_idx OR v_key_idx > v_last_idx THEN
			RAISE EXCEPTION 'fixed_assets: % already has depreciation posted for %; reverse it before moving its in-service date',
				NEW."name", v_key_month;
		END IF;
	END LOOP;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "fixed_assets_in_service_b_guard_trg"
	BEFORE UPDATE ON "fixed_assets"
	FOR EACH ROW
	WHEN (OLD."in_service_on" IS DISTINCT FROM NEW."in_service_on")
	EXECUTE FUNCTION "fixed_assets_in_service_b_guard"();--> statement-breakpoint

-- ===========================================================================================
-- stores_opening_date_propagate -- re-touches every 'store_opening' follower at this store so the
-- fill/guard pair above re-runs for it. `SET store_id = store_id` is a no-op VALUE change that
-- still satisfies "UPDATE OF store_id" (Postgres fires a column-restricted trigger whenever that
-- column is named in the SET list, whether or not its value actually changes) -- the cheapest way
-- to re-fire the fill trigger without duplicating its logic here.
--
-- ⛔ Amendment R4.4 (1) -- "status = 'active'" scopes this to active followers only, matching
-- domain/stores/service.ts's setStoreOpeningDate cascade exactly. A disposed asset is no longer
-- depreciating anything, so re-deriving its in_service_on here would be a no-op with teeth: it
-- could only ever surface a phantom DEF-435 conflict or reversal against history that no longer
-- matters. Both sides freeze a disposed follower's in_service_on where it was.
-- ===========================================================================================
CREATE OR REPLACE FUNCTION "stores_opening_date_propagate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	UPDATE "fixed_assets" SET "store_id" = "store_id"
		WHERE "store_id" = NEW."id" AND "in_service_source" = 'store_opening' AND "status" = 'active';
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "stores_opening_date_propagate_trg"
	AFTER UPDATE OF "opening_date" ON "stores"
	FOR EACH ROW EXECUTE FUNCTION "stores_opening_date_propagate"();--> statement-breakpoint

CREATE INDEX "fixed_assets_org_id_in_service_on_idx" ON "fixed_assets" ("org_id", "in_service_on");
