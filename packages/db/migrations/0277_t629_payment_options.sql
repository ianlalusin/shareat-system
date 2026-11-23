-- 0277 - T-629: one master list of payment options per org; each store switches them on. docs/tasks/629-payment-options-master-list.md; hand-authored per ADR-012 s5.
-- Journal idx 277, `when` = 0276's + 86400000 (one day per index).
--
-- WHY. A store's payment options were free-typed per store ("Gcash" / "GCash" / "G-Cash"), so nothing tied the same option together across stores. Ian, 22-23 Nov:
-- the options are Cash, GCash, Maya, QRPH, Credit card, Debit card (a card is a `wallet` tender tied to the bank account its machine pays into; the bank fee is booked later
-- as a bank charge); each store enables them in settings.
--
-- WHAT IT ADDS
--   payment_options          the org's master list: name (1-40, unique per org case-insensitively), kind cash|wallet, sort order, status active|retired. KEEP (master data).
--                            ONE cash option per org at most (a partial unique, retired rows count).
--   tenders.payment_option_id   NOT NULL after the backfill below, same-org composite FK, UNIQUE (store_id, payment_option_id): a store tender IS the store's switch for an option.
--                            tenders.name and tenders.kind stay as a MIRROR the option owns (the trigger below forces them), so every reader keeps working.
--
-- BACKFILL (inside this file; prints nothing). Every tender is matched to an option by its NORMALISED name inside its org (lower, a-z0-9 only: the alias normalisation); an
-- option is made when none matches; the six of Ian's list are then added to every org that lacks them (the one cash option only if the org has no cash option yet). The
-- option's name is the Ian-list spelling when the key is one of the six, else the earliest tender's spelling; every tender is renamed to its option's name (that is the point).
-- It STOPS (raises, so nothing is applied) instead of guessing when
--   (a) two tenders of ONE store map to one option (no money rows are merged),
--   (b) the tenders of one option disagree on cash / wallet, or one of Ian's six names is held with the other kind,
--   (c) an org holds cash tenders under two different names (one cash option per org).
--
-- TRIGGERS (all origin, not history guards: they read other rows' current state; triggers/registry.ts)
--   tenders_mirror_option       BEFORE INSERT OR UPDATE on tenders: the option cannot change; name and kind are set FROM the option; a retired option cannot be switched on; an INSERT without
--                               payment_option_id (raw SQL, old fixtures) is matched by normalised name or the option is made, the kind must agree.
--   payment_options_guard       BEFORE UPDATE on payment_options: kind frozen while any store tender uses the option; retiring refused while any store has it ON; org frozen.
--   payment_options_rename_tenders  AFTER UPDATE of name: the store tenders of the option take the new name.
--
-- GRANTS (ADR-012 s5 4a). shareat_app: SELECT, INSERT on payment_options; UPDATE (name, kind, sort_order, status, updated_at); never DELETE. RLS ENABLE + FORCE, one org_isolation policy via app_current_org().
-- LOCK BUDGET. lock_timeout 5s first; one new table, one ADD COLUMN (nullable, no rewrite), one UPDATE of tenders (small table), then SET NOT NULL and the indexes.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE "payment_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "payment_options_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "payment_options_kind_check" CHECK ("kind" IN ('cash','wallet')),
	CONSTRAINT "payment_options_status_check" CHECK ("status" IN ('active','retired')),
	CONSTRAINT "payment_options_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 40)
);
--> statement-breakpoint
ALTER TABLE "payment_options" ADD CONSTRAINT "payment_options_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_options_org_name_unique" ON "payment_options" ("org_id", lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_options_one_cash_per_org" ON "payment_options" ("org_id") WHERE "kind" = 'cash';
--> statement-breakpoint
ALTER TABLE "tenders" ADD COLUMN "payment_option_id" uuid;
--> statement-breakpoint

-- the backfill: STOP on anything ambiguous, otherwise one option per (org, normalised name)
DO $do$
DECLARE
	bad record;
BEGIN
	CREATE TEMP TABLE t629_keys ON COMMIT DROP AS
		SELECT t.id, t.org_id, t.store_id, t.kind, btrim(t.name) AS name, t.created_at,
			coalesce(nullif(regexp_replace(lower(t.name), '[^a-z0-9]', '', 'g'), ''), lower(btrim(t.name))) AS k
		FROM tenders t;
	CREATE TEMP TABLE t629_seed (name text, kind text, sort_order integer, k text) ON COMMIT DROP;
	INSERT INTO t629_seed (name, kind, sort_order, k) VALUES
		('Cash', 'cash', 10, 'cash'), ('GCash', 'wallet', 20, 'gcash'), ('Maya', 'wallet', 30, 'maya'),
		('QRPH', 'wallet', 40, 'qrph'), ('Credit card', 'wallet', 50, 'creditcard'), ('Debit card', 'wallet', 60, 'debitcard');

	SELECT g.store_id, min(g.name) AS n INTO bad FROM t629_keys g GROUP BY g.org_id, g.store_id, g.k HAVING count(*) > 1 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'T-629 STOP: store % holds two tenders (for example "%") that map to ONE payment option. Report to BOSS; nothing was changed.', bad.store_id, bad.n;
	END IF;
	SELECT g.org_id, min(g.name) AS n INTO bad FROM t629_keys g GROUP BY g.org_id, g.k HAVING count(DISTINCT g.kind) > 1 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'T-629 STOP: org % has tenders named like "%" that are cash at one store and a wallet at another. Report to BOSS; nothing was changed.', bad.org_id, bad.n;
	END IF;
	SELECT g.org_id, min(g.name) AS n INTO bad FROM t629_keys g JOIN t629_seed s ON s.k = g.k AND s.kind <> g.kind GROUP BY g.org_id LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'T-629 STOP: org % holds a tender "%" with the wrong kind for the payment option of that name. Report to BOSS; nothing was changed.', bad.org_id, bad.n;
	END IF;
	SELECT g.org_id, string_agg(DISTINCT g.name, ', ') AS n INTO bad FROM t629_keys g WHERE g.kind = 'cash' GROUP BY g.org_id HAVING count(DISTINCT g.k) > 1 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'T-629 STOP: org % holds cash tenders under more than one name (%); there is one cash option per org. Report to BOSS; nothing was changed.', bad.org_id, bad.n;
	END IF;

	INSERT INTO payment_options (org_id, name, kind, sort_order)
	SELECT g.org_id, coalesce(s.name, left(g.name, 40)), g.kind, coalesce(s.sort_order, 100)
	FROM (SELECT DISTINCT ON (x.org_id, x.k) x.org_id, x.k, x.kind, x.name FROM t629_keys x ORDER BY x.org_id, x.k, x.created_at, x.id) g
	LEFT JOIN t629_seed s ON s.k = g.k;

	INSERT INTO payment_options (org_id, name, kind, sort_order)
	SELECT o.id, s.name, s.kind, s.sort_order
	FROM organizations o CROSS JOIN t629_seed s
	WHERE NOT EXISTS (SELECT 1 FROM payment_options p WHERE p.org_id = o.id AND regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = s.k)
		AND (s.kind <> 'cash' OR NOT EXISTS (SELECT 1 FROM payment_options p WHERE p.org_id = o.id AND p.kind = 'cash'));

	UPDATE tenders t SET payment_option_id = p.id, name = p.name
	FROM t629_keys g JOIN payment_options p ON p.org_id = g.org_id
		AND coalesce(nullif(regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g'), ''), lower(btrim(p.name))) = g.k
	WHERE t.id = g.id;
END;
$do$;
--> statement-breakpoint

ALTER TABLE "tenders" ALTER COLUMN "payment_option_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_payment_option_same_org_fk"
	FOREIGN KEY ("org_id","payment_option_id") REFERENCES "payment_options"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_store_payment_option_unique" UNIQUE ("store_id","payment_option_id");
--> statement-breakpoint

-- tenders: name and kind come from the option
CREATE FUNCTION "tenders_mirror_option"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	o record;
	k text;
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.payment_option_id IS DISTINCT FROM OLD.payment_option_id THEN
		RAISE EXCEPTION 'A store tender stays on its payment option (tender %).', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.payment_option_id IS NULL THEN
		-- raw SQL and old fixtures: match by normalised name, or make the option (the domain always names one)
		k := coalesce(nullif(regexp_replace(lower(NEW.name), '[^a-z0-9]', '', 'g'), ''), lower(btrim(NEW.name)));
		SELECT p.* INTO o FROM payment_options p WHERE p.org_id = NEW.org_id
			AND coalesce(nullif(regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g'), ''), lower(btrim(p.name))) = k;
		IF NOT FOUND THEN
			INSERT INTO payment_options (org_id, name, kind, sort_order) VALUES (NEW.org_id, left(btrim(NEW.name), 40), NEW.kind, 100) RETURNING * INTO o;
		ELSIF o.kind <> NEW.kind THEN
			RAISE EXCEPTION 'The payment option "%" is % and a tender cannot be % (tender %).', o.name, o.kind, NEW.kind, NEW.id USING ERRCODE = 'check_violation';
		END IF;
		NEW.payment_option_id := o.id;
	END IF;
	SELECT p.* INTO o FROM payment_options p WHERE p.org_id = NEW.org_id AND p.id = NEW.payment_option_id FOR SHARE;
	IF NOT FOUND THEN
		RETURN NEW; -- the composite FK raises
	END IF;
	IF NEW.is_active AND o.status = 'retired' AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
		RAISE EXCEPTION 'The payment option "%" is retired and cannot be switched on.', o.name USING ERRCODE = 'restrict_violation';
	END IF;
	NEW.name := o.name;
	NEW.kind := o.kind;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "tenders_mirror_option"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "tenders_mirror_option" BEFORE INSERT OR UPDATE ON "tenders" FOR EACH ROW EXECUTE FUNCTION "tenders_mirror_option"();
--> statement-breakpoint

-- payment_options: the kind and the retire rules
CREATE FUNCTION "payment_options_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
		RAISE EXCEPTION 'A payment option never changes organisation (%).', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (SELECT 1 FROM tenders t WHERE t.payment_option_id = OLD.id) THEN
		RAISE EXCEPTION 'The payment option "%" is used by a store, so it cannot change between cash and wallet.', OLD.name USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.status = 'retired' AND OLD.status <> 'retired' AND EXISTS (SELECT 1 FROM tenders t WHERE t.payment_option_id = OLD.id AND t.is_active) THEN
		RAISE EXCEPTION 'The payment option "%" is switched on at a store, so it cannot be retired.', OLD.name USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "payment_options_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "payment_options_guard" BEFORE UPDATE ON "payment_options" FOR EACH ROW EXECUTE FUNCTION "payment_options_guard"();
--> statement-breakpoint
CREATE FUNCTION "payment_options_rename_tenders"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	UPDATE tenders t SET name = NEW.name WHERE t.org_id = NEW.org_id AND t.payment_option_id = NEW.id AND t.name IS DISTINCT FROM NEW.name;
	RETURN NULL;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "payment_options_rename_tenders"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "payment_options_rename_tenders" AFTER UPDATE OF "name" ON "payment_options" FOR EACH ROW EXECUTE FUNCTION "payment_options_rename_tenders"();
--> statement-breakpoint

-- RLS and grants
ALTER TABLE "payment_options" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_options" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "payment_options_org_isolation" ON "payment_options" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT ON "payment_options" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("name","kind","sort_order","status","updated_at") ON "payment_options" TO "shareat_app";
