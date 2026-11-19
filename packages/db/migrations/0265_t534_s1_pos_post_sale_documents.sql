-- 0265 -- T-534 S1: the post-sale documents. docs/tasks/534-pos-convert-correction-refund.md (S1); bible rows 272, 351, 356, 359, 391, 402; ADR-015 A4.2.
-- Hand-authored per ADR-012 s5. Journal head on main when written: 0261 (0262-0264 are reserved by other lanes, see shareat-coord/BOARD.md); idx 265, `when` on the one-day grid from 0261.
--
-- WHY. A sales receipt is frozen (0238 freezes the row, 0240 refuses late child rows), so a correction can never edit it. Ian, 19 Nov: Convert (GCash cash-in / cash-out) is built
-- before go-live (1A); a refund goes back the way it was paid, can cover some items only, needs a manager PIN and the internet (2A). Each action is a NEW document, dated when it
-- happens, collected into the next Z through `day_close_id` (set once), idempotent on a `request_id` that is unique per org. This migration is the five tables and their guards.
-- It is INERT: nothing reads or writes them until S2 (Convert), S3 (wrong payment method) and S4 (refund) land.
--
-- THE TABLES (all purge, like the receipts they point at; every one is RLS + FORCE with an org_isolation policy):
--   pos_payment_conversions   Convert: from_tender -> to_tender, amount, note, request_id, a void triple (all or none), day_close_id. NOT a sale (row 359).
--   pos_tender_corrections    a wrong payment method fixed before the Z: moves `amount` of one paid row to another tender.
--   pos_refunds               a refund of a sales receipt: refund_seq (per store), total, reason, approver, request_id, day_close_id. NOT a negative receipt: receipts keep total >= 0.
--   pos_refund_lines          which receipt line, how many, how much (the line's share of what the customer actually paid).
--   pos_refund_payments       which original paid row the money goes back to, by that row's own tender (ruling 2A).
--
-- WHAT THE DATABASE ENFORCES (tests: packages/db/tests/integration/t534-s1-*.test.ts):
--   * CHECKs: amounts > 0 and finite; Convert from <> to; a correction's to_tender <> the payment's own tender (from_tender_id is carried so this IS a CHECK);
--     the void triple is all-or-none; reasons and notes are never blank; reference_no is 4..40 characters when given, as on a receipt payment.
--   * request_id is UNIQUE (org_id, request_id) on the three document tables, so a retried POST is one row (the domain reads the 23505 as "already done").
--   * TRIGGERS, all history_guard / ENABLE ALWAYS (triggers/registry.ts), SET search_path = public, pg_temp, EXECUTE revoked from PUBLIC, 23001 restrict_violation:
--       pos_payment_conversions_frozen        every column frozen except day_close_id and the void triple, each NULL -> value ONCE; DELETE refused (pos_v2_frozen_except_once).
--       pos_payment_conversions_void_before_close   a void is refused once the row has a day close, or in the same write that gives it one (so a closed Z never changes).
--       pos_tender_corrections_frozen / pos_refunds_frozen   frozen except day_close_id, once; DELETE refused (pos_v2_frozen_except_once).
--       pos_refund_lines_append_only / pos_refund_payments_append_only   UPDATE and DELETE refused (pos_v2_refuse_mutation).
--       pos_refund_lines_append_guard / pos_refund_payments_append_guard   BEFORE INSERT: a line or payment is refused when its refund row was NOT written by the current
--           transaction. The 0240 pattern: the parent's `xmin` against `pg_current_xact_id()::xid`. A refund is written once, by one transaction, parent first. A write made
--           inside a SAVEPOINT carries the sub-transaction's id, so S4's domain function must write the refund and its children in the top-level transaction (as completeSale does).
--   * Same-org composites, so nothing can name another store's or another receipt's row: (store_id, receipt_id) -> pos_sales_receipts; (receipt_id, payment_id) and
--     (receipt_id, receipt_line_id) -> the receipt's own payment / line; (payment_id, tender_id) -> that payment's own tender; (refund_id, receipt_id) -> pos_refunds(id, parent_receipt_id).
--     The refund lines and payments carry `receipt_id` (a copy of the refund's parent receipt) for exactly that reason. Four uniques are added on EXISTING tables as their targets
--     (trivially true, id alone is unique): pos_sales_receipts (store_id, id); pos_sales_receipt_lines (receipt_id, id); pos_sales_receipt_payments (receipt_id, id) and (id, tender_id).
--
-- NOT IN THIS SLICE (S2-S4, the domain, under a row lock on the parent receipt): the caps (refunded qty per line <= sold qty, refunded money per payment <= amount - change given,
-- corrected money per payment, sum of a refund's lines = sum of its payments = its total), that a tender is of the document's store (`tenders` has no (store_id, id) unique,
-- as for receipt payments), that a wallet needs a reference_no, the closed-day refusal of a correction, the approval and capabilities.
--
-- GRANTS: SELECT + INSERT for shareat_app on all five. UPDATE only on the columns the guards allow: pos_refunds / pos_tender_corrections (day_close_id);
-- pos_payment_conversions (day_close_id, voided_by, voided_at, void_reason). Never DELETE (0169, DEF-489; T-355 G1 and D3 pin it).
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_store_id_id_unique" UNIQUE ("store_id","id");
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ADD CONSTRAINT "pos_sales_receipt_lines_receipt_id_id_unique" UNIQUE ("receipt_id","id");
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_receipt_id_id_unique" UNIQUE ("receipt_id","id");
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_id_tender_id_unique" UNIQUE ("id","tender_id");
--> statement-breakpoint

CREATE TABLE "pos_payment_conversions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"from_tender_id" uuid NOT NULL,
	"to_tender_id" uuid NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"day_close_id" uuid,
	CONSTRAINT "pos_payment_conversions_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_payment_conversions_org_request_unique" UNIQUE ("org_id","request_id"),
	CONSTRAINT "pos_payment_conversions_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "pos_payment_conversions_tenders_differ_check" CHECK ("from_tender_id" <> "to_tender_id"),
	CONSTRAINT "pos_payment_conversions_note_check" CHECK ("note" IS NULL OR length(btrim("note")) > 0),
	CONSTRAINT "pos_payment_conversions_void_shape_check" CHECK (("voided_at" IS NULL) = ("voided_by" IS NULL) AND ("voided_at" IS NULL) = ("void_reason" IS NULL)),
	CONSTRAINT "pos_payment_conversions_void_reason_check" CHECK ("void_reason" IS NULL OR length(btrim("void_reason")) > 0),
	CONSTRAINT "pos_payment_conversions_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint

CREATE TABLE "pos_tender_corrections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"from_tender_id" uuid NOT NULL,
	"to_tender_id" uuid NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"reference_no" text,
	"reason" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"day_close_id" uuid,
	CONSTRAINT "pos_tender_corrections_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_tender_corrections_org_request_unique" UNIQUE ("org_id","request_id"),
	CONSTRAINT "pos_tender_corrections_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "pos_tender_corrections_tenders_differ_check" CHECK ("from_tender_id" <> "to_tender_id"),
	CONSTRAINT "pos_tender_corrections_reference_no_check" CHECK (length("reference_no") BETWEEN 4 AND 40),
	CONSTRAINT "pos_tender_corrections_reason_check" CHECK (length(btrim("reason")) > 0),
	CONSTRAINT "pos_tender_corrections_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint

CREATE TABLE "pos_refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"parent_receipt_id" uuid NOT NULL,
	"refund_seq" integer NOT NULL,
	"total" numeric(14,2) NOT NULL,
	"reason" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"day_close_id" uuid,
	CONSTRAINT "pos_refunds_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_refunds_org_request_unique" UNIQUE ("org_id","request_id"),
	CONSTRAINT "pos_refunds_store_refund_seq_unique" UNIQUE ("store_id","refund_seq"),
	CONSTRAINT "pos_refunds_id_parent_receipt_unique" UNIQUE ("id","parent_receipt_id"),
	CONSTRAINT "pos_refunds_refund_seq_check" CHECK ("refund_seq" > 0),
	CONSTRAINT "pos_refunds_total_check" CHECK ("total" > 0),
	CONSTRAINT "pos_refunds_reason_check" CHECK (length(btrim("reason")) > 0),
	CONSTRAINT "pos_refunds_total_finite_check" CHECK ("total" > '-Infinity'::numeric AND "total" < 'Infinity'::numeric)
);
--> statement-breakpoint

CREATE TABLE "pos_refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"receipt_line_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	CONSTRAINT "pos_refund_lines_refund_line_unique" UNIQUE ("refund_id","receipt_line_id"),
	CONSTRAINT "pos_refund_lines_qty_check" CHECK ("qty" > 0),
	CONSTRAINT "pos_refund_lines_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "pos_refund_lines_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint

CREATE TABLE "pos_refund_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"tender_id" uuid NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"reference_no" text,
	CONSTRAINT "pos_refund_payments_refund_payment_unique" UNIQUE ("refund_id","payment_id"),
	CONSTRAINT "pos_refund_payments_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "pos_refund_payments_reference_no_check" CHECK (length("reference_no") BETWEEN 4 AND 40),
	CONSTRAINT "pos_refund_payments_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint

-- foreign keys
-- pos_payment_conversions
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_terminal_same_store_fk"
	FOREIGN KEY ("store_id","terminal_id") REFERENCES "pos_terminals"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_from_tender_id_fk"
	FOREIGN KEY ("from_tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_from_tender_id_same_org_fk"
	FOREIGN KEY ("org_id","from_tender_id") REFERENCES "tenders"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_to_tender_id_fk"
	FOREIGN KEY ("to_tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_to_tender_id_same_org_fk"
	FOREIGN KEY ("org_id","to_tender_id") REFERENCES "tenders"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_recorded_by_fk"
	FOREIGN KEY ("recorded_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_recorded_by_same_org_fk"
	FOREIGN KEY ("org_id","recorded_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_voided_by_fk"
	FOREIGN KEY ("voided_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_voided_by_same_org_fk"
	FOREIGN KEY ("org_id","voided_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ADD CONSTRAINT "pos_payment_conversions_day_close_same_store_fk"
	FOREIGN KEY ("store_id","day_close_id") REFERENCES "pos_day_closes"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_tender_corrections
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_receipt_same_store_fk"
	FOREIGN KEY ("store_id","receipt_id") REFERENCES "pos_sales_receipts"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_payment_of_receipt_fk"
	FOREIGN KEY ("receipt_id","payment_id") REFERENCES "pos_sales_receipt_payments"("receipt_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_from_tender_of_payment_fk"
	FOREIGN KEY ("payment_id","from_tender_id") REFERENCES "pos_sales_receipt_payments"("id","tender_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_to_tender_id_fk"
	FOREIGN KEY ("to_tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_to_tender_id_same_org_fk"
	FOREIGN KEY ("org_id","to_tender_id") REFERENCES "tenders"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_approved_by_fk"
	FOREIGN KEY ("approved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_approved_by_same_org_fk"
	FOREIGN KEY ("org_id","approved_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_recorded_by_fk"
	FOREIGN KEY ("recorded_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_recorded_by_same_org_fk"
	FOREIGN KEY ("org_id","recorded_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ADD CONSTRAINT "pos_tender_corrections_day_close_same_store_fk"
	FOREIGN KEY ("store_id","day_close_id") REFERENCES "pos_day_closes"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_refunds
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_terminal_same_store_fk"
	FOREIGN KEY ("store_id","terminal_id") REFERENCES "pos_terminals"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_parent_receipt_same_store_fk"
	FOREIGN KEY ("store_id","parent_receipt_id") REFERENCES "pos_sales_receipts"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_approved_by_fk"
	FOREIGN KEY ("approved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_approved_by_same_org_fk"
	FOREIGN KEY ("org_id","approved_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_recorded_by_fk"
	FOREIGN KEY ("recorded_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_recorded_by_same_org_fk"
	FOREIGN KEY ("org_id","recorded_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refunds" ADD CONSTRAINT "pos_refunds_day_close_same_store_fk"
	FOREIGN KEY ("store_id","day_close_id") REFERENCES "pos_day_closes"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_refund_lines
ALTER TABLE "pos_refund_lines" ADD CONSTRAINT "pos_refund_lines_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_lines" ADD CONSTRAINT "pos_refund_lines_refund_id_fk"
	FOREIGN KEY ("refund_id") REFERENCES "pos_refunds"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_lines" ADD CONSTRAINT "pos_refund_lines_refund_id_same_org_fk"
	FOREIGN KEY ("org_id","refund_id") REFERENCES "pos_refunds"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_lines" ADD CONSTRAINT "pos_refund_lines_refund_receipt_fk"
	FOREIGN KEY ("refund_id","receipt_id") REFERENCES "pos_refunds"("id","parent_receipt_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_lines" ADD CONSTRAINT "pos_refund_lines_line_of_receipt_fk"
	FOREIGN KEY ("receipt_id","receipt_line_id") REFERENCES "pos_sales_receipt_lines"("receipt_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_refund_payments
ALTER TABLE "pos_refund_payments" ADD CONSTRAINT "pos_refund_payments_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ADD CONSTRAINT "pos_refund_payments_refund_id_fk"
	FOREIGN KEY ("refund_id") REFERENCES "pos_refunds"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ADD CONSTRAINT "pos_refund_payments_refund_id_same_org_fk"
	FOREIGN KEY ("org_id","refund_id") REFERENCES "pos_refunds"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ADD CONSTRAINT "pos_refund_payments_refund_receipt_fk"
	FOREIGN KEY ("refund_id","receipt_id") REFERENCES "pos_refunds"("id","parent_receipt_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ADD CONSTRAINT "pos_refund_payments_payment_of_receipt_fk"
	FOREIGN KEY ("receipt_id","payment_id") REFERENCES "pos_sales_receipt_payments"("receipt_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ADD CONSTRAINT "pos_refund_payments_tender_of_payment_fk"
	FOREIGN KEY ("payment_id","tender_id") REFERENCES "pos_sales_receipt_payments"("id","tender_id") ON DELETE RESTRICT;
--> statement-breakpoint

-- RLS
ALTER TABLE "pos_payment_conversions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_payment_conversions_org_isolation" ON "pos_payment_conversions" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_tender_corrections_org_isolation" ON "pos_tender_corrections" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "pos_refunds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_refunds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_refunds_org_isolation" ON "pos_refunds" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "pos_refund_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_refund_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_refund_lines_org_isolation" ON "pos_refund_lines" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_refund_payments_org_isolation" ON "pos_refund_payments" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- indexes
CREATE INDEX "pos_payment_conversions_open_idx" ON "pos_payment_conversions" ("store_id") WHERE "day_close_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "pos_tender_corrections_payment_idx" ON "pos_tender_corrections" ("payment_id");
--> statement-breakpoint
CREATE INDEX "pos_tender_corrections_open_idx" ON "pos_tender_corrections" ("store_id") WHERE "day_close_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "pos_refunds_parent_receipt_idx" ON "pos_refunds" ("parent_receipt_id");
--> statement-breakpoint
CREATE INDEX "pos_refunds_open_idx" ON "pos_refunds" ("store_id") WHERE "day_close_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "pos_refund_lines_receipt_line_idx" ON "pos_refund_lines" ("receipt_line_id");
--> statement-breakpoint
CREATE INDEX "pos_refund_payments_payment_idx" ON "pos_refund_payments" ("payment_id");
--> statement-breakpoint

-- trigger functions. pos_v2_frozen_except_once and pos_v2_refuse_mutation (0238) are reused as they are.
-- A conversion may be voided only while it has no Z: not after, and not in the same write that gives it one (the Z never changes a closed day).
CREATE FUNCTION "pos_payment_conversions_void_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	IF NEW."voided_at" IS DISTINCT FROM OLD."voided_at" AND (OLD."day_close_id" IS NOT NULL OR NEW."day_close_id" IS NOT NULL) THEN
		RAISE EXCEPTION 'A conversion already in a closed day cannot be voided (row %).', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
-- The 0240 pattern for a refund's children: refused when the parent refund row was not written by THIS transaction (xmin = pg_current_xact_id()). A parent that does not exist is left to the foreign key.
CREATE FUNCTION "pos_refund_child_insert_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	parent_xmin xid;
	found_parent boolean;
BEGIN
	SELECT r."xmin", true INTO parent_xmin, found_parent FROM "pos_refunds" r WHERE r."id" = NEW."refund_id";
	IF found_parent AND parent_xmin IS DISTINCT FROM pg_current_xact_id()::xid THEN
		RAISE EXCEPTION 'A refund is written once: nothing may be added to refund % after it was recorded (% refused).', NEW."refund_id", TG_TABLE_NAME
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_payment_conversions_void_guard"() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_refund_child_insert_guard"() FROM PUBLIC;
--> statement-breakpoint

-- triggers
CREATE TRIGGER "pos_payment_conversions_frozen" BEFORE UPDATE OR DELETE ON "pos_payment_conversions" FOR EACH ROW EXECUTE FUNCTION "pos_v2_frozen_except_once"('day_close_id','voided_by','voided_at','void_reason');
--> statement-breakpoint
CREATE TRIGGER "pos_payment_conversions_void_before_close" BEFORE UPDATE ON "pos_payment_conversions" FOR EACH ROW EXECUTE FUNCTION "pos_payment_conversions_void_guard"();
--> statement-breakpoint
CREATE TRIGGER "pos_tender_corrections_frozen" BEFORE UPDATE OR DELETE ON "pos_tender_corrections" FOR EACH ROW EXECUTE FUNCTION "pos_v2_frozen_except_once"('day_close_id');
--> statement-breakpoint
CREATE TRIGGER "pos_refunds_frozen" BEFORE UPDATE OR DELETE ON "pos_refunds" FOR EACH ROW EXECUTE FUNCTION "pos_v2_frozen_except_once"('day_close_id');
--> statement-breakpoint
CREATE TRIGGER "pos_refund_lines_append_only" BEFORE UPDATE OR DELETE ON "pos_refund_lines" FOR EACH ROW EXECUTE FUNCTION "pos_v2_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "pos_refund_payments_append_only" BEFORE UPDATE OR DELETE ON "pos_refund_payments" FOR EACH ROW EXECUTE FUNCTION "pos_v2_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "pos_refund_lines_append_guard" BEFORE INSERT ON "pos_refund_lines" FOR EACH ROW EXECUTE FUNCTION "pos_refund_child_insert_guard"();
--> statement-breakpoint
CREATE TRIGGER "pos_refund_payments_append_guard" BEFORE INSERT ON "pos_refund_payments" FOR EACH ROW EXECUTE FUNCTION "pos_refund_child_insert_guard"();
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ENABLE ALWAYS TRIGGER "pos_payment_conversions_frozen";
--> statement-breakpoint
ALTER TABLE "pos_payment_conversions" ENABLE ALWAYS TRIGGER "pos_payment_conversions_void_before_close";
--> statement-breakpoint
ALTER TABLE "pos_tender_corrections" ENABLE ALWAYS TRIGGER "pos_tender_corrections_frozen";
--> statement-breakpoint
ALTER TABLE "pos_refunds" ENABLE ALWAYS TRIGGER "pos_refunds_frozen";
--> statement-breakpoint
ALTER TABLE "pos_refund_lines" ENABLE ALWAYS TRIGGER "pos_refund_lines_append_only";
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ENABLE ALWAYS TRIGGER "pos_refund_payments_append_only";
--> statement-breakpoint
ALTER TABLE "pos_refund_lines" ENABLE ALWAYS TRIGGER "pos_refund_lines_append_guard";
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ENABLE ALWAYS TRIGGER "pos_refund_payments_append_guard";
--> statement-breakpoint

-- grants: SELECT + INSERT everywhere, named columns for UPDATE, never DELETE
GRANT SELECT, INSERT ON "pos_payment_conversions", "pos_tender_corrections", "pos_refunds", "pos_refund_lines", "pos_refund_payments" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("day_close_id","voided_by","voided_at","void_reason") ON "pos_payment_conversions" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("day_close_id") ON "pos_tender_corrections" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("day_close_id") ON "pos_refunds" TO "shareat_app";
