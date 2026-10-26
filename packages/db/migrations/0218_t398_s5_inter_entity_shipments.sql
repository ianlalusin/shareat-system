-- 0218 - T-398 S5 (S5b): the inter-entity shipment - the ONE defined cross-organisation handoff (Padre Garcia).
-- docs/tasks/398-padre-garcia-franchise-org.md section 0b + S5 (R5, A3, A4, A6, A10, C5), docs/tasks/398-s5/{S5-REFRESH,QUESTIONS,TESTS}.md.
-- Hand-authored per ADR-012 s5 (db:generate is retired, DEF-242). Journal head when written: 0216 (0217 is in open PR #69).
--
-- WHY. The commissary sells to Padre Garcia, a SEPARATE organisation, as a true sale on both sides. The two sides are tied by a shipment
-- note the commissary writes in the SAME transaction as its sale: what was sent, how many, at what price. Padre Garcia may READ the note
-- and, through one function, stamp "received" on it. Nothing else crosses organisations: no cost, no stock layer, no person name, no other
-- order. Money is numeric, never float.
--
-- WHAT THIS MIGRATION ADDS.
--   1. suppliers.counterparty_org_id (uuid, NULL -> organizations): Padre Garcia's supplier row for the commissary. CHECK: at most one of
--      counterparty_store_id / counterparty_org_id (ADR-008 s2, the customers_one_counterparty_check shape).
--   2. customers.credit_terms_days (integer, NULL, CHECK 0..365) - the suppliers_credit_terms_days_check shape (C5). Display and ageing only.
--   3. inter_entity_shipments (seller-owned: org_id = the commissary, buyer_org_id = the franchise, buyer_org_id <> org_id). One per trade
--      order (UNIQUE trade_order_id, A4). Same-org composites to trade_orders and stores. received_by is the ONE person reference written by the
--      buyer, so it is checked against the BUYER's organisation: (buyer_org_id, received_by) -> persons (org_id, id). Status in_transit / received
--      / void with consistency CHECKs. UNIQUE (org_id, id), (buyer_org_id, id) [the target of the deliveries link, A6], (org_id, buyer_org_id, id).
--   4. inter_entity_shipment_lines: org_id + buyer_org_id repeated (QO-7), composite (org_id, buyer_org_id, shipment_id) -> shipments, composite
--      (org_id, trade_order_line_id) -> trade_order_lines. The snapshot carries NO cost and NO person name (E24). received_quantity (QI-1 (a)):
--      what the buyer counted at the door, per item, CHECK 0 <= received_quantity <= quantity (E20 backstop). line_total = round(quantity x rate, 2).
--   5. RLS on both: ENABLE + FORCE. SELECT: org_id = app_current_org() OR buyer_org_id = app_current_org() (the only policies that name
--      buyer_org_id). INSERT and UPDATE: org_id = app_current_org() only. No DELETE policy and no DELETE grant. The registry gains the scope
--      'dual_org_counterparty' (A10); only these two tables use it.
--   6. Trigger inter_entity_shipments_link_check_trg: the pair of organisations must be LINKED - the order's customer carries
--      counterparty_org_id = buyer_org_id (decided ruling, 25 Oct). A shipment to an unlinked organisation, or for an external customer, is refused.
--      Written by anyone but the shipping organisation: 42501 (the same refusal RLS gives, raised first so the answer does not depend on trigger
--      order). The lookup is by the order's own org; it runs as the INVOKER, under RLS (a SECURITY DEFINER lookup would see every organisation).
--   7. deliveries.inter_entity_shipment_id (uuid, NULL). FK (org_id, inter_entity_shipment_id) -> inter_entity_shipments (buyer_org_id, id)
--      (A6, E19): only the BUYER can point a delivery at the shipment; the seller and a third organisation cannot. Partial UNIQUE over live
--      (non-void) deliveries (E8). New kind 'inter_entity': CHECK (kind = 'inter_entity') = (inter_entity_shipment_id IS NOT NULL); the proof-photo
--      rule is waived for it (the shipment is the evidence, QO-4); the supplier is required for it (QO-4 (a)).
--   8. Three SECURITY DEFINER functions, search_path pinned, EXECUTE revoked from PUBLIC and granted to shareat_app only:
--        receive_inter_entity_shipment(p_shipment_id uuid, p_lines jsonb) - A4. Locks the shipment FOR UPDATE; refuses unless buyer_org_id =
--          app_current_org(); refuses void / already received; refuses a received quantity above the shipped quantity; stamps received_at,
--          received_by (the app.person_id of the caller), received_total (per line round(received x rate, 2), summed) and each line's
--          received_quantity. Every line must be named exactly once (a short line is stated as 0.000, never left out).
--        inter_entity_buyer_posted(p_shipment_ids uuid[]) - A3. Only the SELLER's own shipments, only those received; returns exactly
--          (shipment_id, received_on, posted_total), read from the buyer's posted receipt entry. Nothing else of the buyer's journal.
--        inter_entity_counterparty_balance() - QI-1 (a): one figure per linked organisation, what it owes the caller (its payable to the
--          caller's supplier row, from its 2110 control account). No cost, price, supplier, person or item column.
--      The functions run as the table owner, so they depend on the owner role bypassing RLS, as the cutover purge and the owner-run migrations
--      already do; every filter they need is written out in the SQL, none is left to RLS.
--   9. scheduler_runs_job_check restates the WHOLE list of 0216 UNCHANGED (0209's pattern; a deliberate no-op restatement). 'inter_entity_reconcile' is
--      NOT in it: it is added with the job function, ops unit pair, script and the SCHEDULER_JOBS entry together in S5e.
--  10. trade_discrepancies: disposition += 'franchise_credit' (paired with direction 'short'); nullable inter_entity_shipment_line_id with the
--      composite (org_id, inter_entity_shipment_line_id) -> inter_entity_shipment_lines (org_id, id). QO-2: the day-open block excludes
--      inter-entity rows (domain code, S5e).
--
-- DECISION RECORDED. A4 / E18: one shipment per order, so a retried dispatch cannot write a second. A6: the cross-organisation FK is a declared
-- composite, not a CROSS_ORG_BY_DESIGN exemption (that list stays empty).
--
-- RECEIPT GUARD. Two more BEFORE triggers (inter_entity_shipments_receipt_guard_trg, inter_entity_shipment_lines_receipt_guard_trg) refuse, with 42501
-- naming "received", any write of received_at / received_by / received_total / status -> received / received_quantity by the app role itself
-- (current_user = shareat_app). The definer function runs as the table owner, so only receive_inter_entity_shipment() can write the receipt; the seller
-- cannot forge the buyer's evidence. The check is the role, not a setting the app could switch on. Owner-run fixtures and the purge are unaffected.
--
--
-- FREEZE AND SUM (S5 audit, 25 Oct). Two more BEFORE UPDATE triggers (inter_entity_shipments_freeze_guard_trg, inter_entity_shipment_lines_freeze_guard_trg)
-- refuse, 42501, any change by the app role to billed_total / credited_total / the organisations / the order link (header) or quantity / rate / line_total /
-- item_name / unit / links (line) once the shipment is not in_transit; credited_total then moves only on the owner / definer path. Two DEFERRABLE INITIALLY
-- DEFERRED constraint triggers (inter_entity_shipments_billed_sum_trg, inter_entity_shipment_lines_billed_sum_trg) enforce billed_total = sum(line_total) at
-- commit (23514); a header with no lines yet is tolerated. The 12 ADD CONSTRAINTs on existing tables are NOT VALID then VALIDATEd; DROP CONSTRAINT is plain.
--
-- TRIGGER CLASS (triggers/registry.ts): inter_entity_shipments_link_check_trg reads the order and customer rows of the shipping organisation,
-- other rows' current state, so it is a validator / origin.
--
-- LOCK BUDGET (ADR-012 s5).
--   * First statement: SET LOCAL lock_timeout = '5s' (resets at commit); the last statement is RESET lock_timeout. A deploy that hits it is
--     re-run, never edited.
--   * Lock mode: each ALTER of the live tables deliveries, suppliers, customers, scheduler_runs and trade_discrepancies takes ACCESS EXCLUSIVE
--     for the statement (ADD COLUMN of a nullable column without a default rewrites nothing). The ADD CONSTRAINT ... CHECK / FOREIGN KEY
--     statements scan the table once under that lock: deliveries, suppliers, customers, trade_discrepancies and scheduler_runs are small
--     (thousands of rows). The new tables are empty. Drizzle applies pending migrations in ONE transaction, so those locks last until COMMIT.
--     NOT VALID + VALIDATE CONSTRAINT in the same transaction does NOT shorten the lock (the ADD COLUMN / DROP CONSTRAINT already hold ACCESS
--     EXCLUSIVE to COMMIT); it only keeps the shape conventional.
--   * Budget: re-time on a restore before the deploy; the ceiling is 60 s (D8). Do not deploy 05:30-07:00 Manila (the POS import window).
--
-- Every statement is its own breakpoint; the last statement closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "counterparty_org_id" uuid;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_counterparty_org_id_organizations_id_fk" FOREIGN KEY ("counterparty_org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "suppliers" VALIDATE CONSTRAINT "suppliers_counterparty_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_one_counterparty_check" CHECK (num_nonnulls("counterparty_store_id", "counterparty_org_id") <= 1) NOT VALID;
--> statement-breakpoint
ALTER TABLE "suppliers" VALIDATE CONSTRAINT "suppliers_one_counterparty_check";

--> statement-breakpoint
CREATE INDEX "suppliers_counterparty_org_idx" ON "suppliers" ("counterparty_org_id");
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "credit_terms_days" integer;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_terms_days_check" CHECK ("credit_terms_days" IS NULL OR ("credit_terms_days" >= 0 AND "credit_terms_days" <= 365)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "customers" VALIDATE CONSTRAINT "customers_credit_terms_days_check";

--> statement-breakpoint
CREATE TABLE "inter_entity_shipments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"buyer_org_id" uuid NOT NULL,
	"trade_order_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"shipped_on" date NOT NULL,
	"bir_invoice_no" text,
	"billed_total" numeric(14,2) NOT NULL,
	"credited_total" numeric(14,2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'in_transit' NOT NULL,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"received_total" numeric(14,2),
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "inter_entity_shipments_trade_order_id_key" UNIQUE ("trade_order_id"),
	CONSTRAINT "inter_entity_shipments_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "inter_entity_shipments_buyer_org_id_id_unique" UNIQUE ("buyer_org_id", "id"),
	CONSTRAINT "inter_entity_shipments_org_buyer_id_unique" UNIQUE ("org_id", "buyer_org_id", "id"),
	CONSTRAINT "inter_entity_shipments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipments_buyer_org_id_organizations_id_fk" FOREIGN KEY ("buyer_org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipments_trade_order_id_same_org_fk" FOREIGN KEY ("org_id", "trade_order_id") REFERENCES "trade_orders" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipments_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "stores" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipments_voided_by_same_org_fk" FOREIGN KEY ("org_id", "voided_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipments_received_by_buyer_org_fk" FOREIGN KEY ("buyer_org_id", "received_by") REFERENCES "persons" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipments_billed_total_finite_check" CHECK ("billed_total" > '-Infinity'::numeric AND "billed_total" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipments_credited_total_finite_check" CHECK ("credited_total" > '-Infinity'::numeric AND "credited_total" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipments_received_total_finite_check" CHECK ("received_total" > '-Infinity'::numeric AND "received_total" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipments_buyer_differs_check" CHECK ("buyer_org_id" <> "org_id"),
	CONSTRAINT "inter_entity_shipments_status_check" CHECK ("status" IN ('in_transit', 'received', 'void')),
	CONSTRAINT "inter_entity_shipments_billed_total_check" CHECK ("billed_total" > 0 AND "billed_total" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipments_credited_total_check" CHECK ("credited_total" >= 0 AND "credited_total" <= "billed_total"),
	CONSTRAINT "inter_entity_shipments_received_shape_check" CHECK (
		("status" = 'received' AND "received_at" IS NOT NULL AND "received_by" IS NOT NULL AND "received_total" IS NOT NULL)
		OR ("status" <> 'received' AND "received_at" IS NULL AND "received_by" IS NULL AND "received_total" IS NULL)
	),
	CONSTRAINT "inter_entity_shipments_received_total_check" CHECK ("received_total" IS NULL OR ("received_total" >= 0 AND "received_total" <= "billed_total")),
	CONSTRAINT "inter_entity_shipments_void_shape_check" CHECK (
		("status" = 'void' AND "voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
		OR ("status" <> 'void' AND "voided_at" IS NULL AND "voided_by" IS NULL AND "void_reason" IS NULL)
	)
);
--> statement-breakpoint
CREATE INDEX "inter_entity_shipments_org_status_idx" ON "inter_entity_shipments" ("org_id", "status", "shipped_on");
--> statement-breakpoint
CREATE INDEX "inter_entity_shipments_buyer_status_idx" ON "inter_entity_shipments" ("buyer_org_id", "status", "shipped_on");
--> statement-breakpoint
CREATE TABLE "inter_entity_shipment_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"buyer_org_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"trade_order_line_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_name" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(14,3) NOT NULL,
	"rate" numeric(14,2) NOT NULL,
	"line_total" numeric(14,2) NOT NULL,
	"received_quantity" numeric(14,3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inter_entity_shipment_lines_shipment_line_no_key" UNIQUE ("shipment_id", "line_no"),
	CONSTRAINT "inter_entity_shipment_lines_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "inter_entity_shipment_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipment_lines_shipment_same_pair_fk" FOREIGN KEY ("org_id", "buyer_org_id", "shipment_id") REFERENCES "inter_entity_shipments" ("org_id", "buyer_org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipment_lines_trade_order_line_id_same_org_fk" FOREIGN KEY ("org_id", "trade_order_line_id") REFERENCES "trade_order_lines" ("org_id", "id") ON DELETE RESTRICT,
	CONSTRAINT "inter_entity_shipment_lines_quantity_finite_check" CHECK ("quantity" > '-Infinity'::numeric AND "quantity" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipment_lines_rate_finite_check" CHECK ("rate" > '-Infinity'::numeric AND "rate" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipment_lines_line_total_finite_check" CHECK ("line_total" > '-Infinity'::numeric AND "line_total" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipment_lines_received_quantity_finite_check" CHECK ("received_quantity" > '-Infinity'::numeric AND "received_quantity" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipment_lines_line_no_check" CHECK ("line_no" > 0),
	CONSTRAINT "inter_entity_shipment_lines_quantity_check" CHECK ("quantity" > 0 AND "quantity" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipment_lines_rate_check" CHECK ("rate" >= 0 AND "rate" < 'Infinity'::numeric),
	CONSTRAINT "inter_entity_shipment_lines_line_total_check" CHECK ("line_total" = round("quantity" * "rate", 2)),
	CONSTRAINT "inter_entity_shipment_lines_received_quantity_check" CHECK ("received_quantity" IS NULL OR ("received_quantity" >= 0 AND "received_quantity" <= "quantity"))
);
--> statement-breakpoint
ALTER TABLE "inter_entity_shipments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inter_entity_shipments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "inter_entity_shipments_select" ON "inter_entity_shipments" FOR SELECT
	USING ("org_id" = app_current_org() OR "buyer_org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "inter_entity_shipments_insert" ON "inter_entity_shipments" FOR INSERT
	WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "inter_entity_shipments_update" ON "inter_entity_shipments" FOR UPDATE
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
ALTER TABLE "inter_entity_shipment_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inter_entity_shipment_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "inter_entity_shipment_lines_select" ON "inter_entity_shipment_lines" FOR SELECT
	USING ("org_id" = app_current_org() OR "buyer_org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "inter_entity_shipment_lines_insert" ON "inter_entity_shipment_lines" FOR INSERT
	WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "inter_entity_shipment_lines_update" ON "inter_entity_shipment_lines" FOR UPDATE
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "inter_entity_shipments", "inter_entity_shipment_lines" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "inter_entity_shipments", "inter_entity_shipment_lines" TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "inter_entity_shipments_check_link"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
	v_linked uuid;
BEGIN
	IF app_current_org() IS NOT NULL AND NEW."org_id" <> app_current_org() THEN
		RAISE EXCEPTION 'A shipment can only be written by the organisation that ships it.' USING ERRCODE = '42501';
	END IF;
	SELECT c."counterparty_org_id" INTO v_linked
	FROM "trade_orders" o
	JOIN "customers" c ON c."org_id" = o."org_id" AND c."id" = o."customer_id"
	WHERE o."id" = NEW."trade_order_id" AND o."org_id" = NEW."org_id";
	IF NOT FOUND THEN
		-- No such order in the shipping organisation: the composite foreign key (org_id, trade_order_id) refuses it (23503) just after this trigger.
		RETURN NEW;
	END IF;
	IF v_linked IS DISTINCT FROM NEW."buyer_org_id" THEN
		RAISE EXCEPTION 'The buyer is not linked as a franchise of this order''s customer, so this order cannot be shipped to it.'
			USING ERRCODE = '23514', CONSTRAINT = 'inter_entity_shipments_link_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "inter_entity_shipments_check_link"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "inter_entity_shipments_link_check_trg"
	BEFORE INSERT OR UPDATE OF "org_id", "buyer_org_id", "trade_order_id" ON "inter_entity_shipments"
	FOR EACH ROW EXECUTE FUNCTION "inter_entity_shipments_check_link"();
--> statement-breakpoint
CREATE FUNCTION "inter_entity_shipments_guard_receipt"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
	IF current_user = 'shareat_app' AND (
		(TG_OP = 'INSERT' AND (NEW."status" = 'received' OR NEW."received_at" IS NOT NULL OR NEW."received_by" IS NOT NULL OR NEW."received_total" IS NOT NULL))
		OR (TG_OP = 'UPDATE' AND (
			NEW."received_at" IS DISTINCT FROM OLD."received_at" OR NEW."received_by" IS DISTINCT FROM OLD."received_by"
			OR NEW."received_total" IS DISTINCT FROM OLD."received_total" OR (NEW."status" = 'received' AND OLD."status" <> 'received')))
	) THEN
		RAISE EXCEPTION 'Only the receiving organisation can record that a shipment was received.' USING ERRCODE = '42501';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "inter_entity_shipments_guard_receipt"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "inter_entity_shipments_receipt_guard_trg"
	BEFORE INSERT OR UPDATE ON "inter_entity_shipments"
	FOR EACH ROW EXECUTE FUNCTION "inter_entity_shipments_guard_receipt"();
--> statement-breakpoint
CREATE FUNCTION "inter_entity_shipment_lines_guard_receipt"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
	IF current_user = 'shareat_app' AND (
		(TG_OP = 'INSERT' AND NEW."received_quantity" IS NOT NULL)
		OR (TG_OP = 'UPDATE' AND NEW."received_quantity" IS DISTINCT FROM OLD."received_quantity")
	) THEN
		RAISE EXCEPTION 'Only the receiving organisation can record the received quantity of a shipment line.' USING ERRCODE = '42501';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "inter_entity_shipment_lines_guard_receipt"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "inter_entity_shipment_lines_receipt_guard_trg"
	BEFORE INSERT OR UPDATE ON "inter_entity_shipment_lines"
	FOR EACH ROW EXECUTE FUNCTION "inter_entity_shipment_lines_guard_receipt"();
--> statement-breakpoint
CREATE FUNCTION "inter_entity_shipments_guard_freeze"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
	-- Once the shipment has left in_transit (received or void) the shipping organisation can no longer rewrite its money or identity.
	-- The role is the test, as in the receipt guard: the owner / definer path (credit notes, purge, fixtures) is unaffected.
	IF current_user = 'shareat_app' AND OLD."status" <> 'in_transit' AND (
		NEW."status" IS DISTINCT FROM OLD."status" OR NEW."billed_total" IS DISTINCT FROM OLD."billed_total" OR NEW."credited_total" IS DISTINCT FROM OLD."credited_total"
		OR NEW."org_id" IS DISTINCT FROM OLD."org_id" OR NEW."buyer_org_id" IS DISTINCT FROM OLD."buyer_org_id"
		OR NEW."trade_order_id" IS DISTINCT FROM OLD."trade_order_id"
	) THEN
		RAISE EXCEPTION 'A shipment that is already received or void can no longer have its status, amounts, organisations or order changed.' USING ERRCODE = '42501';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "inter_entity_shipments_guard_freeze"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "inter_entity_shipments_freeze_guard_trg"
	BEFORE UPDATE ON "inter_entity_shipments"
	FOR EACH ROW EXECUTE FUNCTION "inter_entity_shipments_guard_freeze"();
--> statement-breakpoint
CREATE FUNCTION "inter_entity_shipment_lines_guard_freeze"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
	v_new text;
	v_old text;
BEGIN
	IF current_user = 'shareat_app' AND (
		TG_OP = 'INSERT'
		OR NEW."quantity" IS DISTINCT FROM OLD."quantity" OR NEW."rate" IS DISTINCT FROM OLD."rate" OR NEW."line_total" IS DISTINCT FROM OLD."line_total"
		OR NEW."item_name" IS DISTINCT FROM OLD."item_name" OR NEW."unit" IS DISTINCT FROM OLD."unit"
		OR NEW."trade_order_line_id" IS DISTINCT FROM OLD."trade_order_line_id" OR NEW."shipment_id" IS DISTINCT FROM OLD."shipment_id"
		OR NEW."org_id" IS DISTINCT FROM OLD."org_id" OR NEW."buyer_org_id" IS DISTINCT FROM OLD."buyer_org_id"
	) THEN
		-- FOR SHARE: waits for a concurrent receive (it holds the header FOR UPDATE) and re-reads the status, so a line cannot land on a shipment just received.
		SELECT s."status" INTO v_new FROM "inter_entity_shipments" s WHERE s."id" = NEW."shipment_id" FOR SHARE;
		IF TG_OP = 'UPDATE' THEN
			SELECT s."status" INTO v_old FROM "inter_entity_shipments" s WHERE s."id" = OLD."shipment_id" FOR SHARE;
		END IF;
		-- A shipment the caller cannot see (or that does not exist) is left to RLS and the foreign key.
		IF (v_new IS NOT NULL AND v_new <> 'in_transit') OR (v_old IS NOT NULL AND v_old <> 'in_transit') THEN
			RAISE EXCEPTION 'A line of a shipment that is already received or void can no longer be added, moved or have its item, quantity or price changed.' USING ERRCODE = '42501';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "inter_entity_shipment_lines_guard_freeze"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "inter_entity_shipment_lines_freeze_guard_trg"
	BEFORE INSERT OR UPDATE ON "inter_entity_shipment_lines"
	FOR EACH ROW EXECUTE FUNCTION "inter_entity_shipment_lines_guard_freeze"();
--> statement-breakpoint
CREATE FUNCTION "inter_entity_shipments_check_billed_sum"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
	v_ids uuid[];
	v_org uuid;
	v_prev text;
	v_id uuid;
	v_billed numeric;
	v_sum numeric;
	v_n bigint;
	v_found boolean;
BEGIN
	-- The check must not depend on the org context the session carries when it runs at commit (RLS would hide the header and the check would
	-- skip). It runs as the invoker (no new definer), and sets app.org_id to the ROW's own organisation (the shipping organisation, the only one
	-- that can write these rows) for the two lookups, then puts the previous value back. Deferred to the end of the transaction: a header is written before its lines. A header with no lines yet is tolerated.
	IF TG_TABLE_NAME = 'inter_entity_shipments' THEN
		IF TG_OP = 'DELETE' THEN
			RETURN NULL;
		END IF;
		v_ids := ARRAY[NEW."id"];
		v_org := NEW."org_id";
	ELSE
		v_org := CASE WHEN TG_OP = 'DELETE' THEN OLD."org_id" ELSE NEW."org_id" END;
		v_ids := ARRAY[]::uuid[];
		IF TG_OP <> 'DELETE' THEN v_ids := v_ids || NEW."shipment_id"; END IF;
		IF TG_OP <> 'INSERT' THEN v_ids := v_ids || OLD."shipment_id"; END IF;
	END IF;
	v_prev := coalesce(current_setting('app.org_id', true), '');
	FOR v_id IN SELECT DISTINCT x FROM unnest(v_ids) x LOOP
		PERFORM set_config('app.org_id', v_org::text, true);
		SELECT s."billed_total" INTO v_billed FROM "inter_entity_shipments" s WHERE s."id" = v_id;
		v_found := FOUND;
		SELECT count(*), coalesce(sum(l."line_total"), 0) INTO v_n, v_sum FROM "inter_entity_shipment_lines" l WHERE l."shipment_id" = v_id;
		PERFORM set_config('app.org_id', v_prev, true);
		IF NOT v_found THEN
			-- Header gone (a purge deletes lines, then the header): nothing to check. Lines without a header cannot stand.
			IF v_n > 0 THEN
				RAISE EXCEPTION 'A shipment line has no shipment header.' USING ERRCODE = '23514', CONSTRAINT = 'inter_entity_shipments_billed_sum_check';
			END IF;
			CONTINUE;
		END IF;
		IF v_n > 0 AND v_sum <> v_billed THEN
			RAISE EXCEPTION 'The shipment total % does not equal the sum of its lines %.', v_billed, v_sum
				USING ERRCODE = '23514', CONSTRAINT = 'inter_entity_shipments_billed_sum_check';
		END IF;
	END LOOP;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "inter_entity_shipments_check_billed_sum"() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inter_entity_shipments_billed_sum_trg"
	AFTER INSERT OR UPDATE OF "billed_total" OR DELETE ON "inter_entity_shipments"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "inter_entity_shipments_check_billed_sum"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "inter_entity_shipment_lines_billed_sum_trg"
	AFTER INSERT OR UPDATE OF "line_total", "shipment_id" OR DELETE ON "inter_entity_shipment_lines"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "inter_entity_shipments_check_billed_sum"();
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "inter_entity_shipment_id" uuid;
--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_kind_check";
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_kind_check" CHECK ("kind" IN ('supplier', 'purchase', 'commissary', 'inter_entity')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "deliveries" VALIDATE CONSTRAINT "deliveries_kind_check";

--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_proof_required_check";
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_proof_required_check" CHECK ("kind" IN ('commissary', 'inter_entity') OR "proof_file_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "deliveries" VALIDATE CONSTRAINT "deliveries_proof_required_check";

--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_supplier_required_check";
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_supplier_required_check" CHECK ("kind" NOT IN ('supplier', 'inter_entity') OR "supplier_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "deliveries" VALIDATE CONSTRAINT "deliveries_supplier_required_check";

--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_inter_entity_shipment_check" CHECK (("kind" = 'inter_entity') = ("inter_entity_shipment_id" IS NOT NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "deliveries" VALIDATE CONSTRAINT "deliveries_inter_entity_shipment_check";

--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_inter_entity_shipment_buyer_fk" FOREIGN KEY ("org_id", "inter_entity_shipment_id") REFERENCES "inter_entity_shipments" ("buyer_org_id", "id") ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "deliveries" VALIDATE CONSTRAINT "deliveries_inter_entity_shipment_buyer_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_inter_entity_shipment_live_key" ON "deliveries" ("inter_entity_shipment_id") WHERE "inter_entity_shipment_id" IS NOT NULL AND "status" <> 'void';
--> statement-breakpoint
CREATE FUNCTION "receive_inter_entity_shipment"("p_shipment_id" uuid, "p_lines" jsonb) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	v_org uuid := app_current_org();
	v_person uuid := nullif(current_setting('app.person_id', true), '')::uuid;
	s "inter_entity_shipments"%ROWTYPE;
	l record;
	e jsonb;
	v_line uuid;
	v_qty numeric;
	v_total numeric := 0;
	v_seen uuid[] := ARRAY[]::uuid[];
	v_expected int;
BEGIN
	IF v_org IS NULL OR v_person IS NULL THEN
		RAISE EXCEPTION 'Receiving a shipment needs a signed-in person.' USING ERRCODE = '42501';
	END IF;
	SELECT * INTO s FROM "inter_entity_shipments" WHERE "id" = p_shipment_id AND "buyer_org_id" = v_org FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'This shipment is not addressed to your organisation.' USING ERRCODE = '42501';
	END IF;
	IF s."status" = 'received' THEN
		RAISE EXCEPTION 'This shipment was already received on %.', to_char(s."received_at" AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD')
			USING ERRCODE = '23514', CONSTRAINT = 'inter_entity_shipment_already_received';
	END IF;
	IF s."status" = 'void' THEN
		RAISE EXCEPTION 'This shipment was cancelled by the sender and cannot be received.'
			USING ERRCODE = '23514', CONSTRAINT = 'inter_entity_shipment_void';
	END IF;
	IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
		RAISE EXCEPTION 'Received quantities must be a list of lines.' USING ERRCODE = '22023';
	END IF;
	SELECT count(*) INTO v_expected FROM "inter_entity_shipment_lines" WHERE "shipment_id" = s."id";
	IF v_expected = 0 THEN
		RAISE EXCEPTION 'This shipment has no lines to receive.' USING ERRCODE = '22023';
	END IF;
	FOR e IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
		v_line := (e ->> 'line_id')::uuid;
		IF v_line = ANY (v_seen) THEN
			RAISE EXCEPTION 'A line was counted twice.' USING ERRCODE = '22023';
		END IF;
		v_seen := v_seen || v_line;
		SELECT * INTO l FROM "inter_entity_shipment_lines" WHERE "id" = v_line AND "shipment_id" = s."id";
		IF NOT FOUND THEN
			RAISE EXCEPTION 'A counted line does not belong to this shipment.' USING ERRCODE = '22023';
		END IF;
		v_qty := (e ->> 'received_quantity')::numeric;
		IF v_qty IS NULL OR v_qty < 0 OR v_qty <> round(v_qty, 3) THEN
			RAISE EXCEPTION 'The received quantity of % must be zero or more, with at most three decimals.', l."item_name" USING ERRCODE = '22023';
		END IF;
		IF v_qty > l."quantity" THEN
			RAISE EXCEPTION 'You counted % %, which exceeds the % % shipped for %; the extra is not part of this shipment.',
				v_qty, l."unit", l."quantity", l."unit", l."item_name"
				USING ERRCODE = '23514', CONSTRAINT = 'inter_entity_shipment_lines_received_quantity_check';
		END IF;
		UPDATE "inter_entity_shipment_lines" SET "received_quantity" = v_qty WHERE "id" = l."id";
		v_total := v_total + round(v_qty * l."rate", 2);
	END LOOP;
	IF coalesce(array_length(v_seen, 1), 0) <> v_expected THEN
		RAISE EXCEPTION 'Every line of the shipment must be counted (a line that did not arrive is counted as 0.000).' USING ERRCODE = '22023';
	END IF;
	UPDATE "inter_entity_shipments"
	SET "status" = 'received', "received_at" = now(), "received_by" = v_person, "received_total" = v_total, "updated_at" = now()
	WHERE "id" = s."id";
	RETURN v_total;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "receive_inter_entity_shipment"(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "receive_inter_entity_shipment"(uuid, jsonb) TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "inter_entity_buyer_posted"("p_shipment_ids" uuid[]) RETURNS TABLE ("shipment_id" uuid, "received_on" date, "posted_total" numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
	SELECT s."id", je."entry_date", (SELECT coalesce(sum(jl."debit"), 0) FROM "journal_lines" jl WHERE jl."entry_id" = je."id")
	FROM "inter_entity_shipments" s
	JOIN "deliveries" d ON d."inter_entity_shipment_id" = s."id" AND d."org_id" = s."buyer_org_id" AND d."status" = 'received'
	JOIN "journal_entries" je ON je."org_id" = s."buyer_org_id" AND je."source_type" = 'stock_receipt' AND je."source_id" = d."id"::text AND je."status" = 'posted'
	WHERE s."org_id" = app_current_org() AND s."status" = 'received' AND s."id" = ANY (p_shipment_ids)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inter_entity_buyer_posted"(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inter_entity_buyer_posted"(uuid[]) TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "inter_entity_counterparty_balance"() RETURNS TABLE ("counterparty_org_id" uuid, "counterparty_owes" numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
	SELECT l."counterparty_org_id",
		coalesce((
			SELECT sum(jl."credit" - jl."debit")
			FROM "journal_entries" je
			JOIN "journal_lines" jl ON jl."entry_id" = je."id"
			JOIN "accounts" a ON a."id" = jl."account_id" AND a."org_id" = je."org_id"
			WHERE je."org_id" = l."counterparty_org_id" AND je."status" <> 'draft' AND a."code" = '2110'
				AND jl."party_type" = 'supplier'
				AND jl."party_id" IN (
					SELECT ps."id"::text FROM "suppliers" ps
					WHERE ps."org_id" = l."counterparty_org_id" AND ps."counterparty_org_id" = app_current_org()
				)
		), 0)
	FROM (
		SELECT DISTINCT c."counterparty_org_id" FROM "customers" c
		WHERE c."org_id" = app_current_org() AND c."counterparty_org_id" IS NOT NULL
	) l
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inter_entity_counterparty_balance"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inter_entity_counterparty_balance"() TO "shareat_app";
--> statement-breakpoint
CREATE FUNCTION "inter_entity_counterparty_name"("p_customer_id" uuid) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
	-- S5c: the linked organisation's NAME, for the caller's own customer row only (the order page's "Inter-entity sale to ..."). Nothing else of it.
	SELECT o."name" FROM "customers" c JOIN "organizations" o ON o."id" = c."counterparty_org_id"
	WHERE c."id" = p_customer_id AND c."org_id" = app_current_org()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "inter_entity_counterparty_name"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "inter_entity_counterparty_name"(uuid) TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";
--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay',
	                 'order_wastage_backstop', 'finding_observation', 'budget_reissue', 'recurring_expenses',
	                 'orphan_file_sweep', 'fiscal_period_seed', 'usage_auto_post', 'pos_day_import', 'pos_receipt_bridge')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "scheduler_runs" VALIDATE CONSTRAINT "scheduler_runs_job_check";

--> statement-breakpoint
ALTER TABLE "trade_discrepancies" DROP CONSTRAINT "trade_discrepancies_disposition_check";
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_disposition_check"
	CHECK ("disposition" IS NULL OR "disposition" IN ('audit', 'loss', 'charge', 'late_receipt', 'extra_dispatch', 'return', 'franchise_credit')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" VALIDATE CONSTRAINT "trade_discrepancies_disposition_check";

--> statement-breakpoint
ALTER TABLE "trade_discrepancies" DROP CONSTRAINT "trade_discrepancies_disposition_direction_check";
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_disposition_direction_check"
	CHECK ("disposition" IS NULL OR "disposition" = 'audit'
		OR ("direction" = 'short' AND "disposition" IN ('loss', 'charge', 'late_receipt', 'franchise_credit'))
		OR ("direction" = 'over' AND "disposition" IN ('extra_dispatch', 'return'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" VALIDATE CONSTRAINT "trade_discrepancies_disposition_direction_check";

--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD COLUMN "inter_entity_shipment_line_id" uuid;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_inter_entity_shipment_line_id_same_org_fk" FOREIGN KEY ("org_id", "inter_entity_shipment_line_id") REFERENCES "inter_entity_shipment_lines" ("org_id", "id") ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "trade_discrepancies" VALIDATE CONSTRAINT "trade_discrepancies_inter_entity_shipment_line_id_same_org_fk";

--> statement-breakpoint
CREATE INDEX "trade_discrepancies_inter_entity_line_idx" ON "trade_discrepancies" ("inter_entity_shipment_line_id") WHERE "inter_entity_shipment_line_id" IS NOT NULL;
--> statement-breakpoint
RESET lock_timeout;
