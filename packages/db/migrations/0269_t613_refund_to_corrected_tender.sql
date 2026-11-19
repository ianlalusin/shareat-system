-- 0269 -- T-613 D1: a refund can go back to the method a wrong-payment-method correction moved money TO. docs/tasks/613-money-follow-ups-nov19.md (D1), T-534 S3 + S4.
-- Hand-authored per ADR-012 s5. Journal head on main when written: 0267 (0268 = T-612 is reserved on the board), so this is idx 269 and `when` is two days after 0267 (DEF-039).
--
-- WHY. A refund row said "money goes back to this original paid row, by that row's own tender": FK (payment_id, tender_id) -> pos_sales_receipt_payments(id, tender_id), one refund row per
-- (refund, payment). After S3 moved P300 of a P1,000 cash row to GCash, the cash row could still be refunded all P1,000 (the drawer would pay out P300 it never took) and GCash could not be
-- refunded at all. The domain now caps the row's OWN method at kept - corrected away - refunded, and lets each correction's TARGET method take back up to the corrected amount, as a refund
-- row against the SAME paid row with the TARGET's tender. The two old rules cannot say that.
--
-- WHAT CHANGES. (1) the (payment_id, tender_id) FK is dropped and replaced by the same-org FK on tenders (a tender of this organisation must exist); (2) UNIQUE (refund_id, payment_id) becomes
-- UNIQUE (refund_id, payment_id, tender_id) so a refund can hold the cash row and the corrected-to row of one paid row; (3) a BEFORE INSERT trigger keeps the rule the FK carried:
-- the tender is the paid row's own, OR the target of a correction of that very row. The money caps stay in the domain (recordRefund), as before.
-- NOT CHANGED: no table, no column, no grant; append-only and append-guard triggers; every existing row satisfies the new rules (all carry the paid row's own tender).
ALTER TABLE "pos_refund_payments" DROP CONSTRAINT "pos_refund_payments_tender_of_payment_fk";
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ADD CONSTRAINT "pos_refund_payments_tender_id_same_org_fk"
	FOREIGN KEY ("org_id","tender_id") REFERENCES "tenders"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" DROP CONSTRAINT "pos_refund_payments_refund_payment_unique";
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ADD CONSTRAINT "pos_refund_payments_refund_payment_tender_unique" UNIQUE ("refund_id","payment_id","tender_id");
--> statement-breakpoint
CREATE FUNCTION "pos_refund_payment_tender_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	own_tender uuid;
	found_payment boolean;
BEGIN
	SELECT p."tender_id", true INTO own_tender, found_payment FROM "pos_sales_receipt_payments" p WHERE p."id" = NEW."payment_id";
	-- A payment that does not exist is left to the foreign key.
	IF found_payment AND own_tender IS DISTINCT FROM NEW."tender_id"
		AND NOT EXISTS (SELECT 1 FROM "pos_tender_corrections" c WHERE c."payment_id" = NEW."payment_id" AND c."to_tender_id" = NEW."tender_id") THEN
		RAISE EXCEPTION 'A refund goes back by the method the money was paid with, or the method a correction moved it to (payment %, method % refused).', NEW."payment_id", NEW."tender_id"
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_refund_payment_tender_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pos_refund_payment_tender_guard" BEFORE INSERT ON "pos_refund_payments" FOR EACH ROW EXECUTE FUNCTION "pos_refund_payment_tender_guard"();
--> statement-breakpoint
ALTER TABLE "pos_refund_payments" ENABLE ALWAYS TRIGGER "pos_refund_payment_tender_guard";
