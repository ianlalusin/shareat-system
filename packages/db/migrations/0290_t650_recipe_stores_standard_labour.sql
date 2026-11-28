-- 0290 - T-650 S2: a product recipe is made only at the stores it is listed for, and may carry a standard labour cost per batch. Spec: T-650 S2 (C:\shareat\specs\650-made-here-cost-and-recipe-split.md); hand-authored per ADR-012 s5.
-- Journal idx 290, `when` = 0289's (T-649, 1811043107084) + 86400000 = 1811129507084.
--
-- WHY. Ian, 28 Nov 2026: a recipe for a thing we sell (the home-made sauce) "must only be available to shareat lipa"; the product is then delivered to other stores as an item.
-- And the labour for one batch of a recipe is a known figure, so a cook with the labour box left blank should take it instead of booking nothing.
--
-- WHAT IT ADDS.
--   production_recipe_stores (org_id, recipe_id, store_id)  PK (recipe_id, store_id). A recipe with NO rows may be made at every store (nothing changes on deploy);
--       a recipe WITH rows may be posted only at those stores (the domain refuses elsewhere). KEEP (master data, as production_recipes).
--       Same-org twins: (org_id, recipe_id) -> production_recipes(org_id, id) ON DELETE CASCADE, (org_id, store_id) -> stores(org_id, id) ON DELETE RESTRICT, so a
--       store of another organisation is refused by the database, not only by the screen.
--   production_recipes.standard_labour_cost numeric(14,2) NULL  the labour for ONE batch of output_quantity; NULL = none; >= 0 and finite.
-- GRANTS (ADR-012 s5 4a). shareat_app: SELECT, INSERT, DELETE on production_recipe_stores (a recipe edit replaces its list); no UPDATE (a row is a pair). production_recipes
-- keeps its table-level UPDATE (0011 default privileges predate 0169), so the new column needs no grant. RLS ENABLE + FORCE, one org_isolation policy via app_current_org().
-- The finite CHECK has the one house shape (t327 pins it by value); a NULL passes it (NULL > x is unknown), so the column stays optional.
-- LOCK BUDGET. lock_timeout 5s first; one new empty table, one nullable ADD COLUMN (metadata only), two CHECKs on production_recipes (a small table).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "production_recipes" ADD COLUMN "standard_labour_cost" numeric(14, 2);
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_standard_labour_cost_check" CHECK ("standard_labour_cost" IS NULL OR "standard_labour_cost" >= 0);
--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_standard_labour_cost_finite_check" CHECK ("standard_labour_cost" > '-Infinity'::numeric AND "standard_labour_cost" < 'Infinity'::numeric);
--> statement-breakpoint

CREATE TABLE "production_recipe_stores" (
	"org_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_recipe_stores_pkey" PRIMARY KEY ("recipe_id", "store_id")
);
--> statement-breakpoint
ALTER TABLE "production_recipe_stores" ADD CONSTRAINT "production_recipe_stores_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "production_recipe_stores" ADD CONSTRAINT "production_recipe_stores_recipe_same_org_fk"
	FOREIGN KEY ("org_id", "recipe_id") REFERENCES "production_recipes"("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "production_recipe_stores" ADD CONSTRAINT "production_recipe_stores_store_same_org_fk"
	FOREIGN KEY ("org_id", "store_id") REFERENCES "stores"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "production_recipe_stores_store_idx" ON "production_recipe_stores" ("store_id");
--> statement-breakpoint
CREATE INDEX "production_recipe_stores_org_idx" ON "production_recipe_stores" ("org_id");
--> statement-breakpoint
ALTER TABLE "production_recipe_stores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "production_recipe_stores" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "production_recipe_stores_org_isolation" ON "production_recipe_stores" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "production_recipe_stores" TO "shareat_app";
