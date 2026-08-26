-- 0020 — T-124 (docs/tasks/124-fixed-assets-and-depreciation.md §11, bible §13 row 140):
-- a useful life is a COUNT OF MONTHS, defaulting to 24, and an asset may depreciate
-- SEMI-ANNUALLY.
--
-- ⛔ 0019 is applied, so this is a NEW migration and not an edit to it (RULES.md rule 9).
-- Hand-written, no drizzle-kit snapshot — matching 0002/0004/0005's precedent, and for a
-- reason drizzle-kit could not have got right on its own: it sees a dropped `useful_life_years`
-- and an added `useful_life_months` as two unrelated operations, and would have generated
-- DROP + ADD. That silently discards every life already recorded. A RENAME plus an explicit
-- ×12 conversion keeps the meaning of existing rows, which is the whole point of the change.
--
-- ## Why months, and not "years, but you may use a decimal"
--
-- v1 already asks for months. `asset-editor.tsx` collects a month count and divides it by 12
-- before storing (`src/types/index.ts:2653-2699`, `usefulLifeYears: number`), so a 30-month
-- life has been round-tripping through 2.5 years — and any life that is not a whole number of
-- years has been carrying a rounding v1 never showed anyone. Storing the unit the user actually
-- types removes the conversion rather than making it more precise. This is bible §6's rule about
-- money applied to the other number depreciation is built on.
--
-- ## Semi-annual
--
-- `interval` carries no CHECK constraint in the database (0019 declares the enum in TypeScript
-- only), so adding a fourth value needs no DDL here — it is a schema/type change alone. This
-- comment exists so the next reader does not go looking for the constraint that "must" have
-- been widened, and conclude something was missed.

--> statement-breakpoint
ALTER TABLE "asset_category_lives" DROP CONSTRAINT "asset_category_lives_positive_check";--> statement-breakpoint
ALTER TABLE "asset_category_lives" RENAME COLUMN "useful_life_years" TO "useful_life_months";--> statement-breakpoint
UPDATE "asset_category_lives" SET "useful_life_months" = "useful_life_months" * 12;--> statement-breakpoint
ALTER TABLE "asset_category_lives" ALTER COLUMN "useful_life_months" SET DEFAULT 24;--> statement-breakpoint
ALTER TABLE "asset_category_lives" ADD CONSTRAINT "asset_category_lives_positive_check" CHECK ("asset_category_lives"."useful_life_months" > 0);--> statement-breakpoint

ALTER TABLE "fixed_assets" DROP CONSTRAINT "fixed_assets_useful_life_positive_check";--> statement-breakpoint
ALTER TABLE "fixed_assets" RENAME COLUMN "useful_life_years" TO "useful_life_months";--> statement-breakpoint
UPDATE "fixed_assets" SET "useful_life_months" = "useful_life_months" * 12;--> statement-breakpoint
ALTER TABLE "fixed_assets" ALTER COLUMN "useful_life_months" SET DEFAULT 24;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_useful_life_positive_check" CHECK ("fixed_assets"."useful_life_months" > 0);--> statement-breakpoint

-- `notes` — v1 carries one (`AssetPlain.notes`) and its editor exposes it. Restored here rather
-- than dropped: the reason an asset was given the life it was given is exactly the thing a
-- reviewer wants a year later, and §11.1 moved that judgement onto the person adding the asset.
ALTER TABLE "fixed_assets" ADD COLUMN "notes" text;
