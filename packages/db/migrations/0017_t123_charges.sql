-- T-123 charges (bible row 134). Two kinds, OPPOSITE in the books.
--
--   service_charge -> 2160, a LIABILITY. RA 11360 sends 100% of it to rank-and-file employees
--     at least twice a month, so the business collects as an agent and keeps none of it.
--   other_charges  -> 4500, INCOME. Leftover, packaging and similar: the business keeps these.
--
-- Ian: "we charge leftover charge, packaging charge and other charges — I want them all in ONE
-- account, separated from service charge." Both accounts are added by the chart seed, which is
-- KEEP-class configuration and re-seeds idempotently.
--
-- Both columns default to 0 and are NOT NULL, so existing rows are unaffected and the widened
-- non-negative CHECK holds for them without a backfill.

ALTER TABLE "sales_days" DROP CONSTRAINT "sales_days_non_negative_check";--> statement-breakpoint
ALTER TABLE "sales_days" ADD COLUMN "service_charge" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_days" ADD COLUMN "other_charges" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_non_negative_check" CHECK (
      "sales_days"."total_sales" >= 0 and "sales_days"."unli_sales" >= 0 and "sales_days"."ala_carte_sales" >= 0
      and "sales_days"."senior_discount" >= 0 and "sales_days"."pwd_discount" >= 0 and "sales_days"."other_discount" >= 0
      and "sales_days"."comps" >= 0 and "sales_days"."service_charge" >= 0 and "sales_days"."other_charges" >= 0
      and "sales_days"."cash_collected" >= 0 and "sales_days"."online_collected" >= 0 and "sales_days"."credit_sales" >= 0
    );