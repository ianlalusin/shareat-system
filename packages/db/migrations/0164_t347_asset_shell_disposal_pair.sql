-- 0164 — T-347 (DEF-437): the cutover shell for fixed_assets cannot exist without a third branch
-- on fixed_assets_disposal_pair_check. docs/tasks/347-def-437-cutover-purge-assets.md §3.5.
--
-- A `pending_valuation` shell (cost/acquired_on/in_service_* all NULL, per 0019's
-- fixed_assets_valuation_shape_check and 0163's fixed_assets_in_service_shape_check) satisfies
-- NEITHER of this constraint's two existing branches: 'active' requires status = 'active' (wrong),
-- 'disposed' requires disposed_on/disposal_reason NOT NULL (a shell was never disposed). The purge
-- engine's shell UPDATE (packages/db/src/cutover/purge.ts) would raise 23514 on every row it tries
-- to shelve. This migration adds the third branch a shell actually satisfies: status =
-- 'pending_valuation' with disposed_on, disposal_reason AND disposed_by all NULL.
--
-- No data change: no `pending_valuation` row can exist yet (the purge engine that would create one
-- does not exist before this migration), so this is a pure CHECK replacement, drop-and-re-add,
-- nothing else moves.
--
-- Hand-authored per ADR-012 §5 -- `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "fixed_assets" DROP CONSTRAINT "fixed_assets_disposal_pair_check";--> statement-breakpoint

ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_pair_check" CHECK (
	("fixed_assets"."status" = 'active' and "fixed_assets"."disposed_on" is null and "fixed_assets"."disposal_reason" is null)
	or ("fixed_assets"."status" = 'disposed' and "fixed_assets"."disposed_on" is not null and "fixed_assets"."disposal_reason" is not null)
	or (
		"fixed_assets"."status" = 'pending_valuation'
		and "fixed_assets"."disposed_on" is null
		and "fixed_assets"."disposal_reason" is null
		and "fixed_assets"."disposed_by" is null
	)
);
