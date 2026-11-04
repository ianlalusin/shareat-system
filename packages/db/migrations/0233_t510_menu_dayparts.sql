-- 0233 -- T-510 S1a: menu dayparts (a repeating weekly window on a menu offer). docs/tasks/510-menu-dayparts.md R1 (table), R2 (daypart_id on an offer), R3 (guards).
--
-- WHY. Lipa prices its unlimited packages by time of day (Lunch 08:00-17:00, Dinner 17:00-08:00, every day). v2 holds that as ONE package with two offers, each
-- tied to a daypart, instead of v1's two near-identical packages (LT / DT). This migration is the data model and the database rules only. Nothing reads or writes a
-- daypart yet (repo, domain, screens and projection are S1b and later). Every existing offer keeps daypart_id NULL, which means "all day", so nothing changes until a
-- daypart is chosen.
--
-- WHAT IT ADDS.
--   * menu_dayparts: store-scoped; days smallint[] (0 = Sunday .. 6, the day the window STARTS), start_time, end_time (end earlier than start = overnight; end = start
--     is refused), status active|retired. Same-org composite FKs like the other menu tables. Unique ACTIVE name per store, case-insensitive. UNIQUE (store_id, id) is
--     the target of the offer FK.
--   * menu_offers.daypart_id (nullable) + FK (store_id, daypart_id) -> menu_dayparts (store_id, id): a daypart of another store is refused by the database.
--   * menu_offers_slot_unique becomes (store_id, variant_id, channel, daypart_id, effective_from) NULLS NOT DISTINCT (PostgreSQL 15+; the repo runs 18), so two
--     all-day rows in one slot still collide exactly as before.
--   * menu_daypart_windows_overlap(): the SQL twin of daypartsOverlap in packages/domain/src/menu/daypart.ts; the integration test proves they agree. Days are
--     placed on a Sunday-based week of minutes, an overnight window belongs to the day it starts, a spill past Saturday wraps to Sunday, adjacent windows do NOT overlap.
--   * menu_offer_slot_conflict(): the one query for "would this variant and channel, at some moment, have a live all-day offer next to a live dayparted one, or two live
--     dayparted offers whose windows overlap". The offer insert guard calls it with the new row; the daypart update guard calls it with the new window.
--   * menu_offers_insert_guard() is REPLACED (every 0196 check kept, in the same order) and gains, at the end: (a) a live offer's daypart must be active; (b) overlap
--     refused; (c) all-day next to dayparted refused. All three are skipped for a withdrawn row, so "withdraw each dayparted offer, then add the all-day offer" is accepted
--     and the reverse order is refused.
--   * menu_dayparts_update_guard(): id / org_id / store_id never change; retiring is refused while a live offer uses the daypart (count in the message); a change of
--     days, start or end is refused when it would make two live offers of one variant and channel overlap.
--   * menu_offer_in_force() now returns the newest row per DAYPART slot (one row for an all-day variant, exactly as before). menu_variant_has_live_offer() keeps its text:
--     it reads the in-force function, so it is now true when ANY dayparted slot is live.
--
-- SEMANTICS (read these before changing a guard).
--   * "Live" = the slot's newest row at or before the moment, not withdrawn. A slot is (store, variant, channel, daypart). Same rule as menu_offer_in_force (K2).
--   * "At the same moment" = at the new row's effective_from AND at every later effective_from already stored for that store, variant and channel, plus now(). State only
--     changes at a row's effective_from, so those are the only moments worth testing. (0196's monotonic rule means no later row can exist today; the later-dated leg is the
--     backstop if that rule is ever relaxed per daypart.)
--   * A dayparted slot with a live row counts even if its window is closed right now: windows are compared for overlap, never for "open now".
--   * The retire count and the window-edit check use the same live rule; a scheduled (future) live row counts as live, like menu_variant_has_live_offer.
--
-- CONCURRENCY. Offer inserts already serialise per item and variant (menu_lock_keys). The new daypart guards add no new lock KIND: an offer insert takes the daypart row
-- FOR SHARE after the item and variant keys; a retire or window edit first takes the variant keys of every variant that has an offer on the daypart (ascending, the
-- 0196 order), then the daypart row FOR NO KEY UPDATE, and only then reads the offers. So a retire cannot commit over an offer insert it did not see, and no cycle forms.
--
-- RLS (0011 / 0196 pattern): ENABLE + FORCE, one policy through app_current_org(), never raw current_setting (DEF-077). Store scoping is the repo's filter plus the composite
-- FKs; the policy is the org backstop, as for the other menu tables.
-- GRANTS (ADR-012 s5 4a): shareat_app gets SELECT, INSERT and a COLUMN-LEVEL UPDATE (name, days, start_time, end_time, status, updated_at; never id, org_id, store_id,
-- created_by) on menu_dayparts. No DELETE: a daypart is retired, never deleted (and offers reference it with ON DELETE RESTRICT). updated_at is set by the repo, as for 0232.
--
-- LOCK BUDGET. menu_dayparts is new and empty. menu_offers: ADD COLUMN (nullable, no default) is a catalogue change; the FK and the rebuilt unique constraint scan and index a
-- small table (offers of a handful of stores), under ACCESS EXCLUSIVE for the constraint swap. First statement SET LOCAL lock_timeout = '5s' (resets at commit). No backfill.
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Pure helpers.
-- ---------------------------------------------------------------------------------------------
-- days: one dimension, 1-7 elements, each 0-6, no NULL, no duplicate. Always returns true/false, never NULL (a NULL result would let a CHECK pass).
CREATE FUNCTION "menu_daypart_days_ok"(p_days smallint[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
	SELECT p_days IS NOT NULL
	   AND coalesce(array_ndims(p_days), 0) = 1
	   AND cardinality(p_days) BETWEEN 1 AND 7
	   AND NOT EXISTS (SELECT 1 FROM unnest(p_days) d WHERE d IS NULL OR d NOT BETWEEN 0 AND 6)
	   AND (SELECT count(DISTINCT d) FROM unnest(p_days) d) = cardinality(p_days)
$$;
--> statement-breakpoint

-- True when some store-local instant is inside both windows. Each window is placed on a week of 10080 minutes starting Sunday 00:00 (an overnight window runs past its day);
-- two intervals on that circle overlap when one of the shifts -1, 0, +1 week makes them overlap on the line. Half-open: adjacent windows do not overlap.
CREATE FUNCTION "menu_daypart_windows_overlap"(a_days smallint[], a_start time, a_end time, b_days smallint[], b_start time, b_end time)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
	WITH w AS (
		SELECT (extract(hour FROM a_start) * 60 + extract(minute FROM a_start))::int AS sa,
		       (extract(hour FROM a_end) * 60 + extract(minute FROM a_end))::int AS ea,
		       (extract(hour FROM b_start) * 60 + extract(minute FROM b_start))::int AS sb,
		       (extract(hour FROM b_end) * 60 + extract(minute FROM b_end))::int AS eb
	), l AS (
		SELECT sa, sb,
		       CASE WHEN ea > sa THEN ea - sa ELSE 1440 - sa + ea END AS la,
		       CASE WHEN eb > sb THEN eb - sb ELSE 1440 - sb + eb END AS lb
		  FROM w
	)
	SELECT EXISTS (
		SELECT 1
		  FROM l, unnest(a_days) AS ad, unnest(b_days) AS bd, generate_series(-1, 1) AS k
		 WHERE ad * 1440 + sa < bd * 1440 + sb + lb + k * 10080
		   AND bd * 1440 + sb + k * 10080 < ad * 1440 + sa + la
	)
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "menu_dayparts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"days" smallint[] NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "menu_dayparts_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "menu_dayparts_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "menu_dayparts_status_check" CHECK ("status" in ('active','retired')),
	CONSTRAINT "menu_dayparts_days_check" CHECK ("menu_daypart_days_ok"("days")),
	CONSTRAINT "menu_dayparts_end_not_start_check" CHECK ("end_time" <> "start_time"),
	CONSTRAINT "menu_dayparts_whole_minutes_check" CHECK (extract(second FROM "start_time") = 0 AND extract(second FROM "end_time") = 0),
	CONSTRAINT "menu_dayparts_within_day_check" CHECK ("start_time" < time '24:00' AND "end_time" < time '24:00')
);
--> statement-breakpoint

ALTER TABLE "menu_dayparts" ADD CONSTRAINT "menu_dayparts_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_dayparts" ADD CONSTRAINT "menu_dayparts_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_dayparts" ADD CONSTRAINT "menu_dayparts_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_dayparts" ADD CONSTRAINT "menu_dayparts_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_dayparts" ADD CONSTRAINT "menu_dayparts_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint

CREATE UNIQUE INDEX "menu_dayparts_store_active_name_key" ON "menu_dayparts" ("store_id", lower("name")) WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "menu_dayparts_org_store_idx" ON "menu_dayparts" ("org_id","store_id");
--> statement-breakpoint

ALTER TABLE "menu_dayparts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "menu_dayparts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "menu_dayparts_org_isolation" ON "menu_dayparts"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

GRANT SELECT, INSERT ON "menu_dayparts" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("name", "days", "start_time", "end_time", "status", "updated_at") ON "menu_dayparts" TO "shareat_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- menu_offers.daypart_id.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "menu_offers" ADD COLUMN "daypart_id" uuid;
--> statement-breakpoint
ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_daypart_same_store_fk"
	FOREIGN KEY ("store_id","daypart_id") REFERENCES "menu_dayparts"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "menu_offers" DROP CONSTRAINT "menu_offers_slot_unique";
--> statement-breakpoint
ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_slot_unique"
	UNIQUE NULLS NOT DISTINCT ("store_id","variant_id","channel","daypart_id","effective_from");
--> statement-breakpoint
CREATE INDEX "menu_offers_daypart_idx" ON "menu_offers" ("daypart_id") WHERE "daypart_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- "In force at t", per daypart slot. For a variant with only all-day rows this is the one newest row, exactly as in 0196.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "menu_offer_in_force"(p_store uuid, p_variant uuid, p_channel text, p_at timestamptz)
RETURNS SETOF "menu_offers" LANGUAGE sql STABLE AS $$
	SELECT DISTINCT ON ("daypart_id") * FROM "menu_offers"
	 WHERE "store_id" = p_store AND "variant_id" = p_variant AND "channel" = p_channel AND "effective_from" <= p_at
	 ORDER BY "daypart_id", "effective_from" DESC
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The one conflict query. NULL = no conflict; otherwise 'mixed_all_day_and_daypart' or 'overlapping_dayparts'.
--   p_has_new: treat one more row (p_new_daypart, p_new_from, p_new_withdrawn) as already stored (the offer insert guard runs BEFORE INSERT).
--   p_ov_id:   treat daypart p_ov_id as having the window (p_ov_days, p_ov_start, p_ov_end) (the daypart update guard runs BEFORE UPDATE).
-- Moments tested: now() and every effective_from later than now() among the stored rows and the new one.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_offer_slot_conflict"(
	p_store uuid, p_variant uuid, p_channel text,
	p_has_new boolean, p_new_daypart uuid, p_new_from timestamptz, p_new_withdrawn boolean,
	p_ov_id uuid, p_ov_days smallint[], p_ov_start time, p_ov_end time
) RETURNS text LANGUAGE sql STABLE AS $$
	WITH rws AS (
		SELECT o."daypart_id", o."effective_from", o."withdrawn" FROM "menu_offers" o
		 WHERE o."store_id" = p_store AND o."variant_id" = p_variant AND o."channel" = p_channel
		UNION ALL
		SELECT p_new_daypart, p_new_from, p_new_withdrawn WHERE p_has_new
	), moments AS (
		SELECT now() AS t
		UNION
		SELECT "effective_from" FROM rws WHERE "effective_from" > now()
	), live AS (
		SELECT m.t, s."daypart_id"
		  FROM moments m
		 CROSS JOIN LATERAL (
			SELECT DISTINCT ON (r."daypart_id") r."daypart_id", r."withdrawn" FROM rws r
			 WHERE r."effective_from" <= m.t
			 ORDER BY r."daypart_id", r."effective_from" DESC
		 ) s
		 WHERE NOT s."withdrawn"
	), wins AS (
		SELECT d."id", d."days", d."start_time", d."end_time" FROM "menu_dayparts" d
		 WHERE d."store_id" = p_store AND d."id" IS DISTINCT FROM p_ov_id
		UNION ALL
		SELECT p_ov_id, p_ov_days, p_ov_start, p_ov_end WHERE p_ov_id IS NOT NULL
	)
	SELECT CASE
		WHEN EXISTS (SELECT 1 FROM live a JOIN live b ON b.t = a.t AND a."daypart_id" IS NULL AND b."daypart_id" IS NOT NULL)
			THEN 'mixed_all_day_and_daypart'
		WHEN EXISTS (
			SELECT 1 FROM live a
			  JOIN live b ON b.t = a.t AND a."daypart_id" < b."daypart_id"
			  JOIN wins wa ON wa."id" = a."daypart_id"
			  JOIN wins wb ON wb."id" = b."daypart_id"
			 WHERE "menu_daypart_windows_overlap"(wa."days", wa."start_time", wa."end_time", wb."days", wb."start_time", wb."end_time"))
			THEN 'overlapping_dayparts'
	END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The offer insert guard: 0196's body unchanged up to the end of the live-offer block, then the daypart rules.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "menu_offers_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	v_type text;
	v_vstatus text;
	v_istatus text;
	v_item uuid;
	v_dstatus text;
	v_conflict text;
BEGIN
	SELECT v."menu_item_id" INTO v_item FROM "menu_item_variants" v WHERE v."id" = NEW."variant_id";
	PERFORM "menu_lock_keys"(ARRAY[v_item]);
	PERFORM "menu_lock_key"(NEW."variant_id");
	IF NEW."effective_from" < now() THEN
		RAISE EXCEPTION 'menu_offers rows are never back-dated: effective_from % is in the past (omit it to start now)', NEW."effective_from"
			USING ERRCODE = '23514';
	END IF;
	IF EXISTS (SELECT 1 FROM "menu_offers" o WHERE o."store_id" = NEW."store_id" AND o."variant_id" = NEW."variant_id"
	            AND o."channel" = NEW."channel" AND o."effective_from" > NEW."effective_from") THEN
		RAISE EXCEPTION 'menu_offers is monotonic: effective_from % is earlier than the latest row for this store, variant and channel (rows go in order)', NEW."effective_from"
			USING ERRCODE = '23514';
	END IF;
	SELECT i."item_type", v."status", i."status" INTO v_type, v_vstatus, v_istatus
	  FROM "menu_item_variants" v JOIN "menu_items" i ON i."id" = v."menu_item_id"
	 WHERE v."id" = NEW."variant_id";
	-- v_type is NULL only when the variant does not exist; the foreign key reports that.
	IF NEW."bundle_heads" IS NOT NULL AND v_type IS NOT NULL AND v_type <> 'package' THEN
		RAISE EXCEPTION 'bundle pricing is only for a package variant (this one belongs to a % item)', v_type
			USING ERRCODE = '23514';
	END IF;
	IF NOT NEW."withdrawn" THEN
		IF v_vstatus = 'retired' OR v_istatus = 'retired' THEN
			RAISE EXCEPTION 'a live offer cannot be set for a retired variant or a variant of a retired item' USING ERRCODE = '23514';
		END IF;
		IF v_type = 'refill' AND (NEW."amount" IS NOT NULL OR NEW."pricing_mode" <> 'fixed') THEN
			RAISE EXCEPTION 'a refill offer carries no amount and no price rule (a refill is a zero-price serving)' USING ERRCODE = '23514';
		END IF;
		IF v_type IS NOT NULL AND v_type <> 'refill' AND NEW."pricing_mode" = 'fixed' AND NEW."amount" IS NULL THEN
			RAISE EXCEPTION 'a live fixed offer for a % item needs an amount', v_type USING ERRCODE = '23514';
		END IF;
		IF NOT EXISTS (SELECT 1 FROM "menu_depletion_rules" r
		                WHERE r."variant_id" = NEW."variant_id" AND r."effective_from" <= NEW."effective_from") THEN
			RAISE EXCEPTION 'a live offer needs a depletion rule in force at its effective_from (%): set the variant''s depletion rule first', NEW."effective_from"
				USING ERRCODE = '23514';
		END IF;
	END IF;

	-- T-510 (0233). The daypart row is locked FOR SHARE so a concurrent retire or window edit waits for this insert (and sees it), or this insert waits for it.
	IF NEW."daypart_id" IS NOT NULL THEN
		SELECT d."status" INTO v_dstatus FROM "menu_dayparts" d WHERE d."id" = NEW."daypart_id" FOR SHARE;
		-- v_dstatus is NULL only when the daypart does not exist (or is not visible); the foreign key reports that.
		IF NOT NEW."withdrawn" AND v_dstatus = 'retired' THEN
			RAISE EXCEPTION 'a live offer cannot use a retired daypart (choose an active daypart, or all day)' USING ERRCODE = '23514';
		END IF;
	END IF;
	IF NOT NEW."withdrawn" THEN
		v_conflict := "menu_offer_slot_conflict"(NEW."store_id", NEW."variant_id", NEW."channel", true, NEW."daypart_id", NEW."effective_from", false, NULL, NULL, NULL, NULL);
		IF v_conflict = 'mixed_all_day_and_daypart' THEN
			RAISE EXCEPTION 'a variant cannot have a live all-day offer and a live dayparted offer at the same time for one store and channel (withdraw the other kind first)'
				USING ERRCODE = '23514';
		ELSIF v_conflict = 'overlapping_dayparts' THEN
			RAISE EXCEPTION 'live dayparted offers of one variant, store and channel may not overlap in time (this daypart overlaps another live offer''s daypart)'
				USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The daypart update guard.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_dayparts_update_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	v_live integer;
	v_conflict text;
	r record;
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."org_id" IS DISTINCT FROM OLD."org_id" OR NEW."store_id" IS DISTINCT FROM OLD."store_id" THEN
		RAISE EXCEPTION 'menu_dayparts: id, org_id and store_id never change' USING ERRCODE = '23514';
	END IF;
	IF NEW."days" IS NOT DISTINCT FROM OLD."days" AND NEW."start_time" IS NOT DISTINCT FROM OLD."start_time"
	   AND NEW."end_time" IS NOT DISTINCT FROM OLD."end_time" AND NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
		RETURN NEW; -- a rename or an updated_at touch: nothing to protect
	END IF;
	-- Variant keys first (ascending, the 0196 order), then the daypart row, then read the offers (a fresh snapshot per statement).
	PERFORM "menu_lock_keys"(ARRAY(SELECT DISTINCT o."variant_id" FROM "menu_offers" o WHERE o."daypart_id" = OLD."id"));
	PERFORM 1 FROM "menu_dayparts" d WHERE d."id" = OLD."id" FOR NO KEY UPDATE;

	IF NEW."status" = 'retired' AND OLD."status" IS DISTINCT FROM 'retired' THEN
		SELECT count(*) INTO v_live FROM (
			SELECT DISTINCT ON (o."variant_id", o."channel") o."withdrawn" FROM "menu_offers" o
			 WHERE o."daypart_id" = OLD."id"
			 ORDER BY o."variant_id", o."channel", o."effective_from" DESC
		) s WHERE NOT s."withdrawn";
		IF v_live > 0 THEN
			RAISE EXCEPTION 'this daypart cannot be retired: % live offer(s) still use it (withdraw them first)', v_live USING ERRCODE = '23514';
		END IF;
	END IF;

	IF NEW."days" IS DISTINCT FROM OLD."days" OR NEW."start_time" IS DISTINCT FROM OLD."start_time" OR NEW."end_time" IS DISTINCT FROM OLD."end_time" THEN
		FOR r IN SELECT DISTINCT o."store_id", o."variant_id", o."channel" FROM "menu_offers" o WHERE o."daypart_id" = OLD."id" LOOP
			v_conflict := "menu_offer_slot_conflict"(r."store_id", r."variant_id", r."channel", false, NULL, NULL, NULL, OLD."id", NEW."days", NEW."start_time", NEW."end_time");
			IF v_conflict IS NOT NULL THEN
				RAISE EXCEPTION 'this daypart''s days or times cannot change: it would overlap another live offer''s daypart for the same variant and channel (%)', v_conflict
					USING ERRCODE = '23514';
			END IF;
		END LOOP;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "menu_dayparts_update_guard" BEFORE UPDATE ON "menu_dayparts"
	FOR EACH ROW EXECUTE FUNCTION "menu_dayparts_update_guard"();
