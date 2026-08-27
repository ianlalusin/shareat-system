-- 0031 — T-143 correction: a remittance settles END-DAY REPORTS, keyed by date. Bible row 157.
--
-- Ian, 2026-08-27: "remittance is derived from sales report — they are one, actually. It must be
-- END DAY REPORT, not sales report… the composition of all money movement of the day across
-- transactions."
--
-- ## ⭐ What changed, and why it is a correction rather than a feature
--
-- 0030 modelled an allocation against a SALES DAY, on the assumption that a day is owed its
-- remittable sales. It is not: a day is owed everything the cashier touched — sales, collections,
-- returns, less expenses paid from the till, cash requests released, advances. That is row 145's
-- figure, per date.
--
-- ⚠️ So the allocation key is (store, business_date), NOT a sales-day id. A collection banked on a
-- day the store did not trade is still money the cashier holds, and it must be remittable even
-- though no sales day exists for it. The sales day remains the LOCK (a date is remittable once its
-- day is verified) and is kept as a nullable link, not as the identity.
--
-- 0030 was applied and pushed, so it is not edited (bible §2 rule 8) — this corrects forward.

--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "remittance_allocations" ALTER COLUMN "sales_day_id" DROP NOT NULL;--> statement-breakpoint
-- Nothing has been written yet, so there is nothing to backfill; the NOT NULL can go on directly.
ALTER TABLE "remittance_allocations" ALTER COLUMN "business_date" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "remittance_allocations_unique";--> statement-breakpoint
-- ⚠️ One batch settles a given DATE once.
CREATE UNIQUE INDEX "remittance_allocations_unique"
	ON "remittance_allocations" ("remittance_id","business_date");--> statement-breakpoint
CREATE INDEX "remittance_allocations_date_idx" ON "remittance_allocations" ("business_date");--> statement-breakpoint

ALTER TABLE "remittance_variances" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "remittance_variances" ALTER COLUMN "sales_day_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "remittance_variances" ALTER COLUMN "business_date" SET NOT NULL;
