-- 0063 — T-161: the stock ledger. Movements are the truth; on-hand is a query.
--
-- HAND-WRITTEN, like 0020-0062. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ Four rules live in this file rather than in TypeScript, and each is here for the same reason
-- bible row 104 gives: name the statement the DATABASE refuses, never the call our code declines
-- to make. A guard that exists only in the service layer is a convention, and DEF-041 is what
-- happens when a convention is mistaken for a constraint.
--
--   1. APPEND ONLY   — UPDATE and DELETE raise. A correction is a new, opposite row.
--   2. NON-NEGATIVE  — on-hand for an (item, location) may never go below zero.
--   3. PERIOD LOCK   — no movement into a closed period, by ANY path (invariant 7).
--   4. REVERSAL SANITY — a reversal must oppose what it reverses, and match its pair.
--
-- ⚠️ Rule 2 is a CONSTRAINT TRIGGER deferred to COMMIT, because a row-level BEFORE trigger cannot
-- see the other rows of a multi-line document: two usage lines that individually pass and
-- collectively overdraw would slip through one. Deferring also lets a transfer write its OUT and
-- IN legs in either order.
--
-- ⭐ Rules 1, 3 and 4 are BEFORE triggers, and rule 4's timing is a deliberate correction: when it
-- was deferred alongside rule 2, both fired at commit and rule 2 won by trigger name, so a
-- malformed reversal was reported as "stock would go negative" — true, useless, and pointing at
-- the wrong problem. A structural check belongs before the balance consequence it causes.

-- ---------------------------------------------------------------------------------------------
-- 1. The ledger.
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	-- Business time. The period lock and `onHand(asOf)` both key off this.
	"moved_at" timestamp with time zone NOT NULL,
	-- SIGNED. Positive in, negative out.
	"quantity" numeric(14, 3) NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"reversal_of_id" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_quantity_not_zero_check" CHECK ("quantity" <> 0),
	CONSTRAINT "stock_movements_source_type_not_blank_check" CHECK (length(trim("source_type")) > 0),
	CONSTRAINT "stock_movements_kind_check" CHECK ("kind" IN (
		'receipt','usage','wastage','transfer_out','transfer_in','count_adjustment',
		'manual_adjustment','production_in','production_out','return_out','opening'))
);--> statement-breakpoint

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_stock_locations_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_journal_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reversal_of_id_stock_movements_id_fk"
	FOREIGN KEY ("reversal_of_id") REFERENCES "stock_movements"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⭐ Idempotency: one source document never touches the same (item, location) twice, so a retried
-- post writes nothing new rather than doubling the stock. A REVERSAL is legitimately a second row
-- for that pair, so it is excluded here and constrained separately below.
CREATE UNIQUE INDEX "stock_movements_source_pair_key"
	ON "stock_movements" ("source_type", "source_id", "item_id", "location_id")
	WHERE "reversal_of_id" IS NULL;--> statement-breakpoint

-- ⭐ A movement may be reversed AT MOST ONCE.
CREATE UNIQUE INDEX "stock_movements_one_reversal_key"
	ON "stock_movements" ("reversal_of_id") WHERE "reversal_of_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "stock_movements_item_location_idx"
	ON "stock_movements" ("item_id", "location_id", "moved_at");--> statement-breakpoint
CREATE INDEX "stock_movements_store_moved_idx"
	ON "stock_movements" ("org_id", "store_id", "moved_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. APPEND ONLY. The same treatment DEF-041 got in migration 0009.
--
-- ⛔ Not "our code does not UPDATE" — that is a convention, and it was satisfied once by grepping
-- our own repo while raw SQL quietly rewrote a landed row from 100 to 999999 and deleted it. The
-- failure mode is that it leaves NO SIGNAL: every reconciliation still balances, because the thing
-- being reconciled is what was rewritten.
CREATE FUNCTION "stock_movements_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'stock_movements is append-only: % is not permitted. A correction is a new, opposite row carrying reversal_of_id.', TG_OP;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "stock_movements_append_only_trg"
	BEFORE UPDATE OR DELETE ON "stock_movements"
	FOR EACH ROW EXECUTE FUNCTION "stock_movements_append_only"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. PERIOD LOCK — invariant 7, "on every posting path".
--
-- ⭐ §16.7 defect 6: v1 has NO period guard on 11 of 17 inventory and production paths. This is
-- where that closes — once, for every caller, in the one place none of them can route around.
--
-- ⚠️ A movement with no fiscal period covering its date is ALLOWED. Periods are created as the
-- business closes them; refusing a movement because next month's period does not exist yet would
-- stop the warehouse to satisfy the bookkeeper. What is refused is a period that exists and is
-- shut.
CREATE FUNCTION "stock_movements_check_period_open"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	period_status text;
BEGIN
	SELECT "status" INTO period_status
	FROM "fiscal_periods"
	WHERE "org_id" = NEW."org_id"
	  AND (NEW."moved_at" AT TIME ZONE 'UTC')::date BETWEEN "starts_on" AND "ends_on";

	IF period_status IS NOT NULL AND period_status <> 'open' THEN
		RAISE EXCEPTION 'cannot move stock into a % period (moved_at = %)', period_status, NEW."moved_at";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "stock_movements_check_period_open_trg"
	BEFORE INSERT ON "stock_movements"
	FOR EACH ROW EXECUTE FUNCTION "stock_movements_check_period_open"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. NON-NEGATIVE on-hand, and reversal sanity.
--
-- ⚠️ DEFERRABLE constraint triggers, checked at COMMIT rather than per row. A multi-line document
-- writes several rows; a BEFORE ROW trigger sees each alone, so two lines that individually pass
-- and collectively overdraw would slip past one. Deferring also lets a transfer write its OUT and
-- IN legs in either order.
--
-- ⛔ There is deliberately NO admin override here. v1 allowed one and used it to paper over the
-- concurrency bug this table's design removes; if a balance is genuinely wrong, the correction is
-- a `manual_adjustment` movement with a typed reason, which is itself visible in the ledger.
CREATE FUNCTION "stock_movements_no_negative_on_hand"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	on_hand numeric(14,3);
BEGIN
	SELECT COALESCE(sum("quantity"), 0) INTO on_hand
	FROM "stock_movements"
	WHERE "item_id" = NEW."item_id" AND "location_id" = NEW."location_id";

	IF on_hand < 0 THEN
		RAISE EXCEPTION 'stock would go negative: item % at location % would be % after this movement',
			NEW."item_id", NEW."location_id", on_hand;
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "stock_movements_no_negative_on_hand_trg"
	AFTER INSERT ON "stock_movements"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "stock_movements_no_negative_on_hand"();--> statement-breakpoint

-- ⭐ A reversal must actually reverse: same item, same location, and the exact opposite quantity.
-- Without this, `reversal_of_id` is a comment rather than a link, and a "reversal" that half-undoes
-- a movement leaves a ledger that reconciles against nothing.
CREATE FUNCTION "stock_movements_reversal_matches"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	orig record;
BEGIN
	IF NEW."reversal_of_id" IS NULL THEN RETURN NEW; END IF;

	SELECT "item_id", "location_id", "quantity", "reversal_of_id"
	INTO orig FROM "stock_movements" WHERE "id" = NEW."reversal_of_id";

	IF orig."reversal_of_id" IS NOT NULL THEN
		RAISE EXCEPTION 'cannot reverse a reversal (movement %)', NEW."reversal_of_id";
	END IF;
	IF orig."item_id" <> NEW."item_id" OR orig."location_id" <> NEW."location_id" THEN
		RAISE EXCEPTION 'a reversal must name the same item and location as the movement it reverses';
	END IF;
	IF orig."quantity" <> -NEW."quantity" THEN
		RAISE EXCEPTION 'a reversal must be the exact opposite quantity: % reverses %', NEW."quantity", orig."quantity";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

-- ⭐ BEFORE INSERT, NOT deferred — and the timing is the point.
--
-- This check needs no other row of the statement: the movement being reversed already exists. If
-- it were deferred like the balance guard, both would fire at COMMIT and the balance one would win
-- by trigger name — so a reversal naming the WRONG LOCATION was reported as "stock would go
-- negative", which is true, useless, and sends the reader to the wrong problem entirely.
--
-- ⚠️ Found by `stock-ledger.test.ts`, which asserted the specific reason rather than merely that
-- something was refused. A test that only checks "it threw" would have passed on the wrong error.
CREATE TRIGGER "stock_movements_reversal_matches_trg"
	BEFORE INSERT ON "stock_movements"
	FOR EACH ROW EXECUTE FUNCTION "stock_movements_reversal_matches"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. RLS — ENABLE and FORCE, added as the table is created (bible row 112).
--
-- ⚠️ FORCE is the half that is silently missed: without it the table OWNER bypasses every policy,
-- and the owner is the connection the app uses. T-120's invariant 9 catches the omission; it
-- should never have to.
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "stock_movements_org_isolation" ON "stock_movements"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
