-- 0166 — T-349 / DEF-456: repair the "hold in their own right" rows this defect already widened
-- to every store, re-scoping each to the store(s) the job actually justified at the moment of the
-- click. docs/tasks/349-def-456-store-scoped-hold-own-right.md §3.5, §9 Q1 (Ian, 2026-09-27: YES,
-- re-scope), and "S3 Amendment A1" (2026-09-28, orchestrator, drafted by the independent Opus S2c
-- auditor) — binding, and this migration follows the AMENDED definition, not §3.5's original one.
--
-- ⛔ **Why §3.5's own justification for "no other path produces one" no longer holds** (full
-- argument: task doc §9, "S3 Amendment A1"). §3.5 defined a widened row R as: an ACTIVE
-- person_grants row with grant_source = 'grant', store_id NULL, source_ref NULL, beside a
-- 'position' row P for the same (person_id, grant_name) active at R's granted_at — and reasoned
-- that only the old (pre-S2) hold button could have produced that shape, since the picker hid
-- every capability the person already held. That premise broke at S2b (commit 8d14e7a): the
-- picker now hides only capabilities held ORG-WIDE, so an admin can deliberately grant, org-wide,
-- a capability the person also holds through a job — R's exact shape, on purpose. S2c's
-- close-and-replace (task doc §4c) produces the same shape too. Re-scoping either would silently
-- narrow a deliberate org-wide grant to one store, which is not this migration's job.
--
-- **The two rows carry nothing that tells them apart — no reason, no ref, no distinguishing
-- source value.** What told them apart WAS the page: before S2b, an active P at R's time PROVES R
-- came from the old hold button (the picker could not have offered that capability otherwise).
-- After S2b it proves nothing. The only remaining discriminator is TIME.
--
-- Amended definition (three conditions, all required — Step 1/2 below implement it):
--   1. Shape (§3.5, unchanged) — R is ACTIVE, grant_source = 'grant', store_id IS NULL,
--      source_ref IS NULL; a 'position' row P exists for the same (person_id, grant_name) with
--      P.granted_at < R.granted_at AND (P.revoked_at IS NULL OR P.revoked_at > R.granted_at) —
--      i.e. P was active at the moment R was granted, whether or not P is still active today.
--   2. Date bound, new — R.granted_at < '2026-09-27T10:59:23Z' (the committer time of ea0ccb4,
--      2026-09-27T18:59:23+08:00, S2's own deploy of the store-scoped hold path), strict `<`.
--      From that commit on, the hold path writes a store-scoped row for a store-scoped
--      capability, so no later NULL-store R can have come from the old button; the picker change
--      (8d14e7a) and S2c's replacements both come strictly later still. This errs in the safe
--      direction: a hold clicked in production between the commit and its actual deploy stays
--      org-wide (today's state, visible and revocable by hand), never wrongly narrowed.
--   3. Store-scoped capabilities only, new — R.grant_name is one of the 76 capabilities whose
--      CAPABILITY_SCOPE (packages/auth/src/capabilities.ts, HEAD df5d2fe5be1cb1c5f948c8cd05e02336f44d997a)
--      is 'store'. For an org-scoped capability authorize() applies no store filter, so a
--      NULL-store row is the CORRECT shape (§3.2 item 9's own ruling — S2 itself writes NULL-store
--      for an org-scoped hold); re-scoping one would create a shape S2 never writes and the page
--      would then read "hand-granted at X" for authority that is actually org-wide. The list
--      below is a SNAPSHOT, pasted at build time — packages/db does not import @shareat/auth
--      (ADR-004), the same reason 0159's own step-5 elevation list is a literal — and a migration
--      is immutable, so a later edit to CAPABILITY_SCOPE never touches it.
--
-- Two steps, in order, both re-evaluating the same three-condition match on R independently (a
-- conflict on step 1 for one store must never skip step 2's revoke of R):
--   1. For each matching R and each DISTINCT store among its matching P rows, insert a
--      store-scoped 'grant' row there, carrying R's own granted_by/granted_at (0159 step 5's own
--      precedent: provenance is copied, not re-dated). ON CONFLICT DO NOTHING against
--      person_grants_active_grant_store_unique (migration 0165) makes a re-run idempotent. This
--      can re-scope to MORE than the store that was clicked — every store a P proves — which Q1's
--      answer accepts: the click was meant to stay at a store, and nobody chose the wider reach.
--   2. Revoke R with a reason naming DEF-456 and this migration.
--
-- ⚠️ `person_grants` is FORCE ROW LEVEL SECURITY (migration 0014:84) — FORCE means even the table's
-- OWNER is filtered, unlike an ordinary RLS table. This repair spans every org (R and its matching
-- P can belong to any org in the database), so it must not run RLS-filtered — a role subject to
-- RLS with no app.org_id GUC set (no ordinary connection during a migration has one) would
-- otherwise silently see ZERO rows for every org and repair nothing, with no error. Production
-- migrates as `doadmin`, "the one role RLS cannot filter" (docs/ops/README.md:61), so this is a
-- no-op there; SET LOCAL row_security = off makes any OTHER role fail loudly instead of silently
-- under-repairing. Reset to `on` immediately after, in the SAME transaction as every other pending
-- migration (drizzle's migrator), so the exemption cannot leak into 0167+. Same pattern 0162
-- (store_id backfill) and 0163 (in_service_source backfill) already use; see 0162's own header.
-- Only a role RLS cannot filter (`doadmin` in production) can apply 0166; any other role now
-- fails LOUDLY with Postgres's own "query would be affected by row-level security policy for
-- table \"person_grants\"" instead of silently under-repairing — that failure is intended, not a
-- bug to route around.
--
-- Additive to no schema (no DDL; packages/db/schema/ is unchanged, no "hand-added" note to
-- place — ADR-012 §5 step 3). Needs 0165 applied first (person_grants_active_grant_store_unique,
-- the shape CHECK that makes a store-scoped 'grant' row legal).
--
-- HAND-WRITTEN, per ADR-012 §5 (packages/db/migrations/README.md) — drizzle-kit generate is
-- retired. Never edited after apply (RULES §1 rule 9). Applied only to test/scratch databases so
-- far — editing it before it reaches a shared database is allowed (RULES §1 rule 9's own bar).

-- ---------------------------------------------------------------------------------------------
-- Step 1 — insert a store-scoped 'grant' row at every store a matching P proves, for every
-- matching R. `DISTINCT` collapses more than one P row at the same store (e.g. a revoked-then-
-- reissued position row) to one insert; ON CONFLICT DO NOTHING covers the same case again plus a
-- re-run of this migration.
-- ---------------------------------------------------------------------------------------------
SET LOCAL row_security = off;--> statement-breakpoint
INSERT INTO "person_grants" ("person_id", "grant_name", "granted_by", "grant_source", "source_ref", "store_id", "granted_at")
SELECT DISTINCT
	"r"."person_id",
	"r"."grant_name",
	"r"."granted_by",
	'grant',
	NULL::uuid,
	"p"."store_id",
	"r"."granted_at"
FROM "person_grants" "r"
JOIN "person_grants" "p"
	ON "p"."person_id" = "r"."person_id"
	AND "p"."grant_name" = "r"."grant_name"
	AND "p"."grant_source" = 'position'
	AND "p"."granted_at" < "r"."granted_at"
	AND ("p"."revoked_at" IS NULL OR "p"."revoked_at" > "r"."granted_at")
WHERE "r"."grant_source" = 'grant'
	AND "r"."store_id" IS NULL
	AND "r"."source_ref" IS NULL
	AND "r"."revoked_at" IS NULL
	AND "r"."granted_at" < '2026-09-27T10:59:23Z'
	AND "r"."grant_name" = ANY (ARRAY[
		'record_sale','submit_sales_day','verify_sales_day','void_sales_day',
		'record_statutory_discount','void_statutory_discount','accept_remittance',
		'record_till_count','resolve_till_variance','transfer_funds','create_expense',
		'edit_own_expense','edit_any_expense','void_expense','approve_expense',
		'record_stock_movement','adjust_inventory','record_wastage',
		'charge_staff_for_discrepancy','transfer_stock','void_transfer',
		'record_supplier_return','void_supplier_return','apply_supplier_credit',
		'record_customer_return','void_customer_return','apply_customer_credit',
		'refund_customer','confirm_receipt','resolve_trade_discrepancy',
		'set_item_threshold','post_order_message','place_branch_order',
		'fulfil_branch_order','dispatch_branch_order','manage_locations',
		'receive_delivery','allow_over_receipt','post_usage','void_usage_record',
		'open_count_session','commit_count','approve_buyer','manage_expense_budgets',
		'manage_recurring_expenses','override_credit_limit','record_ap_payment',
		'record_ar_collection','write_off_receivable','record_supplier_invoice',
		'verify_supplier_invoice','void_supplier_invoice','create_wholesale_order',
		'dispatch_wholesale_order','view_financial_reports','reverse_entry',
		'enrol_staff','manage_attendance','set_pay_rate','run_payroll',
		'provision_clock_terminal','manage_store_settings','set_cash_policy',
		'manage_commissary_offerings','manage_commissary_map','post_production',
		'edit_posted_production','void_production','record_order_wastage',
		'resolve_order_wastage','charge_staff_for_wastage','reverse_auto_charge',
		'manage_pos_map','request_pos_map','decide_pos_map_request',
		'finalize_pos_usage_pull'
	])
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Step 2 — revoke every R the same three conditions match, independent of what step 1 inserted
-- (a conflict there means "already there", never "nothing to revoke").
-- ---------------------------------------------------------------------------------------------
UPDATE "person_grants" "r"
SET "revoked_at" = now(),
	"revoke_reason" = 'DEF-456: an own-right hold was widened to every store; re-scoped to the store(s) of the job it came from (migration 0166)'
WHERE "r"."grant_source" = 'grant'
	AND "r"."store_id" IS NULL
	AND "r"."source_ref" IS NULL
	AND "r"."revoked_at" IS NULL
	AND "r"."granted_at" < '2026-09-27T10:59:23Z'
	AND "r"."grant_name" = ANY (ARRAY[
		'record_sale','submit_sales_day','verify_sales_day','void_sales_day',
		'record_statutory_discount','void_statutory_discount','accept_remittance',
		'record_till_count','resolve_till_variance','transfer_funds','create_expense',
		'edit_own_expense','edit_any_expense','void_expense','approve_expense',
		'record_stock_movement','adjust_inventory','record_wastage',
		'charge_staff_for_discrepancy','transfer_stock','void_transfer',
		'record_supplier_return','void_supplier_return','apply_supplier_credit',
		'record_customer_return','void_customer_return','apply_customer_credit',
		'refund_customer','confirm_receipt','resolve_trade_discrepancy',
		'set_item_threshold','post_order_message','place_branch_order',
		'fulfil_branch_order','dispatch_branch_order','manage_locations',
		'receive_delivery','allow_over_receipt','post_usage','void_usage_record',
		'open_count_session','commit_count','approve_buyer','manage_expense_budgets',
		'manage_recurring_expenses','override_credit_limit','record_ap_payment',
		'record_ar_collection','write_off_receivable','record_supplier_invoice',
		'verify_supplier_invoice','void_supplier_invoice','create_wholesale_order',
		'dispatch_wholesale_order','view_financial_reports','reverse_entry',
		'enrol_staff','manage_attendance','set_pay_rate','run_payroll',
		'provision_clock_terminal','manage_store_settings','set_cash_policy',
		'manage_commissary_offerings','manage_commissary_map','post_production',
		'edit_posted_production','void_production','record_order_wastage',
		'resolve_order_wastage','charge_staff_for_wastage','reverse_auto_charge',
		'manage_pos_map','request_pos_map','decide_pos_map_request',
		'finalize_pos_usage_pull'
	])
	AND EXISTS (
		SELECT 1 FROM "person_grants" "p"
		WHERE "p"."person_id" = "r"."person_id"
			AND "p"."grant_name" = "r"."grant_name"
			AND "p"."grant_source" = 'position'
			AND "p"."granted_at" < "r"."granted_at"
			AND ("p"."revoked_at" IS NULL OR "p"."revoked_at" > "r"."granted_at")
	);--> statement-breakpoint
SET LOCAL row_security = on;
