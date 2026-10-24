-- 0217 - T-455 S1: the customer lobby tables (lobby_stores, lobby_entries, lobby_entry_lines, lobby_birthday_requests, lobby_discount_claims).
-- docs/tasks/455-customer-lobby.md section 2 + "Ian's answers (2026-10-24)". Hand-authored per ADR-012 s5. Journal head when written: 0214
-- (0215 is POS, 0216 is T-475; this file is 0217 by the orchestrator's assignment).
--
-- WHY. A party arriving at the gate checks itself in on its phone and gets a 4-digit booking code and a live place in line; it may ask for the
-- birthday song and may type a senior/PWD claim that the cashier approves. Five new tables, all born in Postgres (RULES #4), all carrying their own
-- org_id (RLS scope org_column) and composite (org_id, x) same-org FKs from birth (T-398), so none is listed in same-org-fk-exemptions.
--
-- WHAT THE DATABASE ENFORCES (the rest is domain code, S2+):
--   * lobby_entries: party 1-30, name 1-40 (NULL only once the entry is closed: the nightly purge), note <= 60, code ^[1-9][0-9]{3}$, phone only when
--     source = 'staff', 'seated' needs session_ref + stand_label. Partial UNIQUE (store_id, code) and (store_id, device_hash) over LIVE entries
--     (waiting, called) so a closed entry frees both; UNIQUE (store_id, client_request_id) is the idempotency key. Trigger lobby_entries_forward_only:
--     waiting -> called | seated | cancelled | removed | expired, called -> seated | cancelled | removed | expired, terminal states never change;
--     code / store_id / source / org_id / id are frozen; device_hash may only go to NULL. On a TERMINAL entry the purge columns (display_name, phone,
--     note, device_hash, ip_hash, handoff_url, handoff_expires_at) may be set to NULL and nothing else may change.
--   * lobby_birthday_requests: one request per entry unless cancelled (partial UNIQUE). scheduled_at is NULL until the cashier accepts and is KEPT
--     afterwards (accepted -> played | expired | cancelled keep it); accepted_at records the acceptance and CHECK (scheduled_at IS NULL) = (accepted_at IS NULL).
--     The trigger stamps accepted_at = now() when a row becomes accepted without one. requested -> accepted | declined | expired | cancelled,
--     accepted -> played | expired | cancelled; declined / played / expired / cancelled are frozen (celebrant_name may go to NULL: the purge).
--   * lobby_discount_claims: holder_name and id_number exist only while status = 'pending' (NOT NULL then, NULL after: row 353, the app "documents it"
--     with id_last4, outcome, who and when); card_seen_at IS NOT NULL exactly when approved; approved needs session_ref, statutory_diner_ref and the
--     approving person. pending -> approved | rejected | expired, the rest frozen. Trigger lobby_discount_claims_cap: pending + approved claims of an
--     entry never exceed its party_size (the entry row is locked FOR UPDATE so two inserts cannot both pass).
--   * No photo, no bytea, no price column anywhere (Ian, 24 Oct: no card photo is kept; the phone never prices).
--   * lobby_stores is keyed (org_id, store_id) and carries the per-store switches; its max_live_entries defaults to 60.
--   * lobby_entry_line_options (org_id, line_id, option_value_id): the flavours / options of one pre-order line, one row each (replaces an array column).
--   * lobby_entries: handoff_url and handoff_expires_at are both set or both NULL.
-- Trigger classes (triggers/registry.ts): the three forward-only triggers decide only from OLD/NEW and refuse a rewrite of a closed row, so they are
-- history_guard / ENABLE ALWAYS (registry rule R1); lobby_discount_claims_cap counts other rows and stays validator / origin. A birthday request is
-- INSERTed only in state requested; the trigger stamps accepted_at = now() on requested -> accepted and ignores any caller-supplied value.
--
-- GRANTS. shareat_app gets SELECT, INSERT, UPDATE on all five (a purge only NULLs columns; the cutover purge runs as the owner); no DELETE.
-- RLS. ENABLE + FORCE, one org-isolation policy through app_current_org() with WITH CHECK (DEF-183).
--
-- LOCK BUDGET (ADR-012 s5).
--   * First statement: SET LOCAL lock_timeout = '5s' (resets at commit). A deploy that hits it is re-run, never edited.
--   * Lock mode: the composite FKs added from the new tables to the existing tables stores, persons and menu_item_variants take SHARE ROW EXCLUSIVE
--     on each of them (and so do the org_id FKs on organizations, and the option FK on menu_option_values) (conflicts with writes, not with reads) until COMMIT; drizzle applies pending migrations in ONE transaction. Nothing existing
--     is rewritten or scanned: the five tables are new and empty, so each FK validation scans zero rows.
--   * Budget: 0.87 s end to end (drizzle migrate of 0217 alone, one transaction) on a local PG 18 scratch database at the full 0214 schema; the ceiling is 60 s (D8).
--     Re-time on a restore before the deploy if the stores / persons / menu_item_variants tables have grown a long-running writer.
--
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "lobby_stores" (
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"max_live_entries" integer DEFAULT 60 NOT NULL,
	"birthday_enabled" boolean DEFAULT true NOT NULL,
	"claims_enabled" boolean DEFAULT true NOT NULL,
	"pos_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "lobby_stores_pkey" PRIMARY KEY ("org_id", "store_id"),
	CONSTRAINT "lobby_stores_max_live_entries_check" CHECK ("max_live_entries" BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "lobby_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"display_name" text,
	"party_size" integer NOT NULL,
	"note" text,
	"phone" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"device_hash" text,
	"ip_hash" text,
	"client_request_id" text,
	"session_ref" text,
	"stand_label" text,
	"handoff_url" text,
	"handoff_expires_at" timestamp with time zone,
	"called_at" timestamp with time zone,
	"seated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"acted_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lobby_entries_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "lobby_entries_source_check" CHECK ("source" IN ('lobby','staff')),
	CONSTRAINT "lobby_entries_status_check" CHECK ("status" IN ('waiting','called','seated','cancelled','removed','expired')),
	CONSTRAINT "lobby_entries_party_size_check" CHECK ("party_size" BETWEEN 1 AND 30),
	CONSTRAINT "lobby_entries_code_check" CHECK ("code" ~ '^[1-9][0-9]{3}$'),
	CONSTRAINT "lobby_entries_display_name_check" CHECK (coalesce(char_length("display_name") BETWEEN 1 AND 40, "status" IN ('seated','cancelled','removed','expired'))),
	CONSTRAINT "lobby_entries_handoff_pair_check" CHECK (("handoff_url" IS NULL) = ("handoff_expires_at" IS NULL)),
	CONSTRAINT "lobby_entries_note_check" CHECK ("note" IS NULL OR char_length("note") <= 60),
	CONSTRAINT "lobby_entries_phone_staff_only_check" CHECK ("phone" IS NULL OR "source" = 'staff'),
	CONSTRAINT "lobby_entries_seated_needs_session_check" CHECK ("status" <> 'seated' OR ("session_ref" IS NOT NULL AND "stand_label" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lobby_entry_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"line_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lobby_entry_lines_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "lobby_entry_lines_qty_check" CHECK ("qty" BETWEEN 1 AND 20),
	CONSTRAINT "lobby_entry_lines_line_kind_check" CHECK ("line_kind" IN ('package','a_la_carte'))
);
--> statement-breakpoint
CREATE TABLE "lobby_entry_line_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"option_value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lobby_entry_line_options_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "lobby_entry_line_options_line_value_unique" UNIQUE ("line_id", "option_value_id")
);
--> statement-breakpoint
CREATE TABLE "lobby_birthday_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"celebrant_name" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"decline_reason" text,
	"played_at" timestamp with time zone,
	"acted_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lobby_birthday_requests_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "lobby_birthday_requests_status_check" CHECK ("status" IN ('requested','accepted','declined','played','expired','cancelled')),
	CONSTRAINT "lobby_birthday_requests_celebrant_name_check" CHECK ("celebrant_name" IS NULL OR char_length("celebrant_name") <= 40),
	CONSTRAINT "lobby_birthday_requests_accepted_shape_check" CHECK (("scheduled_at" IS NULL) = ("accepted_at" IS NULL)),
	CONSTRAINT "lobby_birthday_requests_status_time_check" CHECK (CASE WHEN "status" IN ('accepted','played') THEN "scheduled_at" IS NOT NULL WHEN "status" IN ('requested','declined') THEN "scheduled_at" IS NULL ELSE true END),
	CONSTRAINT "lobby_birthday_requests_played_check" CHECK (("status" = 'played') = ("played_at" IS NOT NULL)),
	CONSTRAINT "lobby_birthday_requests_decline_reason_check" CHECK (CASE WHEN "status" = 'declined' THEN "decline_reason" IS NOT NULL ELSE "decline_reason" IS NULL END)
);
--> statement-breakpoint
CREATE TABLE "lobby_discount_claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"holder_name" text,
	"id_number" text,
	"id_last4" text NOT NULL,
	"ocr_assisted" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"session_ref" text,
	"statutory_diner_ref" text,
	"reject_reason" text,
	"acted_by_person_id" uuid,
	"card_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "lobby_discount_claims_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "lobby_discount_claims_kind_check" CHECK ("kind" IN ('senior','pwd')),
	CONSTRAINT "lobby_discount_claims_status_check" CHECK ("status" IN ('pending','approved','rejected','expired')),
	CONSTRAINT "lobby_discount_claims_last4_check" CHECK (char_length("id_last4") BETWEEN 1 AND 4),
	CONSTRAINT "lobby_discount_claims_personal_data_check" CHECK (CASE WHEN "status" = 'pending' THEN coalesce(char_length("holder_name") BETWEEN 1 AND 40 AND char_length("id_number") BETWEEN 1 AND 40, false) ELSE "holder_name" IS NULL AND "id_number" IS NULL END),
	CONSTRAINT "lobby_discount_claims_card_seen_check" CHECK (("status" = 'approved') = ("card_seen_at" IS NOT NULL)),
	CONSTRAINT "lobby_discount_claims_approved_shape_check" CHECK ("status" <> 'approved' OR ("session_ref" IS NOT NULL AND "statutory_diner_ref" IS NOT NULL AND "acted_by_person_id" IS NOT NULL)),
	CONSTRAINT "lobby_discount_claims_rejected_reason_check" CHECK ("status" <> 'rejected' OR "reject_reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "lobby_stores" ADD CONSTRAINT "lobby_stores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_stores" ADD CONSTRAINT "lobby_stores_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entries" ADD CONSTRAINT "lobby_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entries" ADD CONSTRAINT "lobby_entries_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entries" ADD CONSTRAINT "lobby_entries_acted_by_person_id_same_org_fk" FOREIGN KEY ("org_id", "acted_by_person_id") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entry_lines" ADD CONSTRAINT "lobby_entry_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entry_lines" ADD CONSTRAINT "lobby_entry_lines_entry_id_same_org_fk" FOREIGN KEY ("org_id", "entry_id") REFERENCES "public"."lobby_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entry_lines" ADD CONSTRAINT "lobby_entry_lines_variant_id_same_org_fk" FOREIGN KEY ("org_id", "variant_id") REFERENCES "public"."menu_item_variants"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entry_line_options" ADD CONSTRAINT "lobby_entry_line_options_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entry_line_options" ADD CONSTRAINT "lobby_entry_line_options_line_id_same_org_fk" FOREIGN KEY ("org_id", "line_id") REFERENCES "public"."lobby_entry_lines"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_entry_line_options" ADD CONSTRAINT "lobby_entry_line_options_option_value_id_same_org_fk" FOREIGN KEY ("org_id", "option_value_id") REFERENCES "public"."menu_option_values"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_birthday_requests" ADD CONSTRAINT "lobby_birthday_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_birthday_requests" ADD CONSTRAINT "lobby_birthday_requests_entry_id_same_org_fk" FOREIGN KEY ("org_id", "entry_id") REFERENCES "public"."lobby_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_birthday_requests" ADD CONSTRAINT "lobby_birthday_requests_acted_by_person_id_same_org_fk" FOREIGN KEY ("org_id", "acted_by_person_id") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_discount_claims" ADD CONSTRAINT "lobby_discount_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_discount_claims" ADD CONSTRAINT "lobby_discount_claims_entry_id_same_org_fk" FOREIGN KEY ("org_id", "entry_id") REFERENCES "public"."lobby_entries"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lobby_discount_claims" ADD CONSTRAINT "lobby_discount_claims_acted_by_person_id_same_org_fk" FOREIGN KEY ("org_id", "acted_by_person_id") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "lobby_entries_live_code_unique" ON "lobby_entries" ("store_id", "code") WHERE "status" IN ('waiting','called');
--> statement-breakpoint
CREATE UNIQUE INDEX "lobby_entries_live_device_unique" ON "lobby_entries" ("store_id", "device_hash") WHERE "status" IN ('waiting','called');
--> statement-breakpoint
CREATE UNIQUE INDEX "lobby_entries_client_request_unique" ON "lobby_entries" ("store_id", "client_request_id");
--> statement-breakpoint
CREATE INDEX "lobby_entries_org_store_status_idx" ON "lobby_entries" ("org_id", "store_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "lobby_entry_lines_entry_idx" ON "lobby_entry_lines" ("entry_id");
--> statement-breakpoint
CREATE INDEX "lobby_entry_line_options_option_value_idx" ON "lobby_entry_line_options" ("option_value_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "lobby_birthday_requests_live_entry_unique" ON "lobby_birthday_requests" ("entry_id") WHERE "status" <> 'cancelled';
--> statement-breakpoint
CREATE INDEX "lobby_discount_claims_entry_idx" ON "lobby_discount_claims" ("entry_id");
--> statement-breakpoint
CREATE FUNCTION lobby_entries_forward_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	exempt text[] := ARRAY['display_name','phone','note','device_hash','ip_hash','handoff_url','handoff_expires_at'];
	o jsonb := to_jsonb(OLD);
	n jsonb := to_jsonb(NEW);
	k text;
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.store_id IS DISTINCT FROM OLD.store_id
	   OR NEW.source IS DISTINCT FROM OLD.source OR NEW.code IS DISTINCT FROM OLD.code THEN
		RAISE EXCEPTION 'T-455: lobby_entries id, org_id, store_id, source and code are frozen' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.device_hash IS NOT NULL AND NEW.device_hash IS DISTINCT FROM OLD.device_hash THEN
		RAISE EXCEPTION 'T-455: lobby_entries.device_hash is frozen (it may only be set to NULL)' USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status IN ('seated','cancelled','removed','expired') THEN
		IF NEW.status <> OLD.status THEN
			RAISE EXCEPTION 'T-455: a % lobby entry is terminal and cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
		END IF;
		IF (o - exempt) <> (n - exempt) THEN
			RAISE EXCEPTION 'T-455: a % lobby entry is frozen; only the personal columns may be set to NULL', OLD.status USING ERRCODE = 'check_violation';
		END IF;
		FOREACH k IN ARRAY exempt LOOP
			IF (n -> k) IS DISTINCT FROM (o -> k) AND jsonb_typeof(n -> k) <> 'null' THEN
				RAISE EXCEPTION 'T-455: lobby_entries.% on a closed entry may only be set to NULL', k USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;
	ELSIF NEW.status <> OLD.status THEN
		IF NOT ((OLD.status = 'waiting' AND NEW.status IN ('called','seated','cancelled','removed','expired'))
		     OR (OLD.status = 'called' AND NEW.status IN ('seated','cancelled','removed','expired'))) THEN
			RAISE EXCEPTION 'T-455: lobby entry status cannot move % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION lobby_birthday_requests_forward_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'requested' THEN
			RAISE EXCEPTION 'T-455: a birthday request is born in state requested, not %', NEW.status USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.entry_id IS DISTINCT FROM OLD.entry_id THEN
		RAISE EXCEPTION 'T-455: lobby_birthday_requests id, org_id and entry_id are frozen' USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.scheduled_at IS NOT NULL AND (NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at) THEN
		RAISE EXCEPTION 'T-455: a birthday request keeps the time it was accepted for' USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status IN ('declined','played','expired','cancelled') THEN
		IF NEW.status <> OLD.status OR (to_jsonb(OLD) - 'celebrant_name') <> (to_jsonb(NEW) - 'celebrant_name')
		   OR (NEW.celebrant_name IS NOT NULL AND NEW.celebrant_name IS DISTINCT FROM OLD.celebrant_name) THEN
			RAISE EXCEPTION 'T-455: a % birthday request is terminal (only celebrant_name may be set to NULL)', OLD.status USING ERRCODE = 'check_violation';
		END IF;
	ELSIF NEW.status <> OLD.status THEN
		IF NOT ((OLD.status = 'requested' AND NEW.status IN ('accepted','declined','expired','cancelled'))
		     OR (OLD.status = 'accepted' AND NEW.status IN ('played','expired','cancelled'))) THEN
			RAISE EXCEPTION 'T-455: birthday request status cannot move % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	IF OLD.status = 'requested' THEN
		IF NEW.status = 'accepted' THEN
			NEW.accepted_at := now(); -- always the server clock; a caller-supplied value is ignored
		ELSIF NEW.scheduled_at IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN
			RAISE EXCEPTION 'T-455: only an accepted birthday request carries a scheduled time' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION lobby_discount_claims_forward_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
	   OR NEW.kind IS DISTINCT FROM OLD.kind THEN
		RAISE EXCEPTION 'T-455: lobby_discount_claims id, org_id, entry_id and kind are frozen' USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status <> 'pending' AND to_jsonb(OLD) <> to_jsonb(NEW) THEN
		RAISE EXCEPTION 'T-455: a % discount claim is terminal and cannot change', OLD.status USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION lobby_discount_claims_cap() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	party integer;
	taken integer;
BEGIN
	SELECT party_size INTO party FROM lobby_entries WHERE org_id = NEW.org_id AND id = NEW.entry_id FOR UPDATE;
	IF party IS NULL THEN
		RETURN NEW; -- the composite FK refuses a missing or other-org entry
	END IF;
	SELECT count(*) INTO taken FROM lobby_discount_claims WHERE entry_id = NEW.entry_id AND status IN ('pending','approved');
	IF taken >= party THEN
		RAISE EXCEPTION 'T-455: this lobby entry already has % discount claims (its party size)', taken USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION lobby_entries_forward_only() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION lobby_birthday_requests_forward_only() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION lobby_discount_claims_forward_only() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION lobby_discount_claims_cap() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "lobby_entries_forward_only" BEFORE UPDATE ON "lobby_entries" FOR EACH ROW EXECUTE FUNCTION lobby_entries_forward_only();
--> statement-breakpoint
CREATE TRIGGER "lobby_birthday_requests_forward_only" BEFORE INSERT OR UPDATE ON "lobby_birthday_requests" FOR EACH ROW EXECUTE FUNCTION lobby_birthday_requests_forward_only();
--> statement-breakpoint
CREATE TRIGGER "lobby_discount_claims_forward_only" BEFORE UPDATE ON "lobby_discount_claims" FOR EACH ROW EXECUTE FUNCTION lobby_discount_claims_forward_only();
--> statement-breakpoint
CREATE TRIGGER "lobby_discount_claims_cap" BEFORE INSERT ON "lobby_discount_claims" FOR EACH ROW EXECUTE FUNCTION lobby_discount_claims_cap();
--> statement-breakpoint
ALTER TABLE "lobby_entries" ENABLE ALWAYS TRIGGER "lobby_entries_forward_only";
--> statement-breakpoint
ALTER TABLE "lobby_birthday_requests" ENABLE ALWAYS TRIGGER "lobby_birthday_requests_forward_only";
--> statement-breakpoint
ALTER TABLE "lobby_discount_claims" ENABLE ALWAYS TRIGGER "lobby_discount_claims_forward_only";
--> statement-breakpoint
ALTER TABLE "lobby_entry_line_options" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lobby_entry_line_options" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lobby_entry_line_options_org_isolation" ON "lobby_entry_line_options"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "lobby_stores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lobby_stores" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lobby_stores_org_isolation" ON "lobby_stores"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "lobby_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lobby_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lobby_entries_org_isolation" ON "lobby_entries"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "lobby_entry_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lobby_entry_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lobby_entry_lines_org_isolation" ON "lobby_entry_lines"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "lobby_birthday_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lobby_birthday_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lobby_birthday_requests_org_isolation" ON "lobby_birthday_requests"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "lobby_discount_claims" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lobby_discount_claims" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "lobby_discount_claims_org_isolation" ON "lobby_discount_claims"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "lobby_stores", "lobby_entries", "lobby_entry_lines", "lobby_entry_line_options", "lobby_birthday_requests", "lobby_discount_claims" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "lobby_stores", "lobby_entries", "lobby_entry_lines", "lobby_entry_line_options", "lobby_birthday_requests", "lobby_discount_claims" TO "shareat_app";
