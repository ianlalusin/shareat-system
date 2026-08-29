-- 0062 — T-160: the room model every stock movement is keyed to.
--
-- HAND-WRITTEN, like 0020-0061. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⛔⛔ NOT YET JOURNALLED, AND THEREFORE NOT YET APPLIED. READ THIS BEFORE RUNNING ANYTHING. ⛔⛔
--
-- `migrations/meta/_journal.json` was held UNCOMMITTED by a peer session building T-153 when this
-- file landed, and editing it would have swept their in-flight entry into this commit — the exact
-- mistake that put decision row 164 on the wrong branch earlier the same day. So this file exists,
-- reviewed and complete, with no journal entry.
--
-- ⭐ TO FINISH IT, once 0061 is committed: append ONE entry to `_journal.json` —
--     { "idx": 62, "version": "7", "when": <0061's `when` + 86400000>,
--       "tag": "0062_t160_stock_locations", "breakpoints": true }
--   then `npm run db:migrate`, then run the T-160 integration tests.
--
-- ⚠️ If a peer has already taken 0062, renumber the file and the tag together. Nothing else in the
-- repo references this number.
--
-- ⚠️ ALSO DEFERRED WITH IT: `stores.stock_model`, at the bottom of this file. It is a column on an
-- EXISTING table, so declaring it in the drizzle schema before this migration runs would make
-- every `SELECT` against `stores` name a column the database does not have — breaking the other
-- sessions sharing this checkout, not merely this branch. The schema file says so too.

-- ---------------------------------------------------------------------------------------------
-- 1. What KINDS of space a store can have.
--
-- Per org, not global: a commissary and a kiosk describe themselves differently, and neither
-- should have to invent private vocabulary inside a shared list.
CREATE TABLE "location_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_types_code_not_blank_check" CHECK (length(trim("code")) > 0),
	CONSTRAINT "location_types_name_not_blank_check" CHECK (length(trim("name")) > 0)
);--> statement-breakpoint

ALTER TABLE "location_types" ADD CONSTRAINT "location_types_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "location_types_org_code_key" ON "location_types" ("org_id", "code");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. The rooms themselves.
--
-- ⭐ `role` is a CONTROL, not a label: a storage room may hold and receive stock but nothing may be
-- CONSUMED from it. Only an `operating` room (kitchen, display) can be a usage source. Defaulting
-- to 'storage' is the FAIL-SAFE direction — v1's own words, worth keeping because the safe way
-- round is not obvious until you have picked the wrong one: "a mis-migrated location can't
-- silently drain stock."
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid NOT NULL,
	"role" text DEFAULT 'storage' NOT NULL,
	"purpose" text DEFAULT 'normal' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "stock_locations_role_check" CHECK ("role" IN ('storage', 'operating')),
	CONSTRAINT "stock_locations_purpose_check" CHECK ("purpose" IN ('normal', 'receiving')),
	CONSTRAINT "stock_locations_status_check" CHECK ("status" IN ('active', 'inactive')),
	CONSTRAINT "stock_locations_code_not_blank_check" CHECK (length(trim("code")) > 0),
	CONSTRAINT "stock_locations_name_not_blank_check" CHECK (length(trim("name")) > 0),
	-- The Receiving room is a parking spot, never a kitchen.
	CONSTRAINT "stock_locations_receiving_is_storage_check"
		CHECK ("purpose" <> 'receiving' OR "role" = 'storage')
);--> statement-breakpoint

ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_type_id_location_types_id_fk"
	FOREIGN KEY ("type_id") REFERENCES "location_types"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "stock_locations_store_code_key" ON "stock_locations" ("store_id", "code");--> statement-breakpoint
CREATE INDEX "stock_locations_store_status_idx" ON "stock_locations" ("store_id", "status");--> statement-breakpoint
CREATE INDEX "stock_locations_org_idx" ON "stock_locations" ("org_id");--> statement-breakpoint

-- ⭐ INVARIANTS 1 AND 2, AS THE DATABASE REFUSES THEM — not as something the service remembers.
-- Bible row 104: name the statement the database rejects, never the call our code declines to
-- make. Partial, so an inactive room neither holds the slot nor blocks a new one.
CREATE UNIQUE INDEX "stock_locations_one_receiving_per_store"
	ON "stock_locations" ("store_id") WHERE "purpose" = 'receiving' AND "status" = 'active';--> statement-breakpoint

CREATE UNIQUE INDEX "stock_locations_one_default_per_store"
	ON "stock_locations" ("store_id") WHERE "is_default" AND "status" = 'active';--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Departments — what usage is attributed to.
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_status_check" CHECK ("status" IN ('active', 'inactive')),
	CONSTRAINT "departments_code_not_blank_check" CHECK (length(trim("code")) > 0),
	CONSTRAINT "departments_name_not_blank_check" CHECK (length(trim("name")) > 0)
);--> statement-breakpoint

ALTER TABLE "departments" ADD CONSTRAINT "departments_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "departments_org_code_key" ON "departments" ("org_id", "code");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. How a store organises stock — INVARIANT 6, made structural.
--
-- ⭐ v1 ships `branch-stock-reconcile.actions.ts` purely to REPAIR branches that drifted into
-- several rooms: floor the negative balances, move everything into a canonical room, delete the
-- strays. This constraint is that tool's reason for existing, removed.
ALTER TABLE "stores" ADD COLUMN "stock_model" text DEFAULT 'single_room' NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_stock_model_check"
	CHECK ("stock_model" IN ('single_room', 'multi_room'));--> statement-breakpoint

-- One non-Receiving active room per single_room store. ⚠️ Expressed as a partial unique index on
-- (store_id) over the rows that count, which needs the store's model on the row — so it is
-- enforced by trigger instead, because a unique index cannot reach into `stores`.
CREATE OR REPLACE FUNCTION "stock_locations_single_room_guard"() RETURNS trigger AS $$
DECLARE
	model text;
	room_count integer;
BEGIN
	-- ⭐ The row being written must be excused before anything is counted. A RECEIVING room never
	-- counts against the limit — every store needs one, including a branch that keeps its stock in
	-- exactly one place — and an INACTIVE row is not in play at all.
	--
	-- ⚠️ Omitting this check was a real bug, caught by `stock-locations.test.ts` and not by review:
	-- the count below excluded existing Receiving rooms but never asked what NEW was, so adding a
	-- Receiving room to a single-room store that already had its one room was refused. The pure
	-- rule in `stock-locations/rules.ts` filtered the whole list and got it right; the SQL did not,
	-- and only a test against real PostgreSQL could see the two disagree.
	IF NEW."purpose" = 'receiving' OR NEW."status" <> 'active' THEN RETURN NEW; END IF;

	SELECT "stock_model" INTO model FROM "stores" WHERE "id" = NEW."store_id";
	IF model <> 'single_room' THEN RETURN NEW; END IF;

	SELECT count(*) INTO room_count FROM "stock_locations"
		WHERE "store_id" = NEW."store_id" AND "purpose" <> 'receiving' AND "status" = 'active'
		  AND "id" <> NEW."id";

	IF room_count >= 1 THEN
		RAISE EXCEPTION 'store % is single_room and already has an active non-Receiving room',
			NEW."store_id";
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "stock_locations_single_room_guard_trg"
	BEFORE INSERT OR UPDATE ON "stock_locations"
	FOR EACH ROW EXECUTE FUNCTION "stock_locations_single_room_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. RLS — added AS THE TABLE IS CREATED, never retrofitted (bible row 112).
--
-- ⚠️ `app_current_org()`'s NULLIF-guarded form, not a raw `current_setting` cast — DEF-077: a
-- pooled connection leaves `app.org_id` as '' rather than NULL, and the raw cast then 500s.
-- ⚠️ ENABLE then FORCE, and FORCE is the half that is silently missed. Without it the table
-- OWNER bypasses every policy — which is the connection the app itself uses — so isolation tests
-- pass while nothing is actually isolated. T-120's invariant 9 caught exactly that here, on the
-- first run, having been written for precisely this omission.
ALTER TABLE "location_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "location_types" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_locations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "departments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "location_types_org_isolation" ON "location_types"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "stock_locations_org_isolation" ON "stock_locations"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "departments_org_isolation" ON "departments"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
