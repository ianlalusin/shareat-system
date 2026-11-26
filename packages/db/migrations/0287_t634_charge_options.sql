-- 0287 - T-634: one master list of charges per org; each store switches them on. docs/tasks/634-central-charges.md; hand-authored per ADR-012 s5.
-- Journal idx 287, `when` = 0286's (T-641) + 86400000: renumbered from 0278 → 0282 (25 Nov) → 0287 (26 Nov 2026) because main took 0279-0286 first.
-- The shape is 0277's (payment options).
--
-- WHY. Ian, 24 Nov: "charges i guess shall be centralized so charges are uniform across the brand". A store's charges (T-627, 0275) were typed per store, so
-- "Leftover" could be 100 at one store and 120 at another. Now the org holds ONE list (name, amount, per unit) and a store only switches a charge on or off.
--
-- WHAT IT ADDS
--   charge_options                     the org's master list: name (1-40, unique per org by its a-z0-9 form, so "Extra griller" and "Extra-griller" cannot both
--                                      exist), amount (> 0, <= 100,000), per_unit, sort order, status active|retired. KEEP (master data).
--   pos_charge_presets.charge_option_id  NOT NULL after the backfill below, same-org composite FK. A store's preset row IS the store's switch for an option
--                                      (status active = on). name, amount and per_unit stay as a MIRROR the option owns (the trigger below forces them), so the
--                                      snapshot, the tablet and the sale keep reading the preset row unchanged.
--   ONE ACTIVE ROW per (store, option): a partial UNIQUE index WHERE status = 'active'. Not a full UNIQUE, on purpose: under T-627 a store could retire "Leftover"
--                                      and add it again, which leaves an old retired row that past bills point at (it can never be deleted). Both rows join the
--                                      one option; switching on again reuses the newest row (the domain), so no new duplicate is ever made.
--
-- A CHARGE ON A TABLE IS A SNAPSHOT. table_session_charges and pos_sales_receipt_charges copy the name and unit amount when the charge is added
-- (packages/domain/src/pos/charges.ts resolveCharge; sale.ts copies the session rows). A changed amount reaches the next charge added, never one already on a table.
--
-- BACKFILL (inside this file; prints nothing). Every preset (active and retired) is matched to an option by its NORMALISED name inside its org (lower, a-z0-9
-- only, as 0277). The option's name is the earliest active preset's spelling (or the newest retired one's when none is active); its amount and per_unit are
-- those of its ACTIVE presets (or the newest retired one's); its status is active when any store has it on, else retired. Every preset is then set to its
-- option's name, amount and per_unit (that is the point). It STOPS (raises, so nothing is applied) instead of guessing when
--   (a) two ACTIVE presets of ONE store map to one option ("Extra griller" and "Extra-griller" both on): two presets of one store are never merged,
--   (b) the ACTIVE presets of one option disagree on the amount or on per unit at two stores (retired presets are history and are not compared).
-- The read-only pre-check for both is in docs/tasks/634-central-charges.md "As built".
--
-- TRIGGERS (all origin, not history guards: they read other rows' current state; triggers/registry.ts)
--   pos_charge_presets_mirror_option  BEFORE INSERT OR UPDATE on pos_charge_presets: the option cannot change; name, amount and per_unit are set FROM the option;
--                                     a retired option cannot be switched on. An INSERT without charge_option_id fails on NOT NULL.
--   charge_options_guard              BEFORE UPDATE on charge_options: org and name frozen (a rename is retire + add, as T-627); retiring refused while any store
--                                     has it ON.
--   charge_options_mirror_presets     AFTER UPDATE OF amount, per_unit: every store row of the option takes the new amount / per unit.
--
-- GRANTS (ADR-012 s5 4a). shareat_app: SELECT, INSERT on charge_options; UPDATE (amount, per_unit, sort_order, status, updated_at); never DELETE; no UPDATE of
-- name. RLS ENABLE + FORCE, one org_isolation policy via app_current_org(). pos_charge_presets keeps its 0275 grants (UPDATE amount, per_unit, status,
-- updated_at), which is all the mirror writes.
-- LOCK BUDGET. lock_timeout 5s first; one new table, one ADD COLUMN (nullable, no rewrite), one UPDATE of pos_charge_presets (a small table), then SET NOT NULL
-- and the indexes.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE "charge_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"per_unit" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "charge_options_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "charge_options_status_check" CHECK ("status" IN ('active','retired')),
	CONSTRAINT "charge_options_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 40),
	CONSTRAINT "charge_options_amount_check" CHECK ("amount" > 0 AND "amount" <= 100000),
	CONSTRAINT "charge_options_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "charge_options" ADD CONSTRAINT "charge_options_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "charge_options_org_name_unique" ON "charge_options" ("org_id", (coalesce(nullif(regexp_replace(lower("name"), '[^a-z0-9]', '', 'g'), ''), lower(btrim("name")))));
--> statement-breakpoint
ALTER TABLE "pos_charge_presets" ADD COLUMN "charge_option_id" uuid;
--> statement-breakpoint

-- the backfill: STOP on anything ambiguous, otherwise one option per (org, normalised name)
DO $do$
DECLARE
	bad record;
BEGIN
	CREATE TEMP TABLE t634_keys ON COMMIT DROP AS
		SELECT p.id, p.org_id, p.store_id, btrim(p.name) AS name, p.amount, p.per_unit, p.status, p.created_at,
			coalesce(nullif(regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g'), ''), lower(btrim(p.name))) AS k
		FROM pos_charge_presets p;

	SELECT g.store_id, min(g.name) AS n INTO bad FROM t634_keys g WHERE g.status = 'active' GROUP BY g.org_id, g.store_id, g.k HAVING count(*) > 1 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'T-634 STOP: store % has two charges switched on (for example "%") that are the same charge by name. Retire one of them at that store, then run again. Report to BOSS; nothing was changed.', bad.store_id, bad.n;
	END IF;
	SELECT g.org_id, min(g.name) AS n INTO bad FROM t634_keys g WHERE g.status = 'active' GROUP BY g.org_id, g.k HAVING count(DISTINCT g.amount::text || '|' || g.per_unit::text) > 1 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'T-634 STOP: org % has the charge "%" at different amounts (or once per bill at one store and per unit at another). Make them the same at every store, then run again. Report to BOSS; nothing was changed.', bad.org_id, bad.n;
	END IF;

	-- one row per (org, normalised name): the option it becomes, with its id made HERE (the final UPDATE joins on this map, never on a re-derived key).
	-- The representative preset: the earliest ACTIVE one, else the newest retired one.
	CREATE TEMP TABLE t634_map ON COMMIT DROP AS
		SELECT r.org_id, r.k, uuidv7() AS option_id, r.name AS option_name, r.amount, r.per_unit,
			CASE WHEN EXISTS (SELECT 1 FROM t634_keys a WHERE a.org_id = r.org_id AND a.k = r.k AND a.status = 'active') THEN 'active' ELSE 'retired' END AS status,
			row_number() OVER (PARTITION BY r.org_id ORDER BY r.name) * 10 AS sort_order
		FROM (
			SELECT DISTINCT ON (x.org_id, x.k) x.org_id, x.k, x.name, x.amount, x.per_unit
			FROM t634_keys x
			ORDER BY x.org_id, x.k, (x.status = 'active') DESC,
				CASE WHEN x.status = 'active' THEN extract(epoch FROM x.created_at) ELSE -extract(epoch FROM x.created_at) END, x.id
		) r;

	INSERT INTO charge_options (id, org_id, name, amount, per_unit, sort_order, status)
	SELECT m.option_id, m.org_id, m.option_name, m.amount, m.per_unit, m.sort_order, m.status FROM t634_map m;

	UPDATE pos_charge_presets p SET charge_option_id = m.option_id, name = m.option_name, amount = m.amount, per_unit = m.per_unit
	FROM t634_keys g JOIN t634_map m ON m.org_id = g.org_id AND m.k = g.k
	WHERE p.id = g.id;
END;
$do$;
--> statement-breakpoint

ALTER TABLE "pos_charge_presets" ALTER COLUMN "charge_option_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "pos_charge_presets" ADD CONSTRAINT "pos_charge_presets_charge_option_same_org_fk"
	FOREIGN KEY ("org_id","charge_option_id") REFERENCES "charge_options"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_charge_presets_store_option_active_key" ON "pos_charge_presets" ("store_id","charge_option_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "pos_charge_presets_option_idx" ON "pos_charge_presets" ("charge_option_id");
--> statement-breakpoint

-- pos_charge_presets: name, amount and per_unit come from the option
CREATE FUNCTION "pos_charge_presets_mirror_option"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	o record;
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.charge_option_id IS DISTINCT FROM OLD.charge_option_id THEN
		RAISE EXCEPTION 'A store charge stays on its charge option (preset %).', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	SELECT c.* INTO o FROM charge_options c WHERE c.org_id = NEW.org_id AND c.id = NEW.charge_option_id FOR SHARE;
	IF NOT FOUND THEN
		RETURN NEW; -- the composite FK raises
	END IF;
	IF NEW.status = 'active' AND o.status = 'retired' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
		RAISE EXCEPTION 'The charge "%" is retired and cannot be switched on.', o.name USING ERRCODE = 'restrict_violation';
	END IF;
	NEW.name := o.name;
	NEW.amount := o.amount;
	NEW.per_unit := o.per_unit;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_charge_presets_mirror_option"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pos_charge_presets_mirror_option" BEFORE INSERT OR UPDATE ON "pos_charge_presets" FOR EACH ROW EXECUTE FUNCTION "pos_charge_presets_mirror_option"();
--> statement-breakpoint

-- charge_options: org and name frozen; retire refused while on
CREATE FUNCTION "charge_options_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
		RAISE EXCEPTION 'A charge option never changes organisation (%).', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.name IS DISTINCT FROM OLD.name THEN
		RAISE EXCEPTION 'A charge keeps its name ("%"). To rename it, retire it and add a new one.', OLD.name USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.status = 'retired' AND OLD.status <> 'retired' AND EXISTS (SELECT 1 FROM pos_charge_presets p WHERE p.charge_option_id = OLD.id AND p.status = 'active') THEN
		RAISE EXCEPTION 'The charge "%" is switched on at a store, so it cannot be retired.', OLD.name USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "charge_options_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "charge_options_guard" BEFORE UPDATE ON "charge_options" FOR EACH ROW EXECUTE FUNCTION "charge_options_guard"();
--> statement-breakpoint
CREATE FUNCTION "charge_options_mirror_presets"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	UPDATE pos_charge_presets p SET amount = NEW.amount, per_unit = NEW.per_unit, updated_at = now()
	WHERE p.org_id = NEW.org_id AND p.charge_option_id = NEW.id AND (p.amount, p.per_unit) IS DISTINCT FROM (NEW.amount, NEW.per_unit);
	RETURN NULL;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "charge_options_mirror_presets"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "charge_options_mirror_presets" AFTER UPDATE OF "amount","per_unit" ON "charge_options" FOR EACH ROW EXECUTE FUNCTION "charge_options_mirror_presets"();
--> statement-breakpoint

-- RLS and grants
ALTER TABLE "charge_options" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "charge_options" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "charge_options_org_isolation" ON "charge_options" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT ON "charge_options" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("amount","per_unit","sort_order","status","updated_at") ON "charge_options" TO "shareat_app";
