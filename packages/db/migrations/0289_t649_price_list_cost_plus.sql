-- 0289 - T-649: a price-list rate can follow the delivery cost (fixed / cost + peso / cost + %), and one list can be the default. docs/tasks/649-price-list-cost-plus.md; hand-authored per ADR-012 s5.
-- Journal idx 289, `when` = 0288's (T-636, 1810956707084) + 86400000 = 1811043107084.
--
-- WHY. Ian, 28 Nov 2026: one wholesale list holds "item a fixed 100, item b cost + 7%, item c cost + P50"; a second list (retail) prices the same items differently;
-- the app finds the customer's list, or the default list when the customer has none, and uses that item's rule.
--
-- WHAT IT ADDS.
--   price_list_items.pricing_mode text NOT NULL DEFAULT 'fixed' (fixed | fixed_markup | percent_markup: the same three words as item_pricing, 0056),
--   price_list_items.markup_amount numeric(14,2), price_list_items.markup_percent numeric(8,4), and rate becomes NULLABLE (a markup row has no fixed rate).
--   price_list_items_mode_shape_check: exactly the figure its mode uses, the other two NULL, markups >= 0. Every existing row is a fixed row with a rate, so it passes.
--   price_lists.is_default boolean NOT NULL DEFAULT false + a partial unique index: at most one default per organisation among lists that are not retired.
--   price_lists_default_not_retired_check: a retired list can never hold the default flag.
-- GRANTS. price_list_items and price_lists were created before 0169; their table-level UPDATE comes from 0011's default privileges, so nothing is added. RLS unchanged (existing policies cover every column).
-- LOCK BUDGET. lock_timeout 5s first; three ADD COLUMNs with constant defaults (metadata only), then CHECKs that scan price_list_items / price_lists once.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- PRE-CHECK. The new shape CHECK needs every existing row to be a fixed row with a rate. Refuse (naming them) rather than let ADD CONSTRAINT fail on an unnamed row.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(id::text, ', ') INTO bad FROM (SELECT id FROM "price_list_items" WHERE "rate" IS NULL LIMIT 20) v;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0289: price_list_items rows without a rate (would break the shape CHECK): %', bad;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "price_list_items" ALTER COLUMN "rate" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD COLUMN "pricing_mode" text DEFAULT 'fixed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD COLUMN "markup_amount" numeric(14, 2);
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD COLUMN "markup_percent" numeric(8, 4);
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_pricing_mode_check" CHECK ("pricing_mode" IN ('fixed', 'fixed_markup', 'percent_markup'));
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_markup_amount_finite_check" CHECK ("markup_amount" > '-Infinity'::numeric AND "markup_amount" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_markup_percent_finite_check" CHECK ("markup_percent" > '-Infinity'::numeric AND "markup_percent" < 'Infinity'::numeric);
--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_mode_shape_check" CHECK (
  ("pricing_mode" = 'fixed' AND "rate" IS NOT NULL AND "markup_amount" IS NULL AND "markup_percent" IS NULL)
  OR ("pricing_mode" = 'fixed_markup' AND "markup_amount" IS NOT NULL AND "markup_amount" >= 0 AND "rate" IS NULL AND "markup_percent" IS NULL)
  OR ("pricing_mode" = 'percent_markup' AND "markup_percent" IS NOT NULL AND "markup_percent" >= 0 AND "rate" IS NULL AND "markup_amount" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_default_not_retired_check" CHECK (NOT "is_default" OR "retired_at" IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_one_default_per_org_key" ON "price_lists" ("org_id") WHERE "is_default" AND "retired_at" IS NULL;
