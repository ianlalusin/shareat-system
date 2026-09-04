-- 0126 — T-178: order/channel wastage disposition.
--
-- HAND-WRITTEN, like 0020-0125. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⚠️ NOT stock wastage (T-168). This writes NO stock movement and consumes NO layer — a refunded
-- or remade menu item is order-economics and staff accountability, not a stock loss (task §1).

CREATE TABLE "order_wastages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"sales_day_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"order_ref" text,
	"type_mode" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"disposition" text,
	"auto_charged" boolean DEFAULT false NOT NULL,
	"settlement_id" uuid,
	"journal_entry_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "order_wastages_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "order_wastages_type_mode_check" CHECK ("type_mode" IN ('instant','tracked')),
	CONSTRAINT "order_wastages_status_check" CHECK ("status" IN ('open','disputed','resolved')),
	CONSTRAINT "order_wastages_disposition_check"
		CHECK ("disposition" IS NULL OR "disposition" IN ('platform_paid','absorbed','charged')),
	-- ⛔ Resolved without saying WHAT it was is the state trade_discrepancies (T-174) already
	-- refuses; this table refuses it the same way.
	CONSTRAINT "order_wastages_resolved_shape_check"
		CHECK ("status" <> 'resolved' OR "disposition" IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_sales_day_id_sales_days_id_fk"
	FOREIGN KEY ("sales_day_id") REFERENCES "sales_days"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_settlement_id_channel_settlements_id_fk"
	FOREIGN KEY ("settlement_id") REFERENCES "channel_settlements"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_journal_entry_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_resolved_by_persons_id_fk"
	FOREIGN KEY ("resolved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "order_wastages_org_store_status_idx" ON "order_wastages" ("org_id","store_id","status");--> statement-breakpoint
CREATE INDEX "order_wastages_sales_day_idx" ON "order_wastages" ("sales_day_id");--> statement-breakpoint
-- The backstop's own query: unresolved rows, oldest first, regardless of status (invariant 4 —
-- disputed rows are NOT exempt from this index or from the clock it serves).
CREATE INDEX "order_wastages_backstop_idx" ON "order_wastages" ("status","opened_at");--> statement-breakpoint

CREATE TABLE "order_wastage_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"wastage_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"percent" numeric(5, 2) NOT NULL,
	CONSTRAINT "order_wastage_allocations_percent_check" CHECK ("percent" > 0 AND "percent" <= 100)
);--> statement-breakpoint

ALTER TABLE "order_wastage_allocations" ADD CONSTRAINT "order_wastage_allocations_wastage_id_fk"
	FOREIGN KEY ("wastage_id") REFERENCES "order_wastages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "order_wastage_allocations" ADD CONSTRAINT "order_wastage_allocations_person_id_fk"
	FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "order_wastage_allocations_wastage_person_unique"
	ON "order_wastage_allocations" ("wastage_id","person_id");--> statement-breakpoint

-- ⭐ Invariant 3 — allocation percentages sum to EXACTLY 100 whenever any exist for a wastage. A
-- cross-row rule, so it is a DEFERRABLE constraint trigger (checked at COMMIT, same shape as
-- `stock_layer_consumptions_ties_trg`, migration 0064) rather than a per-row CHECK — a caller
-- deleting the old allocations and inserting the new ones inside one transaction must not see a
-- spurious failure between the two statements.
CREATE FUNCTION "order_wastage_allocations_sum_100"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	target_wastage uuid;
	total numeric(7,2);
BEGIN
	target_wastage := COALESCE(NEW."wastage_id", OLD."wastage_id");

	SELECT COALESCE(sum("percent"), 0) INTO total
	FROM "order_wastage_allocations"
	WHERE "wastage_id" = target_wastage;

	-- Zero allocations is lawful (a tracked wastage may have none yet, or an instant/absorbed one
	-- may never need any). Only a NON-ZERO total that is not exactly 100 is refused.
	IF total <> 0 AND total <> 100 THEN
		RAISE EXCEPTION 'order_wastage % allocations sum to %, not 100', target_wastage, total;
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "order_wastage_allocations_sum_100_trg"
	AFTER INSERT OR UPDATE OR DELETE ON "order_wastage_allocations"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "order_wastage_allocations_sum_100"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE, as the tables are created (bible row 112).
ALTER TABLE "order_wastages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_wastages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_wastage_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_wastage_allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "order_wastages_org_isolation" ON "order_wastages"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- `order_wastage_allocations` carries no org_id of its own — derived, reached only through its
-- wastage, same shape as `stock_usage_lines` (migration 0067).
CREATE POLICY "order_wastage_allocations_org_isolation" ON "order_wastage_allocations"
	USING (EXISTS (SELECT 1 FROM "order_wastages" w WHERE w."id" = "wastage_id" AND w."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "order_wastages" w WHERE w."id" = "wastage_id" AND w."org_id" = app_current_org()));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- stores — the Wastage Monitor, KEEP SHELL at cutover (task §11; not a new table).
ALTER TABLE "stores" ADD COLUMN "wastage_monitor_person_id" uuid;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_wastage_monitor_person_id_fk"
	FOREIGN KEY ("wastage_monitor_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- scheduler_runs — register the 15-day backstop as a T-140 job (task §11, DEF-044's lesson: a
-- scheduler that is never actually scheduled). ⚠️ SHARED TABLE: if another lane's migration also
-- widens `scheduler_runs_job_check` between this migration and that one, the two DROP/ADD pairs
-- must be reconciled into ONE final constraint naming every job from every lane — see the T-178
-- task report.
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation','amortisation','attendance_sweep','mirror_publish','inbox_relay','order_wastage_backstop'));--> statement-breakpoint
