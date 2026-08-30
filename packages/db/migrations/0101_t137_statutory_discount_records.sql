-- 0065 — T-137: the per-transaction SC/PWD statutory discount record.
--
-- HAND-WRITTEN, like 0020-0064. See DEF-073 for why `db:generate` cannot be used here, and
-- DEF-069 for why this migration's `meta/_journal.json` row carries `previous.when + 86400000`
-- rather than `Date.now()` — the series is a monotonic ordinal, not a clock, and a `when` behind
-- it makes drizzle skip the migration while still printing "Migrations applied".
--
-- ⛔ THIS TABLE POSTS NOTHING. Bible row 75: Shareat System is a management ledger and must never
-- be labelled or exported as BIR-ready output; a statutory basis is "a separate reporting layer
-- over the same ledger — not a retrofit of these accounts". So this record sits BESIDE the books.
-- `sales_days.senior_discount` / `pwd_discount` continue to 4900 as contra-revenue (row 132) and
-- are neither derived from these rows nor a source for them.
--
-- ⚠️ No VAT is computed here. The amounts are recorded as the till computed them.
--
-- Required by RR 5-2017 §5.9 (PWD) and RR 7-2010 (senior) — two regulations, one record shape,
-- different ID documents. Six fields, all present below, including the INVOICE NUMBER the
-- original T-137 spec omitted.

CREATE TABLE "statutory_discount_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,

	-- The date of the SALE, never of the data entry. A January transcription of a December sale
	-- is a December record.
	"business_date" date NOT NULL,
	-- Reg field 6. Also the join back to POS's receipt when POS v2 writes these rows itself.
	"invoice_number" text NOT NULL,
	-- Which statute. An OSCA ID is not a PWD ID, so this is not cosmetic labelling.
	"kind" text NOT NULL,
	-- Reg field 2. No format enforced: LGU-issued, formats vary by city, a regex would reject
	-- valid cards.
	"id_number" text NOT NULL,
	-- Reg field 1.
	"holder_name" text NOT NULL,
	-- Reg field 3, BEFORE the discount.
	"gross_amount" numeric(14, 2) NOT NULL,
	-- Reg field 4. The net is derived, never stored - a stored net is a third number that can
	-- disagree with the two defining it.
	"discount_amount" numeric(14, 2) NOT NULL,

	-- ⚠️ NULLABLE DELIBERATELY - not in the regulation text. "Establishment signatory" is
	-- practitioner guidance; the reg-level signature is the CUSTOMER's (RR 10-2015), and RR 8-2023
	-- waives even that for online and mobile-app orders. Cannot be NOT NULL without inventing an
	-- obligation the law does not impose.
	"signatory" text,

	-- ⭐ Provenance. Every row is 'transcribed' until POS v2 exists; then POS writes 'pos' rows
	-- into this same table with no migration. Same lesson as sales_days.pos_sourced.
	"source" text DEFAULT 'transcribed' NOT NULL,

	"notes" text,
	"recorded_by" uuid NOT NULL,

	-- ⛔ Void, never DELETE. The burden of proof in a BIR audit is on the seller, so the register
	-- must show that a row existed and was withdrawn, and by whom.
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,

	CONSTRAINT "statutory_discount_records_kind_check" CHECK ("kind" in ('senior', 'pwd')),
	CONSTRAINT "statutory_discount_records_source_check" CHECK ("source" in ('transcribed', 'pos')),
	-- POSITIVE, not merely non-negative: a zero-peso discount is not a discount and a zero gross
	-- is not a sale. Either means the row was entered wrong, and a register full of zero rows is
	-- worse than a short one.
	CONSTRAINT "statutory_discount_records_amounts_positive_check" CHECK ("gross_amount" > 0 and "discount_amount" > 0),
	CONSTRAINT "statutory_discount_records_discount_within_gross_check" CHECK ("discount_amount" <= "gross_amount"),
	-- A void is all three columns or none. Half a void is a row nobody can interpret.
	CONSTRAINT "statutory_discount_records_void_triple_check" CHECK (
		("voided_at" is null and "voided_by" is null and "void_reason" is null)
		or ("voided_at" is not null and "voided_by" is not null and "void_reason" is not null)
	),
	-- NOT NULL stops a NULL; this stops the empty string that gets typed instead. Identity is the
	-- whole point of the record.
	CONSTRAINT "statutory_discount_records_identity_present_check" CHECK (
		length(btrim("holder_name")) > 0
		and length(btrim("id_number")) > 0
		and length(btrim("invoice_number")) > 0
	)
);
--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_recorded_by_persons_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- ⭐ ONE LIVE RECORD PER INVOICE - this is the "one discount only" rule (a PWD who is also a
-- senior claims one 20%, not both), enforced by the database rather than re-checked in TypeScript.
-- Partial on `voided_at is null` so a mistyped row can be voided and re-entered against the same
-- invoice, which a total unique index would block forever.
CREATE UNIQUE INDEX "statutory_discount_records_live_invoice_key" ON "statutory_discount_records" USING btree ("org_id","store_id","business_date","invoice_number") WHERE "statutory_discount_records"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "statutory_discount_records_org_id_store_id_business_date_idx" ON "statutory_discount_records" USING btree ("org_id","store_id","business_date");--> statement-breakpoint
CREATE INDEX "statutory_discount_records_org_id_business_date_idx" ON "statutory_discount_records" USING btree ("org_id","business_date");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS. `org_column` scoping, identical to every other org-bearing table (ADR-008 §9).
-- A franchise owner must never read another org's statutory register: it names customers.
ALTER TABLE "statutory_discount_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "statutory_discount_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "statutory_discount_records_org_isolation" ON "statutory_discount_records"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
