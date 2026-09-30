-- 0172 — T-366 S2 / DEF-386 (+DEF-105), docs/tasks/366-remittance-floats.md §S2 and Amendment A1.
--
-- Charging a remittance shortage to a person used to post NOTHING: `resolveRemittanceVariance`
-- wrote a status and a person and returned, so the person's receivable (1230) never existed and
-- the cashier account still showed money that was not in the drawer. S2 posts the charge as a
-- SECOND journal entry beside the transfer (Dr 1230 employee / Cr the cashier account) and
-- completes the day it was charged against. This migration is the schema half of that:
--
-- 1. `remittance_allocations.source` ('cash' | 'charge'). A charge writes settlement rows so the
--    day reads remitted; they sit beside the cash rows of the SAME remittance and date, so the
--    unique index widens from (remittance_id, business_date) to include source.
-- 2. `remittance_variances.journal_entry_id` — the link from a resolved variance to the entry it
--    posted (bible §16.1 inv. 4), so reversing the remittance can reverse that entry too.
-- 3. The status set gains 'income' (S3's overage recognition, Dr cashier / Cr 7350), with its
--    resolution-shape arm; `written_off` stays in the CHECKs so existing rows survive, but the
--    domain now refuses it permanently (Amendment A1: no write-off, Ian 2026-09-30).
-- 4. Two NOT VALID guards — the sign of the amount per status, and status vs journal_entry_id.
--    (`charged` and `income` both require the entry; `written_off` rows are legacy and exempt.)
--    NOT VALID because a legacy database may hold `charged` rows that predate this migration and
--    have no entry; they are left untouched, every NEW or UPDATED row is checked.
--
-- No new table, so the classification and RLS registries are unchanged. `remittance_variances`
-- and `remittance_allocations` keep the table-level grants they already have (the app UPDATEs the
-- former); a new column is covered by them.
--
-- HAND-WRITTEN, per ADR-012 §5 — `drizzle-kit generate` is retired. Every statement below is its
-- own breakpoint, except the last, which is the last statement in the file.

ALTER TABLE "remittance_allocations" ADD COLUMN "source" text DEFAULT 'cash' NOT NULL;
--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_source_check" CHECK ("remittance_allocations"."source" in ('cash', 'charge'));
--> statement-breakpoint
DROP INDEX "remittance_allocations_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "remittance_allocations_unique" ON "remittance_allocations" USING btree ("remittance_id","business_date","source");
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD COLUMN "journal_entry_id" uuid;
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "remittance_variances_journal_entry_idx" ON "remittance_variances" USING btree ("journal_entry_id");
--> statement-breakpoint
ALTER TABLE "remittance_variances" DROP CONSTRAINT "remittance_variances_status_check";
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_status_check" CHECK ("remittance_variances"."status" in ('open', 'charged', 'written_off', 'income'));
--> statement-breakpoint
ALTER TABLE "remittance_variances" DROP CONSTRAINT "remittance_variances_resolution_shape_check";
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_resolution_shape_check" CHECK (("remittance_variances"."status" = 'open' and "remittance_variances"."charged_to_person_id" is null and "remittance_variances"."resolved_by" is null)
          or ("remittance_variances"."status" = 'charged' and "remittance_variances"."charged_to_person_id" is not null and "remittance_variances"."resolved_by" is not null)
          or ("remittance_variances"."status" = 'written_off' and "remittance_variances"."reason" is not null and "remittance_variances"."resolved_by" is not null)
          or ("remittance_variances"."status" = 'income' and "remittance_variances"."charged_to_person_id" is null and "remittance_variances"."resolved_by" is not null));
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_sign_check" CHECK (("remittance_variances"."status" <> 'income' or "remittance_variances"."amount" > 0) and ("remittance_variances"."status" <> 'charged' or "remittance_variances"."amount" < 0)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_posting_check" CHECK (("remittance_variances"."status" = 'open' and "remittance_variances"."journal_entry_id" is null) or ("remittance_variances"."status" in ('charged', 'income') and "remittance_variances"."journal_entry_id" is not null) or "remittance_variances"."status" = 'written_off') NOT VALID;
