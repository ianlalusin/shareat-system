-- 0068 — T-169: physical counts. The freeze, the count, and the variance that finally posts.
--
-- HAND-WRITTEN, like 0020-0067. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ TWO things here are worth reading before the DDL.
--
-- 1. THE FREEZE LIVES ON `stock_movements`, NOT ON EACH WRITER.
--    v1 wires the check into every usage, wastage, transfer, production and POS-pull path — five
--    places to remember, and §16.7 defect 6 is the record of what happens when one is missed. Here
--    it is ONE trigger on the table every one of them already writes through, so a future writer
--    inherits the freeze without knowing it exists.
--
-- 2. v1 POSTS NO GL ENTRY FOR A COUNT AT ALL — `stock-count.actions.ts` says "NO GL, v1" in its
--    own words. A fleet-wide shrinkage moved stock and touched the books nowhere. That is a gap
--    this closes, not a shape it ports.

CREATE TABLE "count_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"counted_on" date NOT NULL,
	"note" text,
	"committed_at" timestamp with time zone,
	"journal_entry_id" uuid,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "count_sessions_status_check"
		CHECK ("status" IN ('open','counting','reviewing','closed','cancelled')),
	CONSTRAINT "count_sessions_closed_shape_check"
		CHECK ("status" NOT IN ('closed','cancelled') OR ("closed_at" IS NOT NULL AND "closed_by" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_journal_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_opened_by_persons_id_fk"
	FOREIGN KEY ("opened_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "count_sessions" ADD CONSTRAINT "count_sessions_closed_by_persons_id_fk"
	FOREIGN KEY ("closed_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "count_sessions_store_status_idx" ON "count_sessions" ("store_id", "status");--> statement-breakpoint
CREATE INDEX "count_sessions_org_idx" ON "count_sessions" ("org_id");--> statement-breakpoint

CREATE TABLE "count_session_locations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"location_id" uuid NOT NULL
);--> statement-breakpoint

ALTER TABLE "count_session_locations" ADD CONSTRAINT "count_session_locations_session_id_count_sessions_id_fk"
	FOREIGN KEY ("session_id") REFERENCES "count_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "count_session_locations" ADD CONSTRAINT "count_session_locations_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "count_session_locations_key"
	ON "count_session_locations" ("session_id", "location_id");--> statement-breakpoint

-- ⭐ A location may be in at most ONE active session.
--
-- ⚠️ This WANTED to be a partial unique index and cannot be: Postgres refuses a subquery in an
-- index predicate ("cannot use subquery in index predicate"), and whether a session is active
-- lives on the SESSION, not on this row. The alternative — copying the status onto every location
-- row — would be a second copy of a fact to keep in step, which is the thing this project keeps
-- refusing. So it is a trigger, and the reason is recorded here rather than rediscovered.
CREATE FUNCTION "count_session_locations_one_active"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	clash uuid;
BEGIN
	SELECT s."id" INTO clash
	FROM "count_session_locations" csl
	JOIN "count_sessions" s ON s."id" = csl."session_id"
	WHERE csl."location_id" = NEW."location_id"
	  AND csl."id" <> NEW."id"
	  AND s."status" IN ('open','counting','reviewing')
	LIMIT 1;

	IF clash IS NOT NULL THEN
		RAISE EXCEPTION 'location % is already in active count session %', NEW."location_id", clash;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "count_session_locations_one_active_trg"
	BEFORE INSERT OR UPDATE ON "count_session_locations"
	FOR EACH ROW EXECUTE FUNCTION "count_session_locations_one_active"();--> statement-breakpoint

CREATE TABLE "count_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	-- Zero is a real, meaningful answer: an item ABSENT is indistinguishable from an item counted
	-- as zero, so a zero is stored explicitly.
	"counted_quantity" numeric(14, 3) NOT NULL,
	-- Snapshotted AT COMMIT, inside the committing transaction. Computing it earlier makes the
	-- variance a comparison against a number that has since moved.
	"expected_quantity" numeric(14, 3),
	"variance" numeric(14, 3),
	"movement_id" uuid,
	"counted_by" uuid NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "count_lines_counted_non_negative_check" CHECK ("counted_quantity" >= 0)
);--> statement-breakpoint

ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_session_id_count_sessions_id_fk"
	FOREIGN KEY ("session_id") REFERENCES "count_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_counted_by_persons_id_fk"
	FOREIGN KEY ("counted_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "count_lines_session_item_location_key"
	ON "count_lines" ("session_id", "item_id", "location_id");--> statement-breakpoint
CREATE INDEX "count_lines_session_idx" ON "count_lines" ("session_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⭐ THE FREEZE — one trigger, on the table every writer already goes through.
--
-- ⚠️ It FAILS CLOSED TO "NOT FROZEN", and the direction is a deliberate decision rather than an
-- accident of how the query is written. v1 states it: a session row with a missing or unknown
-- status must never freeze anything, *because this predicate gates every other inventory writer*.
-- A malformed row that froze a location would lock a store out of its own stock with no way to
-- clear it — which is exactly the landmine v1 nearly shipped.
--
-- ⭐ The bypass is a session GUC, set by the service only after `authorize()` — the same shape RLS
-- uses for `app.org_id`. A trigger cannot know who the caller is; the connection can.
CREATE FUNCTION "stock_movements_check_not_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	frozen boolean;
BEGIN
	IF COALESCE(NULLIF(current_setting('app.bypass_count_freeze', true), ''), 'off') = 'on' THEN
		RETURN NEW;
	END IF;

	SELECT EXISTS (
		SELECT 1
		FROM "count_session_locations" csl
		JOIN "count_sessions" s ON s."id" = csl."session_id"
		WHERE csl."location_id" = NEW."location_id"
		  AND s."status" IN ('open','counting','reviewing')
	) INTO frozen;

	IF frozen THEN
		RAISE EXCEPTION 'location % is frozen by an active count session; finish or cancel the count first',
			NEW."location_id";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "stock_movements_check_not_frozen_trg"
	BEFORE INSERT ON "stock_movements"
	FOR EACH ROW EXECUTE FUNCTION "stock_movements_check_not_frozen"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⛔ A committed session is terminal — a second commit is refused, not re-posted.
CREATE FUNCTION "count_sessions_commit_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."committed_at" IS NOT NULL AND NEW."committed_at" IS DISTINCT FROM OLD."committed_at" THEN
		RAISE EXCEPTION 'count session % is already committed', OLD."id";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "count_sessions_commit_once_trg"
	BEFORE UPDATE ON "count_sessions"
	FOR EACH ROW EXECUTE FUNCTION "count_sessions_commit_once"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE (bible row 112). Children derive through their session.
ALTER TABLE "count_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "count_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "count_session_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "count_session_locations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "count_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "count_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "count_sessions_org_isolation" ON "count_sessions"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

CREATE POLICY "count_session_locations_org_isolation" ON "count_session_locations"
	USING (EXISTS (SELECT 1 FROM "count_sessions" s WHERE s."id" = "session_id" AND s."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "count_sessions" s WHERE s."id" = "session_id" AND s."org_id" = app_current_org()));--> statement-breakpoint

CREATE POLICY "count_lines_org_isolation" ON "count_lines"
	USING (EXISTS (SELECT 1 FROM "count_sessions" s WHERE s."id" = "session_id" AND s."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "count_sessions" s WHERE s."id" = "session_id" AND s."org_id" = app_current_org()));--> statement-breakpoint
