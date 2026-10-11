-- 0192 - T-386 S6 (R12), docs/tasks/386-item-code-auto-suggest.md: every item code has the shape CHWN-001.
--
-- WHAT IT DOES:
--   Adds items_code_shape_check: code ~ '^[A-Z0-9]{4}-[0-9]{3}$' AND right(code, 3) <> '000'  (4 letters or digits, a dash,
--   3 digits, number never 000). Added NOT VALID, then VALIDATE CONSTRAINT.
--
-- WHY NOT VALID THEN VALIDATE: no lock benefit here. drizzle runs pending migrations in ONE transaction, so the ACCESS EXCLUSIVE
--   lock taken by ADD CONSTRAINT is held through VALIDATE. Acceptable: production items is tiny (~1 row). The split still means a
--   failing row raises at VALIDATE and the whole migration rolls back.
--
-- PRODUCTION PRECHECK (READ ONLY, run as doadmin before apply; gate passed 2026-10-10 after the recode):
--   P0192a  SELECT count(*) FROM items WHERE NOT (code ~ '^[A-Z0-9]{4}-[0-9]{3}$' AND right(code,3) <> '000');   -- EXPECTED 0
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "items" ADD CONSTRAINT "items_code_shape_check"
	CHECK ("code" ~ '^[A-Z0-9]{4}-[0-9]{3}$' AND right("code", 3) <> '000') NOT VALID;--> statement-breakpoint
ALTER TABLE "items" VALIDATE CONSTRAINT "items_code_shape_check";
