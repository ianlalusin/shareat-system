-- 0051 — T-149: what an item may be bought and sold as.
-- docs/tasks/149-item-sellability.md.
--
-- HAND-WRITTEN, like 0020-0050. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ THREE INDEPENDENT BOOLEANS, not an enum, and Ian's own examples are why:
--
--   Samgyup bento box      retail ✅   wholesale ⛔   purchasable ⛔  (we MAKE it)
--   Beef Premium 5kg pack  retail ⛔   wholesale ✅   purchasable ✅
--   Milkis                 retail ✅   wholesale ✅   purchasable ✅
--   Charcoal, gloves       retail ⛔   wholesale ⛔   purchasable ✅
--
-- That last row is the argument. MOST of the 385 imported names are sold to nobody — they are
-- consumed. `retail | wholesale | both` has nowhere to put them; independent booleans do, and
-- false/false is the ordinary case rather than an awkward extra enum member.
--
-- ⭐ `is_purchasable` exists because of the bento box. A thing we make is not a thing a supplier
-- bills us for, and that difference is what will later let its cost be computed from its
-- ingredients rather than read off an invoice. (Recipes are explicitly future work — Ian: "later
-- we can add the ingredient costing... but for future build, for now the basic first.")
--
-- ⭐ Same shape as Odoo's product master ("Can be Sold" / "Can be Purchased"), which keeps ONE
-- product list shared across channels rather than a product per channel — T-145's design already.

ALTER TABLE "items" ADD COLUMN "is_purchasable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "sellable_retail" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "sellable_wholesale" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- ===========================================================================================
-- BACKFILL — from evidence, never from parsing names.
--
-- ⚠️ Inventing a sellability for 385 items by reading their names is exactly the confident guess
-- this project keeps finding in v1 and refusing to repeat. Only two things here are actually
-- known, so only two things are set.
-- ===========================================================================================

-- `retail` is v1's own word for a thing it resells, carried through the import.
UPDATE "items" SET "sellable_retail" = true WHERE "kind" = 'retail';--> statement-breakpoint

-- ⭐ Somebody already quoted these to a customer on a price list. That is not an inference about
-- what the item is — it is a record of it having been sold wholesale.
UPDATE "items" SET "sellable_wholesale" = true
WHERE "id" IN (SELECT DISTINCT "item_id" FROM "price_list_items");--> statement-breakpoint

-- ⚠️ Everything else stays false and a super-admin turns it on. A flag nobody set is a flag
-- nobody is relying on; a flag guessed wrong is one somebody trusts.

-- The item register filters on these, and the picker will too.
CREATE INDEX "items_org_sellable_idx" ON "items" USING btree ("org_id","sellable_wholesale","sellable_retail");
