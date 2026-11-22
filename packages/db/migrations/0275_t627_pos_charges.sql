-- 0275 - T-627: store charges on the POS v2 bill (leftover food, an extra griller, ...). docs/tasks/627-pos-charges.md; hand-authored per ADR-012 s5.
-- Journal idx 275, `when` = 0274's + 86400000 (one day per index).
--
-- WHY. v1 lets any cashier add a peso charge to a bill for things outside the menu; v2 had no way to, so Lipa could not go live without it. Each store owns a short
-- list of named charges (pos_charge_presets, edited on /admin/pos-tablets beside Discounts); a cashier adds one from the list (or types a custom one) while the table is open,
-- and the sale freezes them. Charges come AFTER discounts and VAT, outside the VAT base, never discounted, never part of the senior/PWD base (as v1): a receipt's amount due is
-- total + charge_total, and `total` keeps its identity total = subtotal - discount_total.
--
-- WHAT IT ADDS
--   pos_charge_presets          a store's named charges (master data, KEEP). name 1-40 (unique among ACTIVE per store, case-insensitive), amount > 0, per_unit, status.
--   table_session_charges       a charge on an open table session (PURGE). Added and removed by the till (events charge.added / charge.removed); a guard trigger refuses a write on a
--                               paid or voided session, lets a charge move active -> removed once, and freezes every other column.
--   pos_sales_receipt_charges   the frozen copy on a sales receipt (PURGE, append-only). name snapshot, unit_amount, qty, amount = qty * unit_amount.
--   pos_sales_receipts.charge_total   numeric(14,2) NOT NULL DEFAULT 0, >= 0. The receipt trigger compares whole rows, so the new column is frozen from insert.
--   pos_refunds.charges_amount        numeric(14,2) NOT NULL DEFAULT 0: the part of a refund that gives charges back (the cashier ticks it; default none). 0 <= charges_amount <= total.
--
-- TRIGGERS (3, all history guards, ENABLE ALWAYS, SET search_path = public, pg_temp, EXECUTE revoked from PUBLIC; triggers/registry.ts):
--   table_session_charges_guard             INSERT on a paid / voided session refused (23001); active -> removed only (23514), once; other columns frozen (23001).
--   pos_sales_receipt_charges_append_only   UPDATE / DELETE refused (23001), the existing pos_v2_refuse_mutation().
--   pos_sales_receipt_charges_append_guard  INSERT under a receipt written by an earlier transaction refused (23001), the existing pos_sales_receipt_child_insert_guard().
--
-- GRANTS (ADR-012 s5 4a). shareat_app: SELECT, INSERT on all three new tables; UPDATE only (amount, per_unit, status, updated_at) on pos_charge_presets and (status, removed_by,
-- removed_at_device) on table_session_charges; never DELETE. RLS: ENABLE + FORCE, one <t>_org_isolation policy through app_current_org() (DEF-077) with WITH CHECK (DEF-183).
-- CUTOVER: pos_charge_presets keep; the two session / receipt tables purge (row 436, like the discount tables).
--
-- LOCK BUDGET. First statement SET LOCAL lock_timeout = '5s'. Three new empty tables (their FKs scan nothing); two ADD COLUMN with a constant default (no rewrite) on
-- pos_sales_receipts and pos_refunds plus their CHECKs (each validates the table once; both are small). Every statement is its own breakpoint; the last closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE "pos_charge_presets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"per_unit" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "pos_charge_presets_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_charge_presets_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "pos_charge_presets_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 40),
	CONSTRAINT "pos_charge_presets_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "pos_charge_presets_status_check" CHECK ("status" IN ('active','retired')),
	CONSTRAINT "pos_charge_presets_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
CREATE TABLE "table_session_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"preset_id" uuid,
	"name" text NOT NULL,
	"unit_amount" numeric(14,2) NOT NULL,
	"qty" integer NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at_device" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"removed_by" uuid,
	"removed_at_device" timestamp with time zone,
	CONSTRAINT "table_session_charges_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "table_session_charges_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 40),
	CONSTRAINT "table_session_charges_unit_amount_check" CHECK ("unit_amount" > 0),
	CONSTRAINT "table_session_charges_qty_check" CHECK ("qty" BETWEEN 1 AND 1000),
	CONSTRAINT "table_session_charges_status_check" CHECK ("status" IN ('active','removed')),
	CONSTRAINT "table_session_charges_removed_shape_check" CHECK (("status" = 'removed') = ("removed_by" IS NOT NULL)),
	CONSTRAINT "table_session_charges_unit_amount_finite_check" CHECK ("unit_amount" > '-Infinity'::numeric AND "unit_amount" < 'Infinity'::numeric)
);
--> statement-breakpoint
CREATE TABLE "pos_sales_receipt_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"charge_no" smallint NOT NULL,
	"session_charge_id" uuid,
	"preset_id" uuid,
	"name" text NOT NULL,
	"unit_amount" numeric(14,2) NOT NULL,
	"qty" integer NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	CONSTRAINT "pos_sales_receipt_charges_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_sales_receipt_charges_receipt_charge_no_unique" UNIQUE ("receipt_id","charge_no"),
	CONSTRAINT "pos_sales_receipt_charges_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 40),
	CONSTRAINT "pos_sales_receipt_charges_unit_amount_check" CHECK ("unit_amount" > 0),
	CONSTRAINT "pos_sales_receipt_charges_qty_check" CHECK ("qty" > 0),
	CONSTRAINT "pos_sales_receipt_charges_amount_check" CHECK ("amount" = "qty" * "unit_amount"),
	CONSTRAINT "pos_sales_receipt_charges_unit_amount_finite_check" CHECK ("unit_amount" > '-Infinity'::numeric AND "unit_amount" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipt_charges_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint

-- the new columns on existing tables
ALTER TABLE "pos_sales_receipts" ADD COLUMN "charge_total" numeric(14,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_charge_total_check" CHECK ("charge_total" >= 0);
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_charge_total_finite_check" CHECK ("charge_total" > '-Infinity'::numeric AND "charge_total" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD COLUMN "charges_amount" numeric(14,2) DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_charges_amount_check" CHECK ("charges_amount" >= 0 AND "charges_amount" <= "total");
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_charges_amount_finite_check" CHECK ("charges_amount" > '-Infinity'::numeric AND "charges_amount" < 'Infinity'::numeric);
--> statement-breakpoint

-- pos_charge_presets
ALTER TABLE "pos_charge_presets" ADD CONSTRAINT "pos_charge_presets_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_charge_presets" ADD CONSTRAINT "pos_charge_presets_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_charge_presets" ADD CONSTRAINT "pos_charge_presets_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_charge_presets" ADD CONSTRAINT "pos_charge_presets_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_charge_presets" ADD CONSTRAINT "pos_charge_presets_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- table_session_charges
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_session_same_store_fk"
	FOREIGN KEY ("store_id","session_id") REFERENCES "table_sessions"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_preset_same_store_fk"
	FOREIGN KEY ("store_id","preset_id") REFERENCES "pos_charge_presets"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_added_by_fk"
	FOREIGN KEY ("added_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_added_by_same_org_fk"
	FOREIGN KEY ("org_id","added_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_removed_by_fk"
	FOREIGN KEY ("removed_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ADD CONSTRAINT "table_session_charges_removed_by_same_org_fk"
	FOREIGN KEY ("org_id","removed_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_sales_receipt_charges
ALTER TABLE "pos_sales_receipt_charges" ADD CONSTRAINT "pos_sales_receipt_charges_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ADD CONSTRAINT "pos_sales_receipt_charges_receipt_id_fk"
	FOREIGN KEY ("receipt_id") REFERENCES "pos_sales_receipts"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ADD CONSTRAINT "pos_sales_receipt_charges_receipt_id_same_org_fk"
	FOREIGN KEY ("org_id","receipt_id") REFERENCES "pos_sales_receipts"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ADD CONSTRAINT "pos_sales_receipt_charges_session_charge_id_fk"
	FOREIGN KEY ("session_charge_id") REFERENCES "table_session_charges"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ADD CONSTRAINT "pos_sales_receipt_charges_session_charge_id_same_org_fk"
	FOREIGN KEY ("org_id","session_charge_id") REFERENCES "table_session_charges"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ADD CONSTRAINT "pos_sales_receipt_charges_preset_id_fk"
	FOREIGN KEY ("preset_id") REFERENCES "pos_charge_presets"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ADD CONSTRAINT "pos_sales_receipt_charges_preset_id_same_org_fk"
	FOREIGN KEY ("org_id","preset_id") REFERENCES "pos_charge_presets"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint

-- indexes
CREATE UNIQUE INDEX "pos_charge_presets_store_active_name_key" ON "pos_charge_presets" ("store_id", lower("name")) WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "table_session_charges_session_idx" ON "table_session_charges" ("store_id","session_id");
--> statement-breakpoint
CREATE INDEX "pos_sales_receipt_charges_receipt_idx" ON "pos_sales_receipt_charges" ("receipt_id");
--> statement-breakpoint

-- the session guard (as table_session_line_discounts_guard, the parent here is the session itself)
CREATE FUNCTION "table_session_charges_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	s text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- FOR SHARE: a concurrent open -> paid UPDATE of the session waits for this charge (or this charge waits for it).
		SELECT ss.status INTO s FROM "table_sessions" ss WHERE ss.id = NEW.session_id FOR SHARE OF ss;
		IF s IN ('paid','voided') THEN
			RAISE EXCEPTION 'A % table session takes no new charge (session %).', s, NEW.session_id USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'removed') THEN
		RAISE EXCEPTION 'A session charge only moves active -> removed; % -> % on charge % is refused.', OLD.status, NEW.status, OLD.id USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.status = 'removed' AND OLD.status = 'active' THEN
		SELECT ss.status INTO s FROM "table_sessions" ss WHERE ss.id = OLD.session_id FOR SHARE OF ss;
		IF s IN ('paid','voided') THEN
			RAISE EXCEPTION 'A charge of a % table session cannot be removed (charge %).', s, OLD.id USING ERRCODE = 'restrict_violation';
		END IF;
	END IF;
	IF to_jsonb(NEW) - ARRAY['status','removed_by','removed_at_device'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','removed_by','removed_at_device']
		OR (OLD.status = 'removed' AND (NEW.removed_by, NEW.removed_at_device) IS DISTINCT FROM (OLD.removed_by, OLD.removed_at_device)) THEN
		RAISE EXCEPTION 'A session charge is frozen once written (only its removal moves, once); charge % is refused.', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "table_session_charges_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "table_session_charges_guard" BEFORE INSERT OR UPDATE ON "table_session_charges" FOR EACH ROW EXECUTE FUNCTION "table_session_charges_guard"();
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipt_charges_append_only" BEFORE UPDATE OR DELETE ON "pos_sales_receipt_charges" FOR EACH ROW EXECUTE FUNCTION "pos_v2_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipt_charges_append_guard" BEFORE INSERT ON "pos_sales_receipt_charges" FOR EACH ROW EXECUTE FUNCTION "pos_sales_receipt_child_insert_guard"();
--> statement-breakpoint
ALTER TABLE "table_session_charges" ENABLE ALWAYS TRIGGER "table_session_charges_guard";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ENABLE ALWAYS TRIGGER "pos_sales_receipt_charges_append_only";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ENABLE ALWAYS TRIGGER "pos_sales_receipt_charges_append_guard";
--> statement-breakpoint

-- RLS
ALTER TABLE "pos_charge_presets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_charge_presets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "table_session_charges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "table_session_charges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_charges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_charge_presets_org_isolation" ON "pos_charge_presets" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "table_session_charges_org_isolation" ON "table_session_charges" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_sales_receipt_charges_org_isolation" ON "pos_sales_receipt_charges" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- grants
GRANT SELECT, INSERT ON "pos_charge_presets", "table_session_charges", "pos_sales_receipt_charges" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("amount","per_unit","status","updated_at") ON "pos_charge_presets" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("status","removed_by","removed_at_device") ON "table_session_charges" TO "shareat_app";
