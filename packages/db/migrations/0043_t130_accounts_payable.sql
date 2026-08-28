-- 0043 — T-130: accounts payable. Suppliers, supplier invoices, AP payments and
-- open-item allocation against the 2110 subledger. docs/tasks/130-accounts-payable.md.
--
-- HAND-WRITTEN, like 0020-0042. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ THE GATE — corrected twice by Ian, directly, mid-spec (task doc §2's own history). No
-- expense — cash or credit — may be recorded until its supplier_invoices row is VERIFIED, cash
-- expenses included, not only credit/AP ones. Verification IS the approval; recording an expense
-- against a verified invoice needs no separate draft step. Enforced below as a hand-written
-- trigger on `expenses` (`expenses_check_invoice_open_for_recording`) — the actual backstop,
-- regardless of which code path writes the row, same reasoning as migration 0007's
-- `journal_lines_check_party_requirement`.
--
-- ⛔ NO stored outstanding/allocated total anywhere. Every AP figure — per supplier, per
-- invoice, the 2110 control total — is summed from journal_lines (DEF-075's pattern, refused
-- the sixth time here).
--
-- ⭐ `money_account_id` on ap_payments is ALWAYS required, never a cashier/office/online label —
-- ADR-010 / DEF-058: "the owner belongs to the ACCOUNT, derived never ticked."
--
-- ⚠️ BACKFILL, not a clean break: this dev database already has ONE pre-existing expense row
-- (voided, no supplier) from earlier smoketesting. A placeholder "Unclassified (pre-T-130
-- backfill)" supplier and a matching already-verified invoice are created per affected org
-- below, sized and dated to each such row exactly, before the new NOT NULL constraints land.
-- Written generically (a loop over whatever rows exist) so this runs correctly against any
-- database, not just the one this migration was authored against.

CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"contact_no" text,
	-- ⭐ System-managed only — v1's SupplierPlain.linkedStoreId comment: "locked down to system
	-- writes only." Surfaced read-only on the ordinary supplier form.
	"counterparty_store_id" uuid,
	-- ⚠️ Coupled to the invoice's own VAT fields — a non-VAT-registered supplier's invoices
	-- must not carry VAT fields (v1: receipt.actions.ts:299-310).
	"vat_status" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"reconciled_as_of" date,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "suppliers_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "suppliers_status_check" CHECK ("status" in ('active','inactive')),
	CONSTRAINT "suppliers_vat_status_check" CHECK ("vat_status" is null or "vat_status" in ('vat_registered','non_vat')),
	CONSTRAINT "suppliers_reconciled_shape_check" CHECK (
		("reconciled_as_of" is null and "reconciled_at" is null and "reconciled_by" is null)
		or ("reconciled_as_of" is not null and "reconciled_at" is not null and "reconciled_by" is not null)
	)
);
--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"invoice_no" text,
	"invoice_date" date NOT NULL,
	-- ⚠️ Typed and real, nullable — v1's equivalent is read via `(expense as any).dueDate`, an
	-- untyped, unreliable field this column replaces. Aging falls back to invoice_date when null.
	"due_date" date,
	"total_amount" numeric(14, 2) NOT NULL,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	-- The evidence — required to reach 'verified' (service-layer rule, not a CHECK: it cannot
	-- safely join out to suppliers to test the commissary exemption). Relocates
	-- expenses.receipt_photo_url / .receipt_file_id (DEF-055).
	"receipt_photo_url" text,
	"receipt_file_id" uuid,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	-- Real, server-recomputed VAT in v1 (receipt.actions.ts:283-325), captured as data. Not yet
	-- posted to a separate input-VAT account — no split exists in POSTING-PATTERNS.md today.
	"vat_type" text,
	"vat_rate" numeric(8, 4),
	"vat_amount" numeric(14, 2),
	"vat_exclusive_amount" numeric(14, 2),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "supplier_invoices_total_positive_check" CHECK ("total_amount" > 0),
	CONSTRAINT "supplier_invoices_status_check" CHECK ("status" in ('pending','verified','voided')),
	CONSTRAINT "supplier_invoices_vat_type_check" CHECK ("vat_type" is null or "vat_type" in ('vatable','zero_rated','exempt','non_vat')),
	-- ⚠️ ONE-DIRECTIONAL, not a biconditional: reaching 'verified' REQUIRES the anchor, but
	-- voiding a previously-verified invoice keeps it as history rather than forcing a clear.
	CONSTRAINT "supplier_invoices_verified_shape_check" CHECK (
		"status" <> 'verified' or ("verified_by" is not null and "verified_at" is not null)
	),
	CONSTRAINT "supplier_invoices_void_shape_check" CHECK (
		"status" <> 'voided' or ("voided_by" is not null and "voided_at" is not null and "void_reason" is not null)
	)
);
--> statement-breakpoint
CREATE TABLE "ap_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	-- ⭐ ALWAYS required — never a cashier/office/online label (ADR-010, DEF-058).
	"money_account_id" uuid NOT NULL,
	-- Attribution only, mirrors expense_payments.cash_request_id's exact role. A REAL FK, unlike
	-- that column's opaque text (written before T-144's cash_requests table existed).
	"cash_request_id" uuid,
	"reference_no" text,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_at" timestamp with time zone,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ap_payments_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "ap_payments_status_check" CHECK ("status" in ('draft','posted','voided')),
	CONSTRAINT "ap_payments_void_shape_check" CHECK (
		"status" <> 'voided' or ("voided_by" is not null and "voided_at" is not null and "void_reason" is not null)
	)
);
--> statement-breakpoint
CREATE TABLE "ap_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ap_payment_id" uuid NOT NULL,
	-- ⚠️ The open item is an EXPENSE (T-122's credit-method booking), not the invoice header
	-- directly — an invoice can back several expense postings over time.
	"expense_id" uuid NOT NULL,
	"amount_applied" numeric(14, 2) NOT NULL,
	CONSTRAINT "ap_payment_allocations_amount_positive_check" CHECK ("amount_applied" > 0)
);
--> statement-breakpoint

ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_counterparty_store_id_stores_id_fk"
	FOREIGN KEY ("counterparty_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_reconciled_by_persons_id_fk"
	FOREIGN KEY ("reconciled_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_suppliers_id_fk"
	FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_verified_by_persons_id_fk"
	FOREIGN KEY ("verified_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_voided_by_persons_id_fk"
	FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_supplier_id_suppliers_id_fk"
	FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_money_account_id_money_accounts_id_fk"
	FOREIGN KEY ("money_account_id") REFERENCES "public"."money_accounts"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_cash_request_id_cash_requests_id_fk"
	FOREIGN KEY ("cash_request_id") REFERENCES "public"."cash_requests"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_journal_entry_id_journal_entries_id_fk"
	FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_created_by_persons_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_voided_by_persons_id_fk"
	FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "ap_payment_allocations" ADD CONSTRAINT "ap_payment_allocations_ap_payment_id_ap_payments_id_fk"
	FOREIGN KEY ("ap_payment_id") REFERENCES "public"."ap_payments"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "ap_payment_allocations" ADD CONSTRAINT "ap_payment_allocations_expense_id_expenses_id_fk"
	FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "suppliers_org_idx" ON "suppliers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "suppliers_counterparty_store_idx" ON "suppliers" USING btree ("counterparty_store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_name_key" ON "suppliers" USING btree ("org_id","name");--> statement-breakpoint

CREATE INDEX "supplier_invoices_org_idx" ON "supplier_invoices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_supplier_idx" ON "supplier_invoices" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_org_status_idx" ON "supplier_invoices" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "supplier_invoices_org_due_date_idx" ON "supplier_invoices" USING btree ("org_id","due_date");--> statement-breakpoint

CREATE UNIQUE INDEX "ap_payment_allocations_payment_expense_key" ON "ap_payment_allocations" USING btree ("ap_payment_id","expense_id");--> statement-breakpoint

-- ===========================================================================================
-- Row-level security — org isolation, PostgreSQL-enforced (bible row 112).
--
-- ⚠️ Uses `app_current_org()`, NOT migration 0042's raw `current_setting('app.org_id', true)::uuid`
-- inline idiom. That idiom is missing `app_current_org()`'s own `NULLIF(..., '')` guard: verified
-- live against shareat_dev that with `app.org_id` set to '' (vs. never set, which correctly denies
-- with zero rows), the raw form throws `22P02 invalid input syntax for type uuid: ""` instead of
-- cleanly denying. Not a live access-control bypass — Postgres still returns zero rows on a policy
-- evaluation error — but a needless crash where the function-wrapped form fails clean. Every
-- migration since 0036 carries the same inline idiom; normalizing all of them is a separate,
-- out-of-scope cleanup (logged, not fixed here) — this migration only holds its own 4 new tables
-- to the safer standard.
-- ===========================================================================================
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "suppliers_org_isolation" ON "suppliers"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

ALTER TABLE "supplier_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "supplier_invoices_org_isolation" ON "supplier_invoices"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

ALTER TABLE "ap_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ap_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ap_payments_org_isolation" ON "ap_payments"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ap_payment_allocations has no org_id of its own — derived through the payment it belongs to,
-- same pattern as expense_payments through expenses (migration 0015).
ALTER TABLE "ap_payment_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ap_payment_allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ap_payment_allocations_via_payment" ON "ap_payment_allocations" FOR ALL
	USING (EXISTS (SELECT 1 FROM "ap_payments" p WHERE p."id" = "ap_payment_allocations"."ap_payment_id" AND p."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "ap_payments" p WHERE p."id" = "ap_payment_allocations"."ap_payment_id" AND p."org_id" = app_current_org()));--> statement-breakpoint

-- ===========================================================================================
-- expenses: supplierId opaque text -> real FK, NOT NULL; supplierInvoiceId added, NOT NULL.
-- The photo gate (DEF-055) relocates to supplier_invoices — receipt_photo_url / receipt_file_id
-- dropped from this table.
--
-- BACKFILL FIRST, then constrain. This dev database carries one pre-existing (voided) expense
-- row with no supplier from earlier smoketesting — a placeholder "Unclassified (pre-T-130
-- backfill)" supplier and an already-verified invoice sized/dated to match are created per
-- affected org below, generically, so this also runs correctly against a database with zero
-- or many such rows.
-- ===========================================================================================
ALTER TABLE "expenses" ADD COLUMN "supplier_invoice_id" uuid;--> statement-breakpoint

DO $$
DECLARE
	r RECORD;
	sup_id uuid;
	inv_id uuid;
	placeholder_name text := 'Unclassified (pre-T-130 backfill)';
BEGIN
	FOR r IN SELECT DISTINCT org_id, created_by FROM expenses WHERE supplier_id IS NULL LOOP
		INSERT INTO suppliers (org_id, name, status, notes, created_by)
		SELECT r.org_id, placeholder_name, 'inactive',
			'Auto-created by migration 0043 to satisfy the new supplier_id NOT NULL constraint on ' ||
			'pre-existing expense rows that predate T-130. Not a real supplier.',
			r.created_by
		WHERE NOT EXISTS (
			SELECT 1 FROM suppliers WHERE org_id = r.org_id AND name = placeholder_name
		);
	END LOOP;

	FOR r IN
		SELECT id, org_id, store_id, business_date, total_amount, created_by
		FROM expenses WHERE supplier_id IS NULL
	LOOP
		SELECT id INTO sup_id FROM suppliers WHERE org_id = r.org_id AND name = placeholder_name;

		INSERT INTO supplier_invoices (
			org_id, store_id, supplier_id, invoice_date, total_amount, status,
			receipt_photo_url, verified_by, verified_at, notes, created_by
		) VALUES (
			r.org_id, r.store_id, sup_id, r.business_date, r.total_amount, 'verified',
			'https://example.invalid/backfill/migration-0043', r.created_by, now(),
			'Auto-created by migration 0043 for a pre-existing expense row that predates the ' ||
			'verified-invoice gate. Not a real invoice.',
			r.created_by
		)
		RETURNING id INTO inv_id;

		UPDATE expenses SET supplier_id = sup_id::text, supplier_invoice_id = inv_id WHERE id = r.id;
	END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE "expenses" ALTER COLUMN "supplier_id" TYPE uuid USING "supplier_id"::uuid;--> statement-breakpoint
ALTER TABLE "expenses" ALTER COLUMN "supplier_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ALTER COLUMN "supplier_invoice_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" DROP COLUMN "receipt_photo_url";--> statement-breakpoint
ALTER TABLE "expenses" DROP COLUMN "receipt_file_id";--> statement-breakpoint

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_suppliers_id_fk"
	FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_invoice_id_supplier_invoices_id_fk"
	FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict;--> statement-breakpoint

-- ===========================================================================================
-- loans: lenderId FK, promised by T-126 ("When it lands this gains an FK beside the name; the
-- party on the LINE does not change" — loans.ts's own comment). Nullable: not every lender is a
-- supplier-shaped counterparty. No backfill needed.
-- ===========================================================================================
ALTER TABLE "loans" ADD COLUMN "lender_id" uuid;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_lender_id_suppliers_id_fk"
	FOREIGN KEY ("lender_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict;--> statement-breakpoint

-- ===========================================================================================
-- ⭐ THE GATE, as a trigger — the backstop, regardless of code path (migration 0007's
-- journal_lines_check_party_requirement is the precedent for why this cannot be a plain CHECK:
-- it has to look at another table). BEFORE INSERT OR UPDATE on expenses:
--   - the named supplier_invoice must exist and be 'verified' — rejected by name and status
--     otherwise (a 'pending' or 'voided' invoice cannot back an expense);
--   - the invoice's remaining capacity (total_amount - SUM of its OTHER non-voided expenses)
--     must cover this expense's total_amount, within a half-centavo epsilon for decimal
--     rounding only — NOT v1's ₱1 RECEIPT_FULLY_RECORDED_TOLERANCE (recording.ts:13), which
--     answers a different question ("is what's LEFT small enough to call this fully recorded
--     and stop offering it", packages/db/src/repo/ap.ts's own FULLY_RECORDED_TOLERANCE) than
--     this one ("does THIS posting fit"). Conflating the two would let a single expense
--     overshoot the invoice total by up to a peso — caught by this task's own capacity test.
-- packages/db/src/repo/ap.ts's assertOpenForRecording mirrors this arithmetic exactly for a
-- clean, named error; this trigger is what makes it true no matter which code path writes the
-- row.
-- ===========================================================================================
CREATE FUNCTION "expenses_check_invoice_open_for_recording"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	inv_status text;
	inv_total numeric;
	recorded numeric;
BEGIN
	SELECT status, total_amount INTO inv_status, inv_total
	FROM supplier_invoices WHERE id = NEW.supplier_invoice_id;

	IF inv_status IS NULL THEN
		RAISE EXCEPTION 'supplier invoice % does not exist', NEW.supplier_invoice_id;
	END IF;

	IF inv_status <> 'verified' THEN
		RAISE EXCEPTION 'supplier invoice % is % — an expense cannot be recorded until it is verified', NEW.supplier_invoice_id, inv_status;
	END IF;

	SELECT coalesce(sum(total_amount), 0) INTO recorded
	FROM expenses
	WHERE supplier_invoice_id = NEW.supplier_invoice_id AND status <> 'voided' AND id <> NEW.id;

	IF recorded + NEW.total_amount > inv_total + 0.005 THEN
		RAISE EXCEPTION 'supplier invoice % has only % remaining (total %, already recorded %) — this expense (%) does not fit',
			NEW.supplier_invoice_id, (inv_total - recorded), inv_total, recorded, NEW.total_amount;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "expenses_require_verified_invoice"
	BEFORE INSERT OR UPDATE ON "expenses"
	FOR EACH ROW EXECUTE FUNCTION "expenses_check_invoice_open_for_recording"();
