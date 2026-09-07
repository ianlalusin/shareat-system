-- T-229 slice 2 — expense categories: create, rename, retire.
-- docs/tasks/229-reference-data-administration.md. Closes **DEF-205**.
--
-- ⚠️ Hand-written from `schema/expenses.ts`, per DEF-073 / DEF-121 — `drizzle-kit generate`'s
-- snapshot chain has been dead since 0019 and would propose re-creating months of live schema.
-- Same convention as 0131, 0132 and 0133, which say so in their own headers.
--
-- ⛔ ORDER MATTERS IN THIS FILE. The `sub_category` drop is LAST, and the four SQL readers of that
-- column are fixed in the same commit, because three of them are raw `sql` template strings that
-- TypeScript cannot see (see section 4).

-- ---------------------------------------------------------------------------------------------
-- 1. Uniqueness on NORMALISED identity — bible §4.4 rule 3, DEF-205.
--
-- The shipped index is `(org_id, category)`: case- and whitespace-SENSITIVE, so `Rent` and `rent `
-- both insert. Harmless for as long as the seed was the only writer this table had ever had — and
-- live from the moment THIS migration's create path ships, which is why the index lands here and
-- not in a later one. Bible §4.4's own words: "A manual add that collides with a seeded row is
-- rejected BY THE DATABASE, with an error naming the existing row."
--
-- ⚠️ Drizzle's builder cannot express an expression index, so `schema/expenses.ts` now carries a
-- NOTE comment where its `uniqueIndex(...)` line used to be — exactly as `positions`
-- (`employment.ts:126-134`) and `sales_channels` (0133) already document. Restoring that line
-- would let a future `db:generate` "fix" the drift by dropping this index and recreating the
-- broken one (DEF-073's shape).
--
-- ⛔ **`group` is NOT part of the key, and that is deliberate.** Bible §4.4 rule 3's illustrative
-- example includes it, but the shipped index never did: `leg-mapping.ts`'s crosswalk keys are
-- already globally unique with no OPEX/COGS name collision, and `expenses.category_id` resolves
-- routing by id. Adding `group` now would ALLOW "Rent" in OPEX and "rent" in COGS — two rows one
-- keystroke apart, which is the exact duplicate this index exists to refuse.
DROP INDEX "expense_categories_org_id_category_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_org_id_category_unique"
	ON "expense_categories" ("org_id", lower(trim("category")));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Bible §4.4 rule 2 — seeded rows may be DEACTIVATED, never deleted, and their identity is
--    stable forever. `is_active` is what makes "retire" possible at all; `is_system` is what stops
--    a user row and a seeded row being confused for one another (rule 5: one writer per row class
--    — the seed owns system rows, the screen owns user rows, neither writes the other's).
ALTER TABLE "expense_categories"
	ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_categories"
	ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- Everything that exists at this moment came from the seed — it was the only writer the table has
-- ever had (DEF-193). ⚠️ `seedExpenseCategories` is updated in the same commit to set the flag on
-- rows it inserts from here on, or the next org bootstrapped by T-228 would get unprotected rows
-- and the flag would mean nothing.
UPDATE "expense_categories" SET "is_system" = true;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Discovery §1.6's verdict — `sub_category` is NULL on all 38 seeded rows and v1's second
--    free-text level is what produced its 8 catch-alls. Ian's Q2, taken 2026-09-07.
--
-- ⛔ **"Read by nothing" was WRONG, and the correction is why this is the last statement.** The
-- column had no DATA but four live SQL READERS: `budgets.listForStorePeriod` and
-- `budgets.categoriesWithoutBudget` (select, ORDER BY and a "Category — Sub" label),
-- `commissary.ts`'s `expenseCategoryLabel` CASE, and `commissary-catalogue.ts`'s
-- `expenseSubCategory` — which `apps/erp/src/app/commissary/catalogue/page.tsx:300` renders.
--
-- ⚠️ **Only `repo/expenses.ts` used the typed Drizzle builder.** The other four are raw `sql`
-- template strings, invisible to TypeScript: dropping this column with them in place gives a GREEN
-- typecheck, a GREEN unit suite and a GREEN build, then `column c.sub_category does not exist` at
-- runtime on the budgets screen and the commissary catalogue. All four are fixed in this commit,
-- BEFORE this statement, and each is now executed against real Postgres by an integration test —
-- a green typecheck is not evidence for a raw string.
ALTER TABLE "expense_categories" DROP COLUMN "sub_category";
