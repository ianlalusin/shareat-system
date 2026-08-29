-- 0071 — T-174: what happens to the goods that never arrived.
--
-- HAND-WRITTEN, like 0020-0070. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ T-173 deliberately does not block a short receipt: it posts what arrived and leaves the
-- difference in `1340 Inventory in transit`, because goods that left one building and did not
-- reach another are a REAL ASSET until somebody says otherwise. This table is where somebody says
-- otherwise, and the row is written BY the confirm — there is no "raise a discrepancy" action, so
-- a shortfall cannot sit in `1340` without a row naming it.

CREATE TABLE "trade_discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	-- ⭐ The COMMISSARY's store. Stored rather than joined because the day-open block queries it on
	-- every sales-day create; it is the order's dispatching store and cannot change.
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"disposition" text,
	"charge_person_id" uuid,
	-- ⭐ EXACTLY ONCE, and that is the whole reason defer is safe to offer. v1's rule, verbatim.
	"deferred_to" date,
	"note" text,
	"journal_entry_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_discrepancies_quantity_positive_check" CHECK ("quantity" > 0),
	CONSTRAINT "trade_discrepancies_value_positive_check" CHECK ("value" > 0),
	CONSTRAINT "trade_discrepancies_status_check" CHECK ("status" IN ('open','deferred','resolved')),
	CONSTRAINT "trade_discrepancies_disposition_check"
		CHECK ("disposition" IS NULL OR "disposition" IN ('audit','loss','charge','late_receipt')),
	CONSTRAINT "trade_discrepancies_charge_person_check"
		CHECK ("disposition" <> 'charge' OR "charge_person_id" IS NOT NULL),
	-- ⛔ Resolved without saying WHAT it was is the state this table exists to prevent.
	CONSTRAINT "trade_discrepancies_resolved_shape_check"
		CHECK ("status" <> 'resolved' OR ("disposition" IS NOT NULL AND "resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL)),
	CONSTRAINT "trade_discrepancies_deferred_shape_check"
		CHECK (("status" = 'deferred') = ("deferred_to" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_order_id_trade_orders_id_fk"
	FOREIGN KEY ("order_id") REFERENCES "trade_orders"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_order_line_id_fk"
	FOREIGN KEY ("order_line_id") REFERENCES "trade_order_lines"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_charge_person_id_persons_id_fk"
	FOREIGN KEY ("charge_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_journal_entry_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_resolved_by_persons_id_fk"
	FOREIGN KEY ("resolved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⭐ ONE per order line. A second confirm of the same line cannot raise a second dispute.
CREATE UNIQUE INDEX "trade_discrepancies_line_key" ON "trade_discrepancies" ("order_line_id");--> statement-breakpoint

-- ⭐ The day-open block's index. Partial, because the only rows it ever asks about are unfinished.
CREATE INDEX "trade_discrepancies_blocking_idx"
	ON "trade_discrepancies" ("store_id", "status", "deferred_to")
	WHERE "status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "trade_discrepancies_order_idx" ON "trade_discrepancies" ("order_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⭐ DEFER IS ONCE, AND THE DATABASE IS WHERE THAT LIVES.
--
-- v1's rule kept verbatim, and it is the whole reason defer is safe to offer at all: a second
-- deferral would let a dispute be pushed down the road indefinitely, which is the exact state the
-- day-open block exists to prevent. ⚠️ Enforced here rather than in the service because the
-- service is one caller among the several a UI eventually grows.
--
-- The test is `deferred_to` having ALREADY been set — not the current status — so it still refuses
-- after the row has moved on to `open` again when the deferral date passes.
CREATE FUNCTION "trade_discrepancies_defer_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."deferred_to" IS NOT NULL
		AND OLD."deferred_to" IS NOT NULL
		AND NEW."deferred_to" <> OLD."deferred_to" THEN
		RAISE EXCEPTION 'discrepancy % was already deferred to % — a second deferral is refused, decide it',
			NEW."id", OLD."deferred_to";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "trade_discrepancies_defer_once_trg"
	BEFORE UPDATE ON "trade_discrepancies"
	FOR EACH ROW EXECUTE FUNCTION "trade_discrepancies_defer_once"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⛔ RESOLUTION IS TERMINAL (invariant 10). Correcting a wrong disposition is a REVERSAL plus a
-- new resolution, never an edit — bible invariant 5. A row that has been resolved is frozen except
-- for the note, which is how somebody records WHY the reversal happened without rewriting what was
-- decided.
CREATE FUNCTION "trade_discrepancies_resolution_terminal"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."status" <> 'resolved' THEN RETURN NEW; END IF;
	IF NEW."status" IS DISTINCT FROM OLD."status"
		OR NEW."disposition" IS DISTINCT FROM OLD."disposition"
		OR NEW."charge_person_id" IS DISTINCT FROM OLD."charge_person_id"
		OR NEW."journal_entry_id" IS DISTINCT FROM OLD."journal_entry_id"
		OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
		OR NEW."value" IS DISTINCT FROM OLD."value" THEN
		RAISE EXCEPTION 'discrepancy % is resolved as % — reverse it and resolve again, do not edit it',
			NEW."id", OLD."disposition";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "trade_discrepancies_resolution_terminal_trg"
	BEFORE UPDATE ON "trade_discrepancies"
	FOR EACH ROW EXECUTE FUNCTION "trade_discrepancies_resolution_terminal"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE and FORCE (bible row 112).
ALTER TABLE "trade_discrepancies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trade_discrepancies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "trade_discrepancies_org_isolation" ON "trade_discrepancies"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⛔ WHAT LEFT `1340`, AT COST — and the hole that made this column necessary.
--
-- The first cut of T-172/T-173 debited `1340` at the commissary's FIFO COST and credited it at
-- the TRANSFER RATE. Those are different numbers on purpose (T-133: *"the transfer PRICE carries
-- the processing cost — ₱310/kg, not ₱300"*), so `1340` never cleared: a fully received ₱30,000
-- shipment transferred at ₱31,000 left the account at **−₱1,000, permanently**, once per shipment.
-- The trial balance still tied, because the ₱1,000 simply sat in the wrong account — which is why
-- nothing announced it. Found by T-174's fixture asking what was actually stranded.
--
-- ⭐ **The rule that closes it: `1340` is a COST account, relieved at cost, always.** The transfer
-- margin is a different fact — it is the commissary's processing work, and it is recognised
-- against `5175 Cost transferred to branches` only for the goods that actually ARRIVE.
--
-- ⚠️ **So `5175` is load-bearing under perpetual, not a periodic leftover.** T-165 §4 keeps it for
-- the franchise case; this is a second, closer reason. Its own comment has said since T-102b that
-- it *"must ELIMINATE against the commissary's transfer-out"*, and that is exactly its job here.
--
-- This column is what makes the receipt able to relieve at cost: the dispatch records what the
-- goods cost when they left, and the receipt reads it back rather than being told.
ALTER TABLE "trade_order_lines" ADD COLUMN "dispatch_cost" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_dispatch_cost_check"
	CHECK ("dispatch_cost" IS NULL OR "dispatch_cost" >= 0);--> statement-breakpoint
