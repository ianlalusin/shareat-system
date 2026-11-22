-- 0276 - T-628: table reservations with deposits on POS v2. docs/tasks/628-pos-reservations-deposits.md; hand-authored per ADR-012 s5.
-- Journal idx 276, `when` = 0275's + 86400000 (one day per index).
--
-- WHY. v1 holds a table for a customer and takes money in advance (29 reservations ever, 4 with a deposit), but the deposit is invisible on the day it is taken, can be
-- voided by anyone after it was used, and a cancelled or no-show reservation leaves the money undecided. Ian, 22 Nov: build it before go-live; on cancel / no-show the
-- manager decides each time (refund or keep). Bible row 463: voiding a deposit needs the manager PIN and is refused once applied.
--
-- WHAT IT ADDS
--   pos_reservations              a held table: name, phone, party size, time, optional stand, note, status (booked / seated / cancelled / no_show / closed). PURGE.
--   pos_reservation_deposits      the APPEND-ONLY events of the money held for one reservation: taken / voided / applied / refunded / kept. The balance is derived from them
--                                 (taken - voided - applied - refunded - kept), never stored. PURGE. The Z collects the cash-moving events through day_close_id (set once), as a Convert.
--   pos_sales_receipts.deposit_applied   numeric(14,2) NOT NULL DEFAULT 0, >= 0: the part of the bill paid from a held deposit. Frozen from insert by the existing receipt trigger.
--   sales_days.deposits_applied   numeric(14,2) NOT NULL DEFAULT 0, >= 0, only on a source = 'pos_receipts' day: the deposits the Z applied; routeSalesDay debits 2170 for it
--                                 (a tender of the sale). The figure-lock trigger function is re-created with the new column in its frozen list (every other line is 0247's, verbatim).
--   accounts 2170                 "Customer deposits payable", a store-level liability (type liability, credit-normal, postable, no party), for every org that has a chart.
--
-- TRIGGERS (3, all history guards, ENABLE ALWAYS, SET search_path = public, pg_temp, EXECUTE revoked from PUBLIC; triggers/registry.ts):
--   pos_reservations_guard                 INSERT only as booked; UPDATE: only status / stand_id / session_id / updated_at / closed_at move, session_id once; statuses move forward
--                                          only (booked -> seated | cancelled | no_show, seated -> cancelled | closed, cancelled | no_show -> closed); CLOSING needs a zero held balance (so a
--                                          cancelled or no-show reservation with money held cannot close without a refund or a keep); DELETE refused.
--   pos_reservation_deposits_frozen        every column frozen except day_close_id (once); DELETE refused (the existing pos_v2_frozen_except_once).
--   pos_reservation_deposits_guard         BEFORE INSERT, under a row lock on the reservation: a deposit is taken only on a booked or seated reservation; nothing leaves more than is
--                                          held; a VOID is refused once any deposit of the reservation was applied, and must name the deposit it voids (same amount and method);
--                                          an apply needs a seated reservation.
-- INDEXES that carry rules: applied once per reservation and once per receipt (consume-once), a taken deposit voided once.
--
-- GRANTS (ADR-012 s5 4a). shareat_app: SELECT, INSERT on both; UPDATE only (status, stand_id, session_id, updated_at, closed_at) on pos_reservations and (day_close_id) on
-- pos_reservation_deposits; never DELETE. RLS: ENABLE + FORCE, one <t>_org_isolation policy through app_current_org() (DEF-077) with WITH CHECK (DEF-183).
-- CUTOVER: both purge (pilot data, row 436); deposits held on 1 January are counted in the opening balance by hand.
--
-- LOCK BUDGET. First statement SET LOCAL lock_timeout = '5s'. Two new empty tables; two ADD COLUMN with a constant default (no rewrite) plus their CHECKs on small tables;
-- one CREATE OR REPLACE FUNCTION; one INSERT per org. Every statement is its own breakpoint; the last closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE "pos_reservations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_name" text NOT NULL,
	"phone" text,
	"party_size" integer NOT NULL,
	"reserved_for" timestamp with time zone NOT NULL,
	"stand_id" uuid,
	"note" text,
	"status" text DEFAULT 'booked' NOT NULL,
	"session_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at_device" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "pos_reservations_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_reservations_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "pos_reservations_name_check" CHECK (length(btrim("customer_name")) BETWEEN 1 AND 60),
	CONSTRAINT "pos_reservations_phone_check" CHECK ("phone" IS NULL OR length(btrim("phone")) BETWEEN 3 AND 30),
	CONSTRAINT "pos_reservations_party_size_check" CHECK ("party_size" BETWEEN 1 AND 500),
	CONSTRAINT "pos_reservations_note_check" CHECK ("note" IS NULL OR length(btrim("note")) BETWEEN 1 AND 200),
	CONSTRAINT "pos_reservations_status_check" CHECK ("status" IN ('booked','seated','cancelled','no_show','closed')),
	CONSTRAINT "pos_reservations_closed_shape_check" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)),
	CONSTRAINT "pos_reservations_seated_session_check" CHECK ("status" <> 'seated' OR "session_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "pos_reservation_deposits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"tender_id" uuid,
	"reference_no" text,
	"terminal_id" uuid,
	"receipt_id" uuid,
	"voids_deposit_id" uuid,
	"reason" text,
	"recorded_by" uuid NOT NULL,
	"approved_by" uuid,
	"occurred_at_device" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"day_close_id" uuid,
	CONSTRAINT "pos_reservation_deposits_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_reservation_deposits_reservation_id_id_unique" UNIQUE ("reservation_id","id"),
	CONSTRAINT "pos_reservation_deposits_kind_check" CHECK ("kind" IN ('taken','voided','applied','refunded','kept')),
	CONSTRAINT "pos_reservation_deposits_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "pos_reservation_deposits_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric),
	CONSTRAINT "pos_reservation_deposits_reference_no_check" CHECK ("reference_no" IS NULL OR length("reference_no") BETWEEN 4 AND 40),
	CONSTRAINT "pos_reservation_deposits_reason_check" CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 200),
	CONSTRAINT "pos_reservation_deposits_kind_shape_check" CHECK (
		("kind" = 'taken'    AND "tender_id" IS NOT NULL AND "terminal_id" IS NOT NULL AND "receipt_id" IS NULL     AND "voids_deposit_id" IS NULL     AND "reason" IS NULL     AND "approved_by" IS NULL)
		OR ("kind" = 'voided'   AND "tender_id" IS NOT NULL AND "terminal_id" IS NOT NULL AND "receipt_id" IS NULL     AND "voids_deposit_id" IS NOT NULL AND "reason" IS NOT NULL AND "approved_by" IS NOT NULL)
		OR ("kind" = 'applied'  AND "tender_id" IS NULL     AND "terminal_id" IS NULL     AND "receipt_id" IS NOT NULL AND "voids_deposit_id" IS NULL     AND "reason" IS NULL     AND "approved_by" IS NULL     AND "reference_no" IS NULL AND "day_close_id" IS NULL)
		OR ("kind" = 'refunded' AND "tender_id" IS NOT NULL AND "terminal_id" IS NOT NULL AND "receipt_id" IS NULL     AND "voids_deposit_id" IS NULL     AND "reason" IS NOT NULL AND "approved_by" IS NOT NULL)
		OR ("kind" = 'kept'     AND "tender_id" IS NULL     AND "terminal_id" IS NOT NULL AND "receipt_id" IS NULL     AND "voids_deposit_id" IS NULL     AND "reason" IS NOT NULL AND "approved_by" IS NOT NULL AND "reference_no" IS NULL)
	)
);
--> statement-breakpoint

-- the new columns on existing tables
ALTER TABLE "pos_sales_receipts" ADD COLUMN "deposit_applied" numeric(14,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_deposit_applied_check" CHECK ("deposit_applied" >= 0);
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_deposit_applied_finite_check" CHECK ("deposit_applied" > '-Infinity'::numeric AND "deposit_applied" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "sales_days" ADD COLUMN "deposits_applied" numeric(14,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_deposits_applied_check" CHECK ("deposits_applied" >= 0);
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_deposits_applied_finite_check" CHECK ("deposits_applied" > '-Infinity'::numeric AND "deposits_applied" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_deposits_only_on_pos_receipts_check" CHECK ("source" = 'pos_receipts' OR "deposits_applied" = 0);
--> statement-breakpoint

-- pos_reservations
ALTER TABLE "pos_reservations" ADD CONSTRAINT "pos_reservations_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservations" ADD CONSTRAINT "pos_reservations_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservations" ADD CONSTRAINT "pos_reservations_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservations" ADD CONSTRAINT "pos_reservations_stand_same_store_fk"
	FOREIGN KEY ("store_id","stand_id") REFERENCES "pos_stands"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservations" ADD CONSTRAINT "pos_reservations_session_same_store_fk"
	FOREIGN KEY ("store_id","session_id") REFERENCES "table_sessions"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservations" ADD CONSTRAINT "pos_reservations_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservations" ADD CONSTRAINT "pos_reservations_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_reservation_deposits
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_reservation_same_store_fk"
	FOREIGN KEY ("store_id","reservation_id") REFERENCES "pos_reservations"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_tender_id_fk"
	FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_tender_id_same_org_fk"
	FOREIGN KEY ("org_id","tender_id") REFERENCES "tenders"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_terminal_same_store_fk"
	FOREIGN KEY ("store_id","terminal_id") REFERENCES "pos_terminals"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_receipt_same_store_fk"
	FOREIGN KEY ("store_id","receipt_id") REFERENCES "pos_sales_receipts"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_voids_same_reservation_fk"
	FOREIGN KEY ("reservation_id","voids_deposit_id") REFERENCES "pos_reservation_deposits"("reservation_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_day_close_same_store_fk"
	FOREIGN KEY ("store_id","day_close_id") REFERENCES "pos_day_closes"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_recorded_by_fk"
	FOREIGN KEY ("recorded_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_recorded_by_same_org_fk"
	FOREIGN KEY ("org_id","recorded_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_approved_by_fk"
	FOREIGN KEY ("approved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ADD CONSTRAINT "pos_reservation_deposits_approved_by_same_org_fk"
	FOREIGN KEY ("org_id","approved_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint

-- indexes (the three partial uniques ARE rules: consume-once per reservation and per receipt, a taken deposit voided once)
CREATE INDEX "pos_reservations_store_time_idx" ON "pos_reservations" ("store_id","reserved_for") WHERE "status" IN ('booked','seated');
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_reservations_session_key" ON "pos_reservations" ("session_id") WHERE "session_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pos_reservation_deposits_reservation_idx" ON "pos_reservation_deposits" ("reservation_id");
--> statement-breakpoint
CREATE INDEX "pos_reservation_deposits_open_idx" ON "pos_reservation_deposits" ("store_id") WHERE "day_close_id" IS NULL AND "kind" <> 'applied';
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_reservation_deposits_applied_once_key" ON "pos_reservation_deposits" ("reservation_id") WHERE "kind" = 'applied';
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_reservation_deposits_receipt_once_key" ON "pos_reservation_deposits" ("receipt_id") WHERE "kind" = 'applied';
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_reservation_deposits_void_once_key" ON "pos_reservation_deposits" ("voids_deposit_id") WHERE "kind" = 'voided';
--> statement-breakpoint

-- the reservation guard
CREATE FUNCTION "pos_reservations_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	held numeric;
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'A reservation is never deleted (%).', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'booked' OR NEW.session_id IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
			RAISE EXCEPTION 'A reservation is written as booked.' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF to_jsonb(NEW) - ARRAY['status','stand_id','session_id','updated_at','closed_at'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','stand_id','session_id','updated_at','closed_at'] THEN
		RAISE EXCEPTION 'A reservation is frozen once written (only its status, stand and table move); reservation % is refused.', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.status = 'closed' THEN
		RAISE EXCEPTION 'A closed reservation never changes (%).', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id THEN
		RAISE EXCEPTION 'The table of a reservation is set once (%).', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status THEN
		IF NOT ((OLD.status = 'booked' AND NEW.status IN ('seated','cancelled','no_show'))
			OR (OLD.status = 'seated' AND NEW.status IN ('cancelled','closed'))
			OR (OLD.status IN ('cancelled','no_show') AND NEW.status = 'closed')) THEN
			RAISE EXCEPTION 'A reservation only moves forward; % -> % on reservation % is refused.', OLD.status, NEW.status, OLD.id USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.status = 'closed' THEN
			-- the money rule: nothing is closed while a deposit is still held (refund it or keep it first, with a reason)
			SELECT coalesce(sum(CASE WHEN d.kind = 'taken' THEN d.amount ELSE -d.amount END), 0) INTO held FROM "pos_reservation_deposits" d WHERE d.reservation_id = OLD.id;
			IF held <> 0 THEN
				RAISE EXCEPTION 'Reservation % still holds % of deposit: refund it or keep it, with a reason, before closing.', OLD.id, held USING ERRCODE = 'restrict_violation';
			END IF;
		END IF;
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_reservations_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "pos_reservation_deposits_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	r_status text;
	r_store uuid;
	held numeric;
	taken_row record;
BEGIN
	-- the reservation row lock serialises everything that moves this reservation's money
	SELECT r.status, r.store_id INTO r_status, r_store FROM "pos_reservations" r WHERE r.id = NEW.reservation_id FOR UPDATE OF r;
	IF NOT FOUND OR r_store IS DISTINCT FROM NEW.store_id THEN
		RAISE EXCEPTION 'Reservation % is not a reservation of this store.', NEW.reservation_id USING ERRCODE = 'foreign_key_violation';
	END IF;
	SELECT coalesce(sum(CASE WHEN d.kind = 'taken' THEN d.amount ELSE -d.amount END), 0) INTO held FROM "pos_reservation_deposits" d WHERE d.reservation_id = NEW.reservation_id;
	IF NEW.kind = 'taken' THEN
		IF r_status NOT IN ('booked','seated') THEN
			RAISE EXCEPTION 'A % reservation takes no deposit (reservation %).', r_status, NEW.reservation_id USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.kind = 'voided' AND EXISTS (SELECT 1 FROM "pos_reservation_deposits" d WHERE d.reservation_id = NEW.reservation_id AND d.kind = 'applied') THEN
		RAISE EXCEPTION 'A deposit that was applied to a bill cannot be voided (reservation %).', NEW.reservation_id USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.amount > held THEN
		RAISE EXCEPTION 'A deposit of % cannot leave a reservation that holds % (reservation %).', NEW.amount, held, NEW.reservation_id USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.kind = 'voided' THEN
		SELECT d.amount, d.tender_id INTO taken_row FROM "pos_reservation_deposits" d WHERE d.id = NEW.voids_deposit_id AND d.reservation_id = NEW.reservation_id AND d.kind = 'taken';
		IF NOT FOUND OR taken_row.amount <> NEW.amount OR taken_row.tender_id IS DISTINCT FROM NEW.tender_id THEN
			RAISE EXCEPTION 'A void names the deposit it voids, with that deposit''s amount and method (reservation %).', NEW.reservation_id USING ERRCODE = 'check_violation';
		END IF;
	ELSIF NEW.kind = 'applied' THEN
		IF r_status <> 'seated' THEN
			RAISE EXCEPTION 'A deposit is applied only to a seated reservation (reservation %, %).', NEW.reservation_id, r_status USING ERRCODE = 'restrict_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_reservation_deposits_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pos_reservations_guard" BEFORE INSERT OR UPDATE OR DELETE ON "pos_reservations" FOR EACH ROW EXECUTE FUNCTION "pos_reservations_guard"();
--> statement-breakpoint
CREATE TRIGGER "pos_reservation_deposits_frozen" BEFORE UPDATE OR DELETE ON "pos_reservation_deposits" FOR EACH ROW EXECUTE FUNCTION "pos_v2_frozen_except_once"('day_close_id');
--> statement-breakpoint
CREATE TRIGGER "pos_reservation_deposits_guard" BEFORE INSERT ON "pos_reservation_deposits" FOR EACH ROW EXECUTE FUNCTION "pos_reservation_deposits_guard"();
--> statement-breakpoint
ALTER TABLE "pos_reservations" ENABLE ALWAYS TRIGGER "pos_reservations_guard";
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ENABLE ALWAYS TRIGGER "pos_reservation_deposits_frozen";
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ENABLE ALWAYS TRIGGER "pos_reservation_deposits_guard";
--> statement-breakpoint

-- RLS
ALTER TABLE "pos_reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_reservations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_reservation_deposits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_reservations_org_isolation" ON "pos_reservations" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_reservation_deposits_org_isolation" ON "pos_reservation_deposits" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- grants
GRANT SELECT, INSERT ON "pos_reservations", "pos_reservation_deposits" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("status","stand_id","session_id","updated_at","closed_at") ON "pos_reservations" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("day_close_id") ON "pos_reservation_deposits" TO "shareat_app";
--> statement-breakpoint

-- 2170 Customer deposits payable for every org that has a chart (the 0222 / 0065 shape; seed/chart-of-accounts.ts carries it for a new org)
INSERT INTO "accounts" (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, requires_party, status)
SELECT h.org_id, '2170', 'Customer deposits payable', 'liability', 'credit', h.id, true, true, false, 'active'
FROM "accounts" h
WHERE h.code = '2000'
  AND NOT EXISTS (SELECT 1 FROM "accounts" b WHERE b.org_id = h.org_id AND b.code = '2170');
--> statement-breakpoint

-- the sales-day figure lock, with the new figure in its frozen list. Body = 0247's, verbatim, plus the one deposits_applied line.
CREATE OR REPLACE FUNCTION "sales_days_check_figure_lock"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	flag_on boolean := coalesce(nullif(current_setting('app.sales_day_derivation', true), ''), 'off') = 'on';
	live_date date;
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- T-531: a day derived from the POS receipts (the Z). The flag is always required; the store must be live and the date on or after live_from.
		IF NEW.source = 'pos_receipts' THEN
			IF NOT flag_on OR NEW.pos_day_close_id IS NULL OR NOT EXISTS (
				SELECT 1 FROM "pos_stores" ps
				 WHERE ps.store_id = NEW.store_id AND ps.mode = 'live' AND ps.live_from IS NOT NULL AND NEW.business_date >= ps.live_from
			) THEN
				RAISE EXCEPTION 'Sales figures for this store come only from POS (T-531): a POS day is created only by the day close, for a live store, on or after its live date.'
					USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
			END IF;
			RETURN NEW;
		END IF;
		-- T-531, row 436: the new POS owns the days from live_from, so the v1 import must not also book them.
		IF NEW.source = 'pos_v1_day_feed' THEN
			SELECT ps.live_from INTO live_date FROM "pos_stores" ps WHERE ps.store_id = NEW.store_id AND ps.mode = 'live';
			IF FOUND AND live_date IS NOT NULL AND NEW.business_date >= live_date THEN
				RAISE EXCEPTION 'This store is on the new POS from %; its sales days come from POS receipts.', to_char(live_date, 'YYYY-MM-DD')
					USING ERRCODE = '23514', CONSTRAINT = 'sales_days_pos_live_feed_guard';
			END IF;
		END IF;
		IF "sales_day_store_is_linked"(NEW.store_id, 'sales_days_figures_locked') THEN
			IF NOT flag_on OR NEW.source <> 'pos_v1_day_feed' THEN
				RAISE EXCEPTION 'Sales figures for this store come only from POS (T-375, R6): a day is created only by the import.'
					USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
			END IF;
		ELSIF NEW.source = 'pos_v1_day_feed' THEN
			RAISE EXCEPTION 'A feed-sourced sales day needs its store linked to POS (T-375, R6).'
				USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
		END IF;
		RETURN NEW;
	END IF;

	-- UPDATE: only a change to a protected column is judged; status, sign-off and journal columns stay writable.
	IF NEW.store_id IS NOT DISTINCT FROM OLD.store_id
		AND NEW.business_date IS NOT DISTINCT FROM OLD.business_date
		AND NEW.source IS NOT DISTINCT FROM OLD.source
		AND NEW.pos_v1_day_feed_id IS NOT DISTINCT FROM OLD.pos_v1_day_feed_id
		AND NEW.pos_sourced IS NOT DISTINCT FROM OLD.pos_sourced
		AND NEW.pos_sourced_at IS NOT DISTINCT FROM OLD.pos_sourced_at
		AND NEW.total_sales IS NOT DISTINCT FROM OLD.total_sales
		AND NEW.unli_sales IS NOT DISTINCT FROM OLD.unli_sales
		AND NEW.ala_carte_sales IS NOT DISTINCT FROM OLD.ala_carte_sales
		AND NEW.senior_discount IS NOT DISTINCT FROM OLD.senior_discount
		AND NEW.pwd_discount IS NOT DISTINCT FROM OLD.pwd_discount
		AND NEW.other_discount IS NOT DISTINCT FROM OLD.other_discount
		AND NEW.comps IS NOT DISTINCT FROM OLD.comps
		AND NEW.service_charge IS NOT DISTINCT FROM OLD.service_charge
		AND NEW.other_charges IS NOT DISTINCT FROM OLD.other_charges
		AND NEW.cash_collected IS NOT DISTINCT FROM OLD.cash_collected
		AND NEW.online_collected IS NOT DISTINCT FROM OLD.online_collected
		AND NEW.credit_sales IS NOT DISTINCT FROM OLD.credit_sales
		AND NEW.refunds IS NOT DISTINCT FROM OLD.refunds
		AND NEW.deposits_applied IS NOT DISTINCT FROM OLD.deposits_applied
	THEN
		RETURN NEW;
	END IF;

	IF NEW.source IS DISTINCT FROM OLD.source THEN
		RAISE EXCEPTION 'The source of a sales day never changes (T-375, R6).'
			USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
	END IF;

	IF OLD.source = 'pos_v1_day_feed' THEN
		IF NOT flag_on OR OLD.status NOT IN ('open', 'submitted') OR NOT "sales_day_store_is_linked"(OLD.store_id, 'sales_days_figures_locked') THEN
			RAISE EXCEPTION 'Sales figures for this store come only from POS (T-375, R6): a feed day changes only inside the derivation, while open or submitted and its store is linked (T-382, R4).'
				USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
		END IF;
	ELSIF OLD.source = 'pos_receipts' THEN
		IF NOT flag_on OR OLD.status NOT IN ('open', 'submitted') THEN
			RAISE EXCEPTION 'Sales figures of a day from the POS change only inside the derivation, while open or submitted (T-531).'
				USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
		END IF;
	ELSIF "sales_day_store_is_linked"(OLD.store_id, 'sales_days_figures_locked')
		OR "sales_day_store_is_linked"(NEW.store_id, 'sales_days_figures_locked') THEN
		RAISE EXCEPTION 'Sales figures for this store come only from POS (T-375, R6): a typed day is writable only while its store is not linked.'
			USING ERRCODE = '23514', CONSTRAINT = 'sales_days_figures_locked';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
