-- 0201 - T-430: recurring templates remember the period they start from.
-- docs/tasks/430-recurring-catch-up.md D6; hand-authored per ADR-012 s5. Builds on 0200 (journal head).
--
-- WHY. A template said only "next due"; the starting period (row 327) was never stored, so nothing could say where
-- a template's history begins. starts_on is that fact. Existing rows are backfilled from their creation day (Manila).
-- The default (Manila today) keeps older raw INSERTs valid; the app always states starts_on. No table is added, so no classification / RLS registry change; no new index.
ALTER TABLE "recurring_expenses" ADD COLUMN "starts_on" date;
--> statement-breakpoint
UPDATE "recurring_expenses" SET "starts_on" = ("created_at" AT TIME ZONE 'Asia/Manila')::date;
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ALTER COLUMN "starts_on" SET DEFAULT ((now() AT TIME ZONE 'Asia/Manila')::date);
--> statement-breakpoint
ALTER TABLE "recurring_expenses" ALTER COLUMN "starts_on" SET NOT NULL;
