-- 0070 — T-172/T-173: the branch order, its dispatch, and the receipt that posts both stores.
--
-- HAND-WRITTEN, like 0020-0069. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⛔ THERE IS NO `branch_orders` TABLE, and that is the finding rather than an omission.
-- ADR-008 §8 settled it: "One ordering and fulfilment flow. Two accounting treatments, derived
-- from the counterparty. A mode is a fork; a derived treatment is a fact." ERPNext genuinely does
-- split these (Material Request / Stock Entry vs Sales Order / Delivery Note); the reason we do
-- not is that the split encodes an organisational boundary of separate teams and approval chains,
-- and this business does not have one — the same commissary staff pack the same crates on the
-- same morning. So this migration ADDS COLUMNS to `trade_orders`.

ALTER TABLE "trade_orders" ADD COLUMN "requested_by_store_id" uuid;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "accepted_by" uuid;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "ready_by" uuid;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "reject_reason" text;--> statement-breakpoint

ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_requested_by_store_id_stores_id_fk"
	FOREIGN KEY ("requested_by_store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_accepted_by_persons_id_fk"
	FOREIGN KEY ("accepted_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_ready_by_persons_id_fk"
	FOREIGN KEY ("ready_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_rejected_by_persons_id_fk"
	FOREIGN KEY ("rejected_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⭐ ONE OPEN ORDER AT A TIME, per (branch, commissary).
--
-- v1's reason for `dispatched` blocking is the important half: "a dispatched order is
-- goods-in-transit not yet received, so it BLOCKS — the branch must confirm receipt first." Only
-- `received` and `void` free the branch. ⚠️ v1 has separate `cancelled` and `rejected` states;
-- here both are `void` plus the reason columns above, because the accounting treatment is
-- identical and a status that changes nothing about the books is a label, not a state.
--
-- ⚠️ This also guards the LOW-STOCK AUTO-ORDER (T-175), which routes through the same create path,
-- so a branch cannot accumulate auto-drafted orders it never submits.
CREATE UNIQUE INDEX "trade_orders_one_open_per_branch_key"
	ON "trade_orders" ("requested_by_store_id", "store_id")
	WHERE "requested_by_store_id" IS NOT NULL AND "status" IN ('draft','confirmed','dispatched');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
ALTER TABLE "trade_order_lines" ADD COLUMN "requested_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD COLUMN "fulfilled_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD COLUMN "received_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD COLUMN "source_location_id" uuid;--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD COLUMN "origin" text DEFAULT 'requested' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD COLUMN "approval" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD COLUMN "is_ledger_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD COLUMN "expense_category_id" uuid;--> statement-breakpoint

ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_source_location_id_fk"
	FOREIGN KEY ("source_location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_expense_category_id_fk"
	FOREIGN KEY ("expense_category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_origin_check"
	CHECK ("origin" IN ('requested','commissary_added'));--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_approval_check"
	CHECK ("approval" IN ('not_required','pending','approved','rejected'));--> statement-breakpoint

-- ⭐ A line the COMMISSARY added always needs the branch's answer. v1: a substitution lands
-- `pending` and does NOT count toward the total or let the order reach "ready" until the branch
-- explicitly approves or rejects it.
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_added_needs_approval_check"
	CHECK ("origin" <> 'commissary_added' OR "approval" <> 'not_required');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⭐ PRE-SUBMIT HARDENING, as a trigger.
--
-- v1's own framing: every line must carry a quantity, a resolved branch item (or an explicit
-- ledger-only decision) and a resolved expense category BEFORE the order leaves the branch —
-- closing "the receipt knows nothing to credit" and "auto-book can't categorize" at the point
-- somebody can still fix them, rather than discovering both at receipt time in another store.
--
-- ⚠️ The category checked here is the SAME one the receipt posts with. v1 carries `hasFullCategory`
-- precisely so the submit block and the booking test cannot drift; had they drifted, an order
-- could pass submit while its lines were invisible to booking — the ₱12,184.71 failure by a
-- second route.
-- ⚠️ The child table is `trade_order_lines(order_id, ...)` and carries NO `line_no` — it is
-- identified by id. Worth stating: a plpgsql body is not validated until it RUNS, so a wrong
-- column name here applies cleanly and fails months later, in front of a user submitting an order.
CREATE FUNCTION "trade_orders_submit_hardening"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	bad_line text;
BEGIN
	-- Only an INTERNAL branch request is hardened here; an external sale has its own rules.
	IF NEW."requested_by_store_id" IS NULL THEN RETURN NEW; END IF;
	IF NOT (OLD."status" = 'draft' AND NEW."status" = 'confirmed') THEN RETURN NEW; END IF;

	SELECT l."id"::text INTO bad_line FROM "trade_order_lines" l
	WHERE l."order_id" = NEW."id"
	  AND (l."requested_quantity" IS NULL OR l."requested_quantity" <= 0)
	LIMIT 1;
	IF bad_line IS NOT NULL THEN
		RAISE EXCEPTION 'line % has no requested quantity', bad_line;
	END IF;

	SELECT l."id"::text INTO bad_line FROM "trade_order_lines" l
	WHERE l."order_id" = NEW."id" AND l."expense_category_id" IS NULL AND NOT l."is_ledger_only"
	LIMIT 1;
	IF bad_line IS NOT NULL THEN
		RAISE EXCEPTION 'line % has no expense category — the receipt would have nothing to post against', bad_line;
	END IF;

	SELECT l."id"::text INTO bad_line FROM "trade_order_lines" l
	WHERE l."order_id" = NEW."id" AND l."approval" = 'pending'
	LIMIT 1;
	IF bad_line IS NOT NULL THEN
		RAISE EXCEPTION 'line % is a commissary addition awaiting the branch decision', bad_line;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "trade_orders_submit_hardening_trg"
	BEFORE UPDATE ON "trade_orders"
	FOR EACH ROW EXECUTE FUNCTION "trade_orders_submit_hardening"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⛔ `trade_orders_dispatch_shape_check` IS DEFINED BY 0054 AND IS LEFT ALONE HERE — this comment
-- exists because the first draft of this migration re-wrote it, and re-writing it silently undid a
-- shipped fix.
--
-- The stale text in `packages/db/schema/trade.ts` still demanded an `ar_charge_id` on every
-- dispatch, which an internal order can never have. **T-133 had already fixed that on 2026-08-28**
-- — 0054 replaced the AR requirement with a `journal_entry_id` requirement and extended the check
-- to `received` — and only the migration was updated. Reading the schema file gave the T-132
-- answer; reading the database gave the T-133 one. See DEF-095.
--
-- ⚠️ The lesson generalises past this table: migrations here are HAND-WRITTEN (DEF-073), so a
-- constraint changed in SQL and not mirrored into `schema/` leaves the schema stating something
-- the database does not enforce, in a file everyone reads first.

-- ⭐ What IS new is the other direction, and it is the stronger statement: an internal order
-- CANNOT carry a receivable. v1 books a branch transfer as an AR charge against the
-- branch-as-customer and then needs an `excludeBranchSales` flag to stop its own insights being
-- wrong — that flag is the tell that the recognition was wrong upstream. Here the row will not
-- store, so no posting function, no import and no future maintainer can reintroduce it.
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_internal_no_ar_check"
	CHECK ("requested_by_store_id" IS NULL OR "ar_charge_id" IS NULL);--> statement-breakpoint
