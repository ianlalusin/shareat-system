-- 0198 - T-401 S6: the usage tolerance band and the usage auto-post flag. docs/tasks/401-erp-menu-catalog-master.md "S5 rulings" point 7 (I28) and
-- Ian's ruling of 2026-10-14 (bible row 335).
--
-- WHAT. Three columns, no new table:
--   organizations.usage_tolerance  numeric(5,4) NOT NULL DEFAULT 0.1000  - the org-wide band, a fraction (0.10 = 10%).
--   items.usage_tolerance          numeric(5,4) NULL                      - a per-item override; NULL means "use the org setting".
--   stock_usage_records.auto_posted boolean NOT NULL DEFAULT false      - true when the system (not a manager) posted the record
--                                                                         at 14:00 Manila the day after its business date (Ian, 15 Oct).
-- Both tolerances are checked to lie in [0, 1], and carry the repo-wide `*_finite_check` of the real form (T-371 G4).
--
-- WHY. A manager-posted staff usage draft is the actual usage that moves stock; the POS pull finalizes into a usage DRAFT at expected (no stock moves) and is the expectation the drafts are checked against. The check is
-- "actual within tolerance x expected" per (store, day, item), and the tolerance is the item's own override, else the org's.
-- No backfill: every existing org reads the default 10%, no item has an override.
--
-- GRANTS / RLS. No new table, so no policy or grant change: `organizations` and `items` keep the policies and the UPDATE grant
-- the app already uses (setIdentity, setItemPurchaseUnit). The setters are admin-only (`set_menu_depletion`) in the domain.
ALTER TABLE "organizations" ADD COLUMN "usage_tolerance" numeric(5,4) DEFAULT 0.1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_usage_tolerance_check" CHECK ("usage_tolerance" >= 0 AND "usage_tolerance" <= 1);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_usage_tolerance_finite_check" CHECK ("usage_tolerance" > '-Infinity'::numeric AND "usage_tolerance" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "usage_tolerance" numeric(5,4);--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_usage_tolerance_check" CHECK ("usage_tolerance" IS NULL OR ("usage_tolerance" >= 0 AND "usage_tolerance" <= 1));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_usage_tolerance_finite_check" CHECK ("usage_tolerance" > '-Infinity'::numeric AND "usage_tolerance" < 'Infinity'::numeric);
ALTER TABLE "stock_usage_records" ADD COLUMN "auto_posted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_auto_posted_shape_check" CHECK ("auto_posted" = false OR "posted_at" IS NOT NULL);
