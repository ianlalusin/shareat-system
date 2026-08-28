-- 0046 — T-130 hardening: evidence is a FILE, verification is an ATTESTATION, and it takes two
-- people. Ian, 2026-08-28: "for receipt nothing would accept that x."
--
-- HAND-WRITTEN, like 0020-0045. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⛔ WHAT WAS WRONG. `verifyInvoice` validated `receipt_file_id` against `stored_files` (T-141's
-- real check: the row exists, in this org, for this store) but fell through to
-- `receipt_photo_url.trim()` when no file was named — and the AP form only ever offered the text
-- box. So in practice every invoice in v2 was verified on a typed string, and typing `x` was
-- enough. That is the pre-T-141 hole, reopened by a fallback.
--
-- The column is DROPPED rather than left unused. A nullable text column that once meant
-- "evidence" is an invitation to accept it again, and v2 starts from a zero opening balance
-- (bible §1.4) so there is no history in it worth keeping.
--
-- ⭐ WHAT "VERIFIED" MEANS, per Ian, 2026-08-28: right supplier · right invoice data · right
-- items · right price · plus an uploaded photo. Four separate confirmations, so four columns
-- rather than one boolean — a single "verified: yes" cannot say WHICH of the four a person
-- actually looked at, and the whole point of an attestation is that it is specific.
-- ⚠️ `attested_items` and `attested_price` are a HUMAN's confirmation against the photo today,
-- because there are no invoice lines yet to check against. When the item master lands they
-- become machine-checkable as well; the columns do not change, the evidence behind them gets
-- stronger.
--
-- ⭐ TWO PEOPLE. `verified_by <> created_by` is the standard AP segregation of duties, and it is
-- not theoretical here: in v1's live data **577 of 1,324 verified receipts (44%) were verified by
-- the same person who submitted them.** v1's policy allows it (`policy.ts` checks role, never
-- identity), so this is a v2 correction, not a port.
-- ⚠️ Operational cost, stated because it is felt daily: a store whose only manager logged the
-- receipt cannot verify it themselves — an admin must. That is the control working, not a bug.
--
-- ⚠️ BOTH NEW CHECKS ARE `NOT VALID`, deliberately. `NOT VALID` still enforces on every INSERT
-- and UPDATE from now on; it only skips the scan of rows that already exist. This dev database
-- holds two smoketest invoices that are self-verified and carry no file, so they violate both
-- rules — and they genuinely ARE non-compliant. Grandfathering them with invented attestations
-- would be worse than leaving them visibly wrong: `supplier_invoices` is classified `purge` at
-- cutover, so they disappear rather than needing repair. A later `VALIDATE CONSTRAINT` will flag
-- them until then, which is the correct answer.

-- The evidence is a brokered file row, and nothing else.
ALTER TABLE "supplier_invoices" DROP COLUMN "receipt_photo_url";--> statement-breakpoint

-- ⚠️ There was no FK on this column before: it was a bare uuid, so a hand-typed value was
-- structurally acceptable and only the service layer stood between it and a "verified" invoice.
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_receipt_file_id_stored_files_id_fk"
	FOREIGN KEY ("receipt_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "supplier_invoices" ADD COLUMN "attested_supplier" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "attested_invoice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "attested_items" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "attested_price" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Verified means all four were confirmed. Not "someone clicked verify".
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_attested_when_verified_check"
	CHECK (
		"status" <> 'verified'
		or ("attested_supplier" and "attested_invoice" and "attested_items" and "attested_price")
	) NOT VALID;--> statement-breakpoint

-- Segregation of duties: the person who logged it cannot be the person who approved it.
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_two_person_verification_check"
	CHECK ("verified_by" is null or "verified_by" <> "created_by") NOT VALID;--> statement-breakpoint

-- The evidence is looked up by file when reading an invoice, and swept for orphans by T-141.
CREATE INDEX "supplier_invoices_receipt_file_idx" ON "supplier_invoices" USING btree ("receipt_file_id");
