-- T-188 — supplier master data.
-- docs/tasks/188-supplier-master-data.md
--
-- Every column here was measured against the LIVE v1 data before being added (129 supplier
-- documents, 7 stores, read-only probe). The fields deliberately NOT ported are recorded in the
-- task doc with their fill rates: paymentOptions (1.6%, and both rows say "Cash"), contactNo2
-- (1.6%), logoPath (4.7%), lastCreditDueDays (3.1%, set to null by its only writer).
--
-- ⛔ Do not "complete" the port. The omissions are decisions, not oversights.
--
-- Hand-written, per DEF-073. Never edited after apply.

ALTER TABLE "suppliers" ADD COLUMN "email" text;
ALTER TABLE "suppliers" ADD COLUMN "representative_name" text;

-- v1's `vatRegistrationNo`. Renamed: in the Philippines this IS the TIN, and `vat_registration_no`
-- beside the existing `vat_status` reads like a second status field.
ALTER TABLE "suppliers" ADD COLUMN "tin" text;

-- A LABEL, not a rule. 96% filled in v1 and it drives nothing there; nothing may branch on it here
-- either until somebody decides what it means (the natural use is the BIR withholding split).
ALTER TABLE "suppliers" ADD COLUMN "classification" text;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_classification_check"
  CHECK ("classification" is null OR "classification" in ('corporate', 'individual', 'other'));

-- The one ported field that actually does work: it DEFAULTS the document type on an invoice.
-- NOT NULL DEFAULT true matches v1, whose editor falls back to `?? true` in three places.
ALTER TABLE "suppliers" ADD COLUMN "issues_official_receipt" boolean DEFAULT true NOT NULL;

-- Three COLUMNS, not a child table: 5 of 129 suppliers have bank details and every one has
-- exactly ONE account. `bank_name` is free text so an e-wallet fits without a second concept.
ALTER TABLE "suppliers" ADD COLUMN "bank_name" text;
ALTER TABLE "suppliers" ADD COLUMN "bank_account_name" text;
ALTER TABLE "suppliers" ADD COLUMN "bank_account_number" text;

-- What THIS document was. Copied from the supplier's habit at creation, owned by the invoice
-- thereafter — changing a supplier today must never rewrite what last month's receipt was.
ALTER TABLE "supplier_invoices" ADD COLUMN "is_official_receipt" boolean DEFAULT true NOT NULL;
