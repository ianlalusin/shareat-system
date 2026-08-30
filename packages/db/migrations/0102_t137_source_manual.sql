-- 0066 — T-137: `source` value 'transcribed' becomes 'manual'.
--
-- HAND-WRITTEN, like 0020-0065. See DEF-073 for why `db:generate` cannot be used here, and
-- DEF-069 for the `meta/_journal.json` `when` arithmetic.
--
-- ⭐ WHY, and it is not cosmetic. 'transcribed' asserts that a SOURCE DOCUMENT was copied. Ian
-- confirmed 2026-08-29 that no paper SC/PWD logbook is kept anywhere (bible row 164) — the
-- customer presents a card, the cashier taps a configured discount, and nothing is written down.
-- So there is nothing to transcribe FROM, and a row entered live at the till is original capture
-- by a human rather than a copy of anything.
--
-- ⚠️ This project's own glossary (`docs/GLOSSARY.md`) is a list of columns whose names assert
-- something false about their data — a "dine-in" total that is package-only, a "take-out" total
-- that is really a residual, a "sequence" that is not monotonic. Minting another one
-- inside the table whose entire purpose is PROVENANCE would be the worst possible place for it.
-- 'manual' says only what is true: a person typed it. 'pos' stays as it is.
--
-- Safe to run as a plain UPDATE: the register holds no production rows — it has never been
-- deployed, and T-137 shipped in this same lane.

ALTER TABLE "statutory_discount_records" DROP CONSTRAINT "statutory_discount_records_source_check";--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
UPDATE "statutory_discount_records" SET "source" = 'manual' WHERE "source" = 'transcribed';--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ALTER COLUMN "source" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_source_check" CHECK ("source" in ('manual', 'pos'));
