-- 0067 — T-168: usage, wastage and adjustment. The busiest door in the domain.
--
-- HAND-WRITTEN, like 0020-0066. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ v1 has TWO of these — one for items, one for meat — each with its own draft/post/void
-- lifecycle and its own copy of the same rules. That split existed only because meatProducts and
-- inventoryProducts were separate collections, a duality v1 was ALREADY RETIRING itself. T-145
-- finished it: one items table, kind including meat_slab and meat_sliced. So the meat rules become
-- rules about a KIND, and 8 transaction sites become one.

CREATE TABLE "stock_usage_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"used_on" date NOT NULL,
	"department_id" uuid,
	"reason_code" text,
	"adjustment_reason" text,
	"charge_person_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_usage_kind_check" CHECK ("kind" IN ('usage','wastage','adjustment','opening')),
	CONSTRAINT "stock_usage_status_check" CHECK ("status" IN ('draft','posted','void')),
	-- ⭐ THE RESERVED CATEGORY, as a constraint. v1's named footgun: the usage flow writes only an
	-- OUT leg, so a movement mislabelled as a transfer DESTROYS stock instead of moving it — it
	-- leaves one location and arrives nowhere. The domain checks a wider synonym list; this stops
	-- the literal value reaching the table by any path at all.
	CONSTRAINT "stock_usage_reason_not_transfer_check"
		CHECK ("reason_code" IS NULL OR lower(trim("reason_code")) NOT IN
			('transfer','transfers','transfer_out','transfer_in','move','moved','relocate','relocation')),
	CONSTRAINT "stock_usage_wastage_reason_check" CHECK ("kind" <> 'wastage' OR "reason_code" IS NOT NULL),
	CONSTRAINT "stock_usage_reason_only_on_wastage_check" CHECK ("kind" = 'wastage' OR "reason_code" IS NULL),
	CONSTRAINT "stock_usage_adjustment_reason_check"
		CHECK ("kind" <> 'adjustment' OR "adjustment_reason" IS NOT NULL),
	-- ⚠️ Only a wastage can be charged to somebody. Charging a routine usage to a cook is not a
	-- control, it is a grievance.
	CONSTRAINT "stock_usage_charge_only_on_wastage_check"
		CHECK ("charge_person_id" IS NULL OR "kind" = 'wastage'),
	CONSTRAINT "stock_usage_posted_shape_check"
		CHECK ("status" <> 'posted' OR ("posted_at" IS NOT NULL AND "posted_by" IS NOT NULL)),
	CONSTRAINT "stock_usage_void_shape_check"
		CHECK ("status" <> 'void' OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_department_id_departments_id_fk"
	FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_charge_person_id_persons_id_fk"
	FOREIGN KEY ("charge_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_posted_by_persons_id_fk"
	FOREIGN KEY ("posted_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_voided_by_persons_id_fk"
	FOREIGN KEY ("voided_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_records_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "stock_usage_store_status_idx" ON "stock_usage_records" ("store_id", "status", "used_on");--> statement-breakpoint
CREATE INDEX "stock_usage_org_idx" ON "stock_usage_records" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
CREATE TABLE "stock_usage_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"record_id" uuid NOT NULL,
	"line_no" text NOT NULL,
	"item_id" uuid NOT NULL,
	-- SIGNED only for an adjustment. A usage or wastage line is always positive: the direction is
	-- the record's KIND, not the line's sign, and "used -5" would be a silent stock-in.
	"quantity" numeric(14, 3) NOT NULL,
	"movement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_usage_lines_quantity_not_zero_check" CHECK ("quantity" <> 0)
);--> statement-breakpoint

ALTER TABLE "stock_usage_lines" ADD CONSTRAINT "stock_usage_lines_record_id_stock_usage_records_id_fk"
	FOREIGN KEY ("record_id") REFERENCES "stock_usage_records"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "stock_usage_lines" ADD CONSTRAINT "stock_usage_lines_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_usage_lines" ADD CONSTRAINT "stock_usage_lines_movement_id_stock_movements_id_fk"
	FOREIGN KEY ("movement_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "stock_usage_lines_record_line_key" ON "stock_usage_lines" ("record_id", "line_no");--> statement-breakpoint
CREATE INDEX "stock_usage_lines_item_idx" ON "stock_usage_lines" ("item_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⭐ A usage may only draw from an OPERATING room.
--
-- A storage room (stockroom) holds stock and receives it, but nothing may be CONSUMED from there:
-- consumption in a stockroom means the count was never taken. v1 enforces this at every usage and
-- wastage post; here it is one trigger that no caller can route around.
--
-- ⚠️ An ADJUSTMENT is exempt. A correction has to be possible wherever the wrong number is, and a
-- stockroom is exactly where a miscount lives.
CREATE FUNCTION "stock_usage_operating_location"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	loc_role text;
	loc_purpose text;
	loc_status text;
BEGIN
	IF NEW."kind" = 'adjustment' THEN RETURN NEW; END IF;

	SELECT "role", "purpose", "status" INTO loc_role, loc_purpose, loc_status
	FROM "stock_locations" WHERE "id" = NEW."location_id";

	IF loc_status <> 'active' THEN
		RAISE EXCEPTION 'location % is inactive and cannot be a usage source', NEW."location_id";
	END IF;
	IF loc_purpose = 'receiving' THEN
		RAISE EXCEPTION 'the Receiving room is a parking spot, not a place stock is used';
	END IF;
	IF loc_role <> 'operating' THEN
		RAISE EXCEPTION 'location % is a storage room; only an operating room may be a usage source',
			NEW."location_id";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "stock_usage_operating_location_trg"
	BEFORE INSERT OR UPDATE ON "stock_usage_records"
	FOR EACH ROW EXECUTE FUNCTION "stock_usage_operating_location"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⛔ A POSTED record is immutable except for the transition to void.
--
-- Invariant 5: corrections are new records, never edits. Without this, "post then quietly change
-- the quantity" leaves stock that no document explains.
CREATE FUNCTION "stock_usage_posted_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."status" <> 'posted' THEN RETURN NEW; END IF;
	IF NEW."status" = 'void' THEN RETURN NEW; END IF;
	RAISE EXCEPTION 'a posted usage record is immutable — void it and record a new one';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "stock_usage_posted_immutable_trg"
	BEFORE UPDATE ON "stock_usage_records"
	FOR EACH ROW EXECUTE FUNCTION "stock_usage_posted_immutable"();--> statement-breakpoint

-- ⛔ And a void is TERMINAL. v1 treats void as terminal everywhere and v2 makes it uniform
-- (§16.6): a voided record is never re-posted, because a correction is a new record.
CREATE FUNCTION "stock_usage_void_terminal"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."status" = 'void' THEN
		RAISE EXCEPTION 'a voided usage record is terminal — record a new one instead';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "stock_usage_void_terminal_trg"
	BEFORE UPDATE ON "stock_usage_records"
	FOR EACH ROW EXECUTE FUNCTION "stock_usage_void_terminal"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE (bible row 112). Lines derive through their record.
ALTER TABLE "stock_usage_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_usage_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_usage_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_usage_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "stock_usage_records_org_isolation" ON "stock_usage_records"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

CREATE POLICY "stock_usage_lines_org_isolation" ON "stock_usage_lines"
	USING (EXISTS (SELECT 1 FROM "stock_usage_records" r WHERE r."id" = "record_id" AND r."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "stock_usage_records" r WHERE r."id" = "record_id" AND r."org_id" = app_current_org()));--> statement-breakpoint
