-- 0044 — DEF-077: six org-isolation policies read the org through a raw
-- `current_setting('app.org_id', true)::uuid` instead of `app_current_org()`. This replaces all
-- six. docs/DEFECTS-REGISTER.md DEF-077.
--
-- HAND-WRITTEN, like 0020-0043. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ THE MECHANISM, because it is genuinely not obvious and a first pass on this defect called it
-- unreachable:
--   `set_config('app.org_id', $1, true)` is SET LOCAL on a CUSTOM GUC. When that transaction
--   ends, PostgreSQL resets such a GUC to the EMPTY STRING — not to unset/NULL. So on a POOLED
--   connection that has already served one org-scoped request, the next request that sets no org
--   of its own reads `app.org_id` back as `''`, and `''::uuid` raises 22P02.
--   `app_current_org()` (migration 0011) is `NULLIF(current_setting('app.org_id', true), '')::uuid`
--   — the NULLIF is the entire point of the function, and these six policies bypassed it.
--
-- ⚠️ NOT a data leak, and worth stating precisely so severity is not overstated later: a policy
-- that raises still returns no rows. What it does instead is turn a quiet denial into a 500, on
-- the exact code path `packages/db/src/rls/principal.ts` documents as *"NO org is set, so every
-- org-scoped policy evaluates against NULL and matches nothing"* — its customer branch, which
-- deliberately sets no org.
--
-- ⛔ WHY A NEW MIGRATION AND NOT AN EDIT of 0036/0038/0040/0042: those are applied. An applied
-- migration is never edited (bible §2 rule 9) — and editing one would not re-run it anyway, so
-- the live policies would stay broken while the source looked fixed. That exact trap is recorded
-- in DEF-077's own disposition.
--
-- ⭐ CREATE POLICY takes an ACCESS EXCLUSIVE lock on its table for the instant it runs, and these
-- six tables are small. DROP-then-CREATE inside this transaction means there is no window where
-- the table sits unprotected: the whole migration is one transaction, so either both statements
-- land or neither does.

-- customers (0042, T-129)
DROP POLICY "customers_org_isolation" ON "customers";--> statement-breakpoint
CREATE POLICY "customers_org_isolation" ON "customers"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- price_lists (0042, T-129)
DROP POLICY "price_lists_org_isolation" ON "price_lists";--> statement-breakpoint
CREATE POLICY "price_lists_org_isolation" ON "price_lists"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- price_list_items (0042, T-129)
DROP POLICY "price_list_items_org_isolation" ON "price_list_items";--> statement-breakpoint
CREATE POLICY "price_list_items_org_isolation" ON "price_list_items"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- liabilities (0040, T-128)
DROP POLICY "liabilities_org_isolation" ON "liabilities";--> statement-breakpoint
CREATE POLICY "liabilities_org_isolation" ON "liabilities"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- owners (0036, T-127)
DROP POLICY "owners_org_isolation" ON "owners";--> statement-breakpoint
CREATE POLICY "owners_org_isolation" ON "owners"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- owner_drawing_closes (0038, T-127)
DROP POLICY "owner_drawing_closes_org_isolation" ON "owner_drawing_closes";--> statement-breakpoint
CREATE POLICY "owner_drawing_closes_org_isolation" ON "owner_drawing_closes"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
