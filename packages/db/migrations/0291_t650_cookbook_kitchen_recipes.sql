-- 0291 - T-650 S3: the Cookbook. A recipe is either a PRODUCT recipe (it makes a stock item: today's recipes) or a KITCHEN recipe (how to cook a dish we do not stock:
-- ingredients, method, makes N portions). Spec: T-650 S3 (C:\shareat\specs\650-made-here-cost-and-recipe-split.md); hand-authored per ADR-012 s5.
-- Journal idx 291, `when` = 0290's (T-650 S2, 1811129507084) + 86400000 = 1811215907084.
--
-- WHY. Ian, 28 Nov 2026: "recipe for sides we dont sell like a cookbook only how to cook fishcake", and "recipe for things we sell must only be available to shareat lipa".
-- Two different things lived in one table, and a kitchen recipe could not be saved at all because every recipe had to name an item it makes.
--
-- WHAT IT CHANGES (production_recipes only; no new table, so no classification or RLS entry changes).
--   purpose text NOT NULL DEFAULT 'product'  CHECK in ('product','kitchen'). Every existing row is a product recipe, so nothing changes on deploy.
--   output_item_id becomes NULLABLE, with production_recipes_output_by_purpose_check: purpose = 'kitchen' OR output_item_id IS NOT NULL. The two output-item foreign keys
--       (single column, and the same-org composite of 0213) are NULL-safe (MATCH SIMPLE): a kitchen recipe has no output item and no output stock.
--   method text NULL  the steps, plain text, at most 4000 characters (production_recipes_method_length_check). output_quantity is kept: for a kitchen recipe it is
--       "makes N portions / servings".
-- The service-item output trigger (0224) reads NEW.output_item_id and treats NULL as "not a service item": no change needed.
-- DOMAIN (not in SQL): a kitchen recipe can never be posted as a production; it can be the target of a menu depletion rule, which scales its ingredients per serving.
-- GRANTS. production_recipes keeps its table-level UPDATE (0011 default privileges predate 0169), so the new columns need no grant. RLS unchanged.
-- LOCK BUDGET. lock_timeout 5s first; two ADD COLUMNs (a constant default and a nullable one: metadata only), one DROP NOT NULL, three CHECKs on a small table.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD COLUMN "purpose" text DEFAULT 'product' NOT NULL;
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD COLUMN "method" text;
--> statement-breakpoint
ALTER TABLE "production_recipes" ALTER COLUMN "output_item_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_purpose_check" CHECK ("purpose" IN ('product', 'kitchen'));
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_output_by_purpose_check" CHECK ("purpose" = 'kitchen' OR "output_item_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_method_length_check" CHECK ("method" IS NULL OR char_length("method") <= 4000);
