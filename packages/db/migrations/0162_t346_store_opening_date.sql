-- 0162 — T-346 S1 (DEF-428): a store's opening date.
-- docs/tasks/346-store-opening-and-in-service-date.md §3.1, Amendment R1 item 3 (binding backfill
-- definition), Amendment R2 item 3 (the SQL isPreOpening fragment is deferred to S3, where its
-- readers land; S1 ships only the TS twin in repo/stores.ts), Amendment R3 item 2 (the backfill
-- must fail loudly rather than silently under-backfill under RLS).
--
-- Adds stores.opening_date -- null = not yet open, a future date = planned, a past date = the day
-- it opened. Backfills every existing store to the earliest of its first non-voided sales day or
-- its first posted sale-entry line, via store_first_trading_date(store_id) -- the ONE definition
-- of "has this store traded", also called at runtime by repo/stores.ts for
-- setStoreOpeningDate's own refusal, so a one-time backfill and a live check can never quietly
-- disagree. Rent, an asset purchase, or a voided sales day never marks a store open.
--
-- ⚠️ The backfill spans every org, so it must not run RLS-filtered -- a role subject to RLS with no
-- app.org_id GUC set (no ordinary connection during a migration has one) would otherwise silently
-- see ZERO rows in sales_days/journal_entries for every org and backfill nothing, with no error.
-- Production migrates as `doadmin`, "the one role RLS cannot filter" (docs/ops/README.md:61), so
-- this is a no-op there; SET LOCAL row_security = off makes any OTHER role fail loudly instead of
-- silently under-backfilling. Reset to `on` immediately after, in the SAME transaction as every
-- other pending migration (drizzle's migrator), so the exemption cannot leak into 0163+.
--
-- Hand-authored per ADR-012 §5 -- `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "stores" ADD COLUMN "opening_date" date;--> statement-breakpoint

-- STABLE, no SECURITY DEFINER -- runs under the CALLER's own privileges (and RLS, when RLS
-- applies to the caller), exactly like any ordinary query; it adds no privilege of its own.
-- Postgres's least() ignores NULL arguments and returns NULL only when every argument is NULL,
-- which is exactly "neither a sales day nor a sale entry has happened yet".
CREATE FUNCTION "store_first_trading_date"("p_store_id" uuid) RETURNS date
LANGUAGE sql STABLE AS $$
	SELECT least(
		(SELECT min("business_date") FROM "sales_days"
			WHERE "store_id" = "p_store_id" AND "status" <> 'voided'),
		(SELECT min(je."entry_date") FROM "journal_entries" je
			JOIN "journal_lines" jl ON jl."entry_id" = je."id"
			WHERE je."source_type" = 'sale' AND je."status" = 'posted' AND jl."store_id" = "p_store_id")
	);
$$;--> statement-breakpoint

-- Backfill -- an existing trading store is open from its first recorded activity. A store with
-- neither a non-voided sales day nor a posted sale entry is left NULL (not yet open). Zero rows
-- match on a fresh, empty database (DEF-073's own bar): this statement is then a no-op.
SET LOCAL row_security = off;--> statement-breakpoint
UPDATE "stores" SET "opening_date" = "store_first_trading_date"("id");--> statement-breakpoint
SET LOCAL row_security = on;
