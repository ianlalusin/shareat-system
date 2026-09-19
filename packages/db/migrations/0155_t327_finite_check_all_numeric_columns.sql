-- 0155 — T-327: the database refuses a non-finite amount, on every base-table numeric column, so
-- the census T-328 runs next is allowed to be wrong. docs/tasks/327-a-poison-value-that-passes-
-- every-guard.md §Contract 1. Halves DEF-382 — T-328 closes it.
--
-- ⛔⛔ WHY A CONSTRAINT, NOT A CODE FIX. Measured (spec P1), on a real `numeric(14,2) CHECK (amount
-- > 0)` column: `'NaN'::numeric > 0` is `true` in Postgres, so `'NaN'` is STORED past that check
-- today. `NaN + 100` and `NaN * 0` are both `NaN` — one poisoned row turns every `sum()` over that
-- column into `NaN` permanently, and multiplying by zero does not clear it. `packages/core/src/
-- money.ts` already rejects `NaN`/`±Infinity` (P4) — the defect was never "validation is missing",
-- it is "paths that do not reach it" (T-328's job). This migration is the layer that makes the
-- next miss non-fatal regardless of which paths T-328 finds: it guards every column without
-- asking which ones are money (bible §15.11 — no layer may be the only one for a given risk).
--
-- ⛔ NOT `CHECK (col <> 'NaN')` — correct today, silent the day a bare (no-precision) `numeric`
-- column is ever added. NOT `CHECK (col = col)` — measured, `'NaN'::numeric = 'NaN'::numeric` is
-- `true` in Postgres, so that form does not reject it either. The finite-range form below covers
-- both `NaN` and `±Infinity` in one expression at no extra cost, and is correct on that future day
-- even though every column here already carries a precision that independently refuses `±Infinity`
-- by overflowing (P3) — the schema-coverage test is what actually catches an unguarded new column,
-- not this constraint's redundant Infinity half.
--
-- ⛔⛔ TARGET IS 160 BASE-TABLE COLUMNS, NOT 172 — CORRECTED AT PROTOCOL STEP 0, BEFORE THIS FILE
-- EXISTED. The spec's first draft counted 172 by `grep -c "numeric('" packages/db/schema/*.ts`,
-- which is real but conflates two different populations: 160 real `pgTable` columns (targetable)
-- plus 12 `pgView` column DESCRIPTORS in `views.ts` (`v_account_balance`, `v_trial_balance`,
-- `v_income_statement`, `v_balance_sheet`) that happen to match the same grep. Postgres cannot put
-- a CHECK constraint on a view at all — `ALTER TABLE v_trial_balance ADD CONSTRAINT …` is not a
-- thing. Verified against the live catalogue: `select cl.relkind, count(*) from pg_attribute a
-- join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace where
-- n.nspname = 'public' and a.atttypid = 'numeric'::regtype and a.attnum > 0 and not
-- a.attisdropped group by 1` → `r: 160  v: 12`. The 12 view columns need no guard structurally
-- either: each is a `sum()`/`CASE` over base-table columns this migration now guarantees finite,
-- cast `::numeric(14,2)` — P3 establishes that cast refuses a non-finite value outright, and a sum
-- of finite values is finite. A view is a projection, not a storage location.
--
-- ⛔⛔ TWO CONSTRAINT NAMES ARE SHORTENED — `store_attendance_config`'s natural
-- `<table>_<column>_finite_check` name exceeds Postgres's 63-byte identifier limit for two columns
-- and would be SILENTLY TRUNCATED (no error), which would drop the `_finite_check` suffix itself
-- (`…non_working_multiplier_` — suffix gone entirely) or cut it in half (`…working_multiplier_fini`
-- — 61 chars in, still 10 over). Either way the sanitiser's suffix rule (constraint-messages.ts)
-- would never match, so the column would still be guarded (data safe) but a cashier who tripped it
-- would get the raw Postgres dump anyway — a §2 hole that ships green. Measured (orchestrator,
-- live DB) and re-verified independently before use:
--   store_attendance_config_holiday_special_non_working_multiplier_finite_check  = 75 bytes (over)
--   store_attendance_config_holiday_special_working_multiplier_finite_check      = 71 bytes (over)
-- Shortened, table prefix and `_finite_check` suffix both kept intact, only the column segment
-- abbreviated, collision-checked against every other check() on this table and against the other
-- 158 finite-check names — neither collides:
--   store_attendance_config_holiday_spcl_nonwk_mult_finite_check    = 60 bytes → holiday_special_non_working_multiplier
--   store_attendance_config_holiday_spcl_working_mult_finite_check  = 62 bytes → holiday_special_working_multiplier
-- No other one of the 160 needed shortening — every other natural `<table>_<column>_finite_check`
-- name measured ≤63 bytes. `constraint-messages.ts`'s suffix rule keys ONLY on the literal
-- `_finite_check` ending, never on parsing a table/column back out of the name — required anyway,
-- since these two names no longer contain their full column name.
--
-- ⛔ Data repair is out of scope — P2 measured zero columns currently holding a NaN, across all
-- 160. Every existing money test stays green: `0` remains legitimate (bible §12 landmine 8),
-- negatives remain legitimate where a column already allows them, `NULL` is unaffected in nullable
-- columns — this expression passes on `NULL` (a CHECK passes on NULL by definition) and rejects
-- only `NaN` and `±Infinity`, nothing else a real column already accepted.
--
-- No new table and no schema shape Drizzle cannot express (ADR-012 §5 step 3 does not apply): 160
-- ordinary `check()` entries were added to `packages/db/schema/*.ts` alongside these statements,
-- mirroring `ap-payments.ts`'s `check('<name>', sql\`…\`)` form — this file is the transcription of
-- those 160 check() entries into hand-authored SQL (`npm run db:generate` is retired and fails
-- closed, DEF-242). No RLS/registry/classification entry needed — no new table.
--
-- Ordered alphabetically by table name, then column name, for review — not journal or dependency
-- order; every statement here is independent of every other (no FK, no shared index).
--
-- ⛔⛔ LOCKING — drizzle's migrator runs every statement in a file in ONE transaction (the same
-- reason 0153 could add a generated column and then refuse on a collision before the index swap,
-- all-or-nothing). That means all 160 `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` statements
-- below hold ACCESS EXCLUSIVE on 65 tables (160 constraints) SIMULTANEOUSLY until the transaction
-- commits, and each one is not free to take: an `ADD CONSTRAINT CHECK` with no `NOT VALID` scans
-- and validates every existing row in its table before the lock can be released. Against a
-- populated database this blocks essentially every read and write on all 65 tables for as long as
-- the slowest table's scan takes — not merely the one table being altered, because the lock on
-- every other table in the same transaction is already held and not released until the whole thing
-- commits.
--
-- ⭐ Why that is acceptable HERE AND NOW, not in general: P2 measured 0 rows currently holding a
-- non-finite value, across all 160 columns; this is pre-cutover, with no staff using the system;
-- and with 0 poisoned rows the validation scan over each table is a sequential read with nothing
-- to reject, on tables that are empty or near-empty in every environment this migration runs in
-- today. The lock is real; the DURATION it is held for, today, is not.
--
-- ⚠️ THE STANDARD REMEDY, BY NAME, for whoever meets this same migration on a database that is no
-- longer small: split each statement into `ALTER TABLE <t> ADD CONSTRAINT <name> CHECK (...) NOT
-- VALID` (takes a brief ACCESS EXCLUSIVE only to record the constraint, protects every new row
-- immediately, and does not scan existing ones) followed by a separate `VALIDATE CONSTRAINT <name>`
-- per table (takes only SHARE UPDATE EXCLUSIVE — reads and writes to other rows continue — and does
-- the same row-by-row scan, just without blocking the table while it runs). Identical protection
-- for every row written after the `NOT VALID` half lands, at a fraction of the lock.
--
-- ⭐ THE TRAP THAT COMES WITH THAT REMEDY, for whoever reaches for it later: test 2
-- (`t327-schema-coverage-finite-check.test.ts`) filters `pg_constraint` on `contype = 'c'` and the
-- `_finite_check` name suffix, and never reads `convalidated`. A `NOT VALID` constraint that has
-- never been validated satisfies test 2 exactly as well as a fully validated one — harmless for
-- what test 2 is FOR (the anti-rot guarantee that no numeric column is left unguarded against a
-- FUTURE write), because an unvalidated constraint still rejects every new row from the moment it
-- exists. But it means test 2 cannot tell anyone whether the validation half — the guarantee about
-- rows that already existed before the constraint was added — ever actually ran. That is a
-- different question from the one test 2 asks, and nothing in this slice answers it.
--
-- ⚠️ ONE MORE CONSEQUENCE, proven the hard way rather than reasoned: this migration, as written,
-- REFUSES TO APPLY to any database that already holds a non-finite value in a guarded column — the
-- migrator reports "check constraint ... is violated by some row" and names the first constraint it
-- hits, exactly like any other `ADD CONSTRAINT CHECK` would. That is correct behaviour, not a bug —
-- but it means 0155 cannot be applied to production, or to any lane database, sight unseen.

ALTER TABLE "ap_payment_allocations" ADD CONSTRAINT "ap_payment_allocations_amount_applied_finite_check"
	CHECK ("ap_payment_allocations"."amount_applied" > '-Infinity'::numeric AND "ap_payment_allocations"."amount_applied" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_amount_finite_check"
	CHECK ("ap_payments"."amount" > '-Infinity'::numeric AND "ap_payments"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "ar_charges" ADD CONSTRAINT "ar_charges_total_amount_finite_check"
	CHECK ("ar_charges"."total_amount" > '-Infinity'::numeric AND "ar_charges"."total_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "ar_collection_allocations" ADD CONSTRAINT "ar_collection_allocations_amount_applied_finite_check"
	CHECK ("ar_collection_allocations"."amount_applied" > '-Infinity'::numeric AND "ar_collection_allocations"."amount_applied" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_amount_finite_check"
	CHECK ("ar_collections"."amount" > '-Infinity'::numeric AND "ar_collections"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "ar_collections" ADD CONSTRAINT "ar_collections_platform_fee_finite_check"
	CHECK ("ar_collections"."platform_fee" > '-Infinity'::numeric AND "ar_collections"."platform_fee" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "ar_write_offs" ADD CONSTRAINT "ar_write_offs_amount_finite_check"
	CHECK ("ar_write_offs"."amount" > '-Infinity'::numeric AND "ar_write_offs"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "asset_policy" ADD CONSTRAINT "asset_policy_capitalization_threshold_finite_check"
	CHECK ("asset_policy"."capitalization_threshold" > '-Infinity'::numeric AND "asset_policy"."capitalization_threshold" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "asset_policy" ADD CONSTRAINT "asset_policy_default_salvage_value_finite_check"
	CHECK ("asset_policy"."default_salvage_value" > '-Infinity'::numeric AND "asset_policy"."default_salvage_value" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_approved_amount_finite_check"
	CHECK ("cash_requests"."approved_amount" > '-Infinity'::numeric AND "cash_requests"."approved_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "cash_requests" ADD CONSTRAINT "cash_requests_requested_amount_finite_check"
	CHECK ("cash_requests"."requested_amount" > '-Infinity'::numeric AND "cash_requests"."requested_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_commission_finite_check"
	CHECK ("channel_settlements"."commission" > '-Infinity'::numeric AND "channel_settlements"."commission" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_gross_amount_finite_check"
	CHECK ("channel_settlements"."gross_amount" > '-Infinity'::numeric AND "channel_settlements"."gross_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_loan_deduction_finite_check"
	CHECK ("channel_settlements"."loan_deduction" > '-Infinity'::numeric AND "channel_settlements"."loan_deduction" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_marketing_finite_check"
	CHECK ("channel_settlements"."marketing" > '-Infinity'::numeric AND "channel_settlements"."marketing" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_net_deposited_finite_check"
	CHECK ("channel_settlements"."net_deposited" > '-Infinity'::numeric AND "channel_settlements"."net_deposited" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_outstanding_cleared_finite_check"
	CHECK ("channel_settlements"."outstanding_cleared" > '-Infinity'::numeric AND "channel_settlements"."outstanding_cleared" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_penalty_finite_check"
	CHECK ("channel_settlements"."penalty" > '-Infinity'::numeric AND "channel_settlements"."penalty" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_platform_fee_finite_check"
	CHECK ("channel_settlements"."platform_fee" > '-Infinity'::numeric AND "channel_settlements"."platform_fee" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_settlement_gain_finite_check"
	CHECK ("channel_settlements"."settlement_gain" > '-Infinity'::numeric AND "channel_settlements"."settlement_gain" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_variance_finite_check"
	CHECK ("channel_settlements"."variance" > '-Infinity'::numeric AND "channel_settlements"."variance" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_vat_on_fees_finite_check"
	CHECK ("channel_settlements"."vat_on_fees" > '-Infinity'::numeric AND "channel_settlements"."vat_on_fees" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_withholding_tax_finite_check"
	CHECK ("channel_settlements"."withholding_tax" > '-Infinity'::numeric AND "channel_settlements"."withholding_tax" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "commissary_item_offerings" ADD CONSTRAINT "commissary_item_offerings_manual_cost_finite_check"
	CHECK ("commissary_item_offerings"."manual_cost" > '-Infinity'::numeric AND "commissary_item_offerings"."manual_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_counted_quantity_finite_check"
	CHECK ("count_lines"."counted_quantity" > '-Infinity'::numeric AND "count_lines"."counted_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_expected_quantity_finite_check"
	CHECK ("count_lines"."expected_quantity" > '-Infinity'::numeric AND "count_lines"."expected_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_variance_finite_check"
	CHECK ("count_lines"."variance" > '-Infinity'::numeric AND "count_lines"."variance" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "customer_return_lines" ADD CONSTRAINT "customer_return_lines_amount_finite_check"
	CHECK ("customer_return_lines"."amount" > '-Infinity'::numeric AND "customer_return_lines"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "customer_return_lines" ADD CONSTRAINT "customer_return_lines_cost_finite_check"
	CHECK ("customer_return_lines"."cost" > '-Infinity'::numeric AND "customer_return_lines"."cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "customer_return_lines" ADD CONSTRAINT "customer_return_lines_quantity_finite_check"
	CHECK ("customer_return_lines"."quantity" > '-Infinity'::numeric AND "customer_return_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_limit_finite_check"
	CHECK ("customers"."credit_limit" > '-Infinity'::numeric AND "customers"."credit_limit" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_conversion_factor_finite_check"
	CHECK ("delivery_lines"."conversion_factor" > '-Infinity'::numeric AND "delivery_lines"."conversion_factor" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_ordered_quantity_finite_check"
	CHECK ("delivery_lines"."ordered_quantity" > '-Infinity'::numeric AND "delivery_lines"."ordered_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_received_quantity_finite_check"
	CHECK ("delivery_lines"."received_quantity" > '-Infinity'::numeric AND "delivery_lines"."received_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_unit_cost_finite_check"
	CHECK ("delivery_lines"."unit_cost" > '-Infinity'::numeric AND "delivery_lines"."unit_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "etl_reconciliation" ADD CONSTRAINT "etl_reconciliation_credit_total_finite_check"
	CHECK ("etl_reconciliation"."credit_total" > '-Infinity'::numeric AND "etl_reconciliation"."credit_total" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "etl_reconciliation" ADD CONSTRAINT "etl_reconciliation_debit_total_finite_check"
	CHECK ("etl_reconciliation"."debit_total" > '-Infinity'::numeric AND "etl_reconciliation"."debit_total" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "etl_reconciliation" ADD CONSTRAINT "etl_reconciliation_source_amount_total_finite_check"
	CHECK ("etl_reconciliation"."source_amount_total" > '-Infinity'::numeric AND "etl_reconciliation"."source_amount_total" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_amount_finite_check"
	CHECK ("expense_budgets"."amount" > '-Infinity'::numeric AND "expense_budgets"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_amount_finite_check"
	CHECK ("expense_payments"."amount" > '-Infinity'::numeric AND "expense_payments"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_total_amount_finite_check"
	CHECK ("expenses"."total_amount" > '-Infinity'::numeric AND "expenses"."total_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_cost_finite_check"
	CHECK ("fixed_assets"."cost" > '-Infinity'::numeric AND "fixed_assets"."cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_salvage_value_finite_check"
	CHECK ("fixed_assets"."salvage_value" > '-Infinity'::numeric AND "fixed_assets"."salvage_value" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_fixed_amount_finite_check"
	CHECK ("item_pricing"."fixed_amount" > '-Infinity'::numeric AND "item_pricing"."fixed_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_fixed_markup_amount_finite_check"
	CHECK ("item_pricing"."fixed_markup_amount" > '-Infinity'::numeric AND "item_pricing"."fixed_markup_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_margin_alert_threshold_pct_finite_check"
	CHECK ("item_pricing"."margin_alert_threshold_pct" > '-Infinity'::numeric AND "item_pricing"."margin_alert_threshold_pct" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "item_pricing" ADD CONSTRAINT "item_pricing_markup_percent_finite_check"
	CHECK ("item_pricing"."markup_percent" > '-Infinity'::numeric AND "item_pricing"."markup_percent" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_credit_finite_check"
	CHECK ("journal_lines"."credit" > '-Infinity'::numeric AND "journal_lines"."credit" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_debit_finite_check"
	CHECK ("journal_lines"."debit" > '-Infinity'::numeric AND "journal_lines"."debit" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_interest_rate_finite_check"
	CHECK ("loans"."interest_rate" > '-Infinity'::numeric AND "loans"."interest_rate" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_principal_amount_finite_check"
	CHECK ("loans"."principal_amount" > '-Infinity'::numeric AND "loans"."principal_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_float_target_finite_check"
	CHECK ("money_accounts"."float_target" > '-Infinity'::numeric AND "money_accounts"."float_target" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_overdraft_limit_finite_check"
	CHECK ("money_accounts"."overdraft_limit" > '-Infinity'::numeric AND "money_accounts"."overdraft_limit" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_amount_in_finite_check"
	CHECK ("money_transfers"."amount_in" > '-Infinity'::numeric AND "money_transfers"."amount_in" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_amount_out_finite_check"
	CHECK ("money_transfers"."amount_out" > '-Infinity'::numeric AND "money_transfers"."amount_out" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_quantity_finite_check"
	CHECK ("opening_counts"."quantity" > '-Infinity'::numeric AND "opening_counts"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "opening_counts" ADD CONSTRAINT "opening_counts_unit_cost_finite_check"
	CHECK ("opening_counts"."unit_cost" > '-Infinity'::numeric AND "opening_counts"."unit_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "order_wastage_allocations" ADD CONSTRAINT "order_wastage_allocations_percent_finite_check"
	CHECK ("order_wastage_allocations"."percent" > '-Infinity'::numeric AND "order_wastage_allocations"."percent" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_amount_finite_check"
	CHECK ("order_wastages"."amount" > '-Infinity'::numeric AND "order_wastages"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_acknowledged_amount_finite_check"
	CHECK ("owner_drawing_closes"."acknowledged_amount" > '-Infinity'::numeric AND "owner_drawing_closes"."acknowledged_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "owner_drawing_closes" ADD CONSTRAINT "owner_drawing_closes_adjustment_amount_finite_check"
	CHECK ("owner_drawing_closes"."adjustment_amount" > '-Infinity'::numeric AND "owner_drawing_closes"."adjustment_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_drawing_limit_finite_check"
	CHECK ("owners"."drawing_limit" > '-Infinity'::numeric AND "owners"."drawing_limit" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_ownership_percentage_finite_check"
	CHECK ("owners"."ownership_percentage" > '-Infinity'::numeric AND "owners"."ownership_percentage" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_amount_finite_check"
	CHECK ("pay_rates"."amount" > '-Infinity'::numeric AND "pay_rates"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_advance_recovered_finite_check"
	CHECK ("payslips"."advance_recovered" > '-Infinity'::numeric AND "payslips"."advance_recovered" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_basic_pay_finite_check"
	CHECK ("payslips"."basic_pay" > '-Infinity'::numeric AND "payslips"."basic_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_days_worked_finite_check"
	CHECK ("payslips"."days_worked" > '-Infinity'::numeric AND "payslips"."days_worked" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_gross_pay_finite_check"
	CHECK ("payslips"."gross_pay" > '-Infinity'::numeric AND "payslips"."gross_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_holiday_pay_finite_check"
	CHECK ("payslips"."holiday_pay" > '-Infinity'::numeric AND "payslips"."holiday_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_net_pay_finite_check"
	CHECK ("payslips"."net_pay" > '-Infinity'::numeric AND "payslips"."net_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_night_diff_pay_finite_check"
	CHECK ("payslips"."night_diff_pay" > '-Infinity'::numeric AND "payslips"."night_diff_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_ot_pay_finite_check"
	CHECK ("payslips"."ot_pay" > '-Infinity'::numeric AND "payslips"."ot_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "pos_item_maps" ADD CONSTRAINT "pos_item_maps_quantity_per_sale_finite_check"
	CHECK ("pos_item_maps"."quantity_per_sale" > '-Infinity'::numeric AND "pos_item_maps"."quantity_per_sale" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" ADD CONSTRAINT "pos_usage_pull_lines_quantity_finite_check"
	CHECK ("pos_usage_pull_lines"."quantity" > '-Infinity'::numeric AND "pos_usage_pull_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "prepaid_items" ADD CONSTRAINT "prepaid_items_total_cost_finite_check"
	CHECK ("prepaid_items"."total_cost" > '-Infinity'::numeric AND "prepaid_items"."total_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_rate_finite_check"
	CHECK ("price_list_items"."rate" > '-Infinity'::numeric AND "price_list_items"."rate" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "production_recipe_lines" ADD CONSTRAINT "production_recipe_lines_quantity_finite_check"
	CHECK ("production_recipe_lines"."quantity" > '-Infinity'::numeric AND "production_recipe_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_output_quantity_finite_check"
	CHECK ("production_recipes"."output_quantity" > '-Infinity'::numeric AND "production_recipes"."output_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "production_record_lines" ADD CONSTRAINT "production_record_lines_quantity_finite_check"
	CHECK ("production_record_lines"."quantity" > '-Infinity'::numeric AND "production_record_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "production_records" ADD CONSTRAINT "production_records_labour_cost_finite_check"
	CHECK ("production_records"."labour_cost" > '-Infinity'::numeric AND "production_records"."labour_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_default_amount_finite_check"
	CHECK ("recurring_expenses"."default_amount" > '-Infinity'::numeric AND "recurring_expenses"."default_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "remittance_allocations" ADD CONSTRAINT "remittance_allocations_amount_finite_check"
	CHECK ("remittance_allocations"."amount" > '-Infinity'::numeric AND "remittance_allocations"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "remittance_lines" ADD CONSTRAINT "remittance_lines_amount_finite_check"
	CHECK ("remittance_lines"."amount" > '-Infinity'::numeric AND "remittance_lines"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "remittance_lines" ADD CONSTRAINT "remittance_lines_declared_overage_finite_check"
	CHECK ("remittance_lines"."declared_overage" > '-Infinity'::numeric AND "remittance_lines"."declared_overage" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "remittance_variances" ADD CONSTRAINT "remittance_variances_amount_finite_check"
	CHECK ("remittance_variances"."amount" > '-Infinity'::numeric AND "remittance_variances"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_day_channels" ADD CONSTRAINT "sales_day_channels_amount_finite_check"
	CHECK ("sales_day_channels"."amount" > '-Infinity'::numeric AND "sales_day_channels"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_day_tenders" ADD CONSTRAINT "sales_day_tenders_amount_finite_check"
	CHECK ("sales_day_tenders"."amount" > '-Infinity'::numeric AND "sales_day_tenders"."amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_ala_carte_sales_finite_check"
	CHECK ("sales_days"."ala_carte_sales" > '-Infinity'::numeric AND "sales_days"."ala_carte_sales" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_cash_collected_finite_check"
	CHECK ("sales_days"."cash_collected" > '-Infinity'::numeric AND "sales_days"."cash_collected" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_comps_finite_check"
	CHECK ("sales_days"."comps" > '-Infinity'::numeric AND "sales_days"."comps" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_credit_sales_finite_check"
	CHECK ("sales_days"."credit_sales" > '-Infinity'::numeric AND "sales_days"."credit_sales" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_online_collected_finite_check"
	CHECK ("sales_days"."online_collected" > '-Infinity'::numeric AND "sales_days"."online_collected" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_other_charges_finite_check"
	CHECK ("sales_days"."other_charges" > '-Infinity'::numeric AND "sales_days"."other_charges" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_other_discount_finite_check"
	CHECK ("sales_days"."other_discount" > '-Infinity'::numeric AND "sales_days"."other_discount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_pwd_discount_finite_check"
	CHECK ("sales_days"."pwd_discount" > '-Infinity'::numeric AND "sales_days"."pwd_discount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_senior_discount_finite_check"
	CHECK ("sales_days"."senior_discount" > '-Infinity'::numeric AND "sales_days"."senior_discount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_service_charge_finite_check"
	CHECK ("sales_days"."service_charge" > '-Infinity'::numeric AND "sales_days"."service_charge" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_total_sales_finite_check"
	CHECK ("sales_days"."total_sales" > '-Infinity'::numeric AND "sales_days"."total_sales" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_unli_sales_finite_check"
	CHECK ("sales_days"."unli_sales" > '-Infinity'::numeric AND "sales_days"."unli_sales" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_advance_recovered_finite_check"
	CHECK ("separations"."advance_recovered" > '-Infinity'::numeric AND "separations"."advance_recovered" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_net_pay_finite_check"
	CHECK ("separations"."net_pay" > '-Infinity'::numeric AND "separations"."net_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_separation_pay_amount_finite_check"
	CHECK ("separations"."separation_pay_amount" > '-Infinity'::numeric AND "separations"."separation_pay_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_thirteenth_month_basic_pay_earned_finite_check"
	CHECK ("separations"."thirteenth_month_basic_pay_earned" > '-Infinity'::numeric AND "separations"."thirteenth_month_basic_pay_earned" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "separations" ADD CONSTRAINT "separations_thirteenth_month_gross_finite_check"
	CHECK ("separations"."thirteenth_month_gross" > '-Infinity'::numeric AND "separations"."thirteenth_month_gross" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_discount_amount_finite_check"
	CHECK ("statutory_discount_records"."discount_amount" > '-Infinity'::numeric AND "statutory_discount_records"."discount_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_gross_amount_finite_check"
	CHECK ("statutory_discount_records"."gross_amount" > '-Infinity'::numeric AND "statutory_discount_records"."gross_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_cost_finite_check"
	CHECK ("stock_layer_consumptions"."cost" > '-Infinity'::numeric AND "stock_layer_consumptions"."cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_quantity_finite_check"
	CHECK ("stock_layer_consumptions"."quantity" > '-Infinity'::numeric AND "stock_layer_consumptions"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_layer_consumptions" ADD CONSTRAINT "stock_layer_consumptions_unit_cost_finite_check"
	CHECK ("stock_layer_consumptions"."unit_cost" > '-Infinity'::numeric AND "stock_layer_consumptions"."unit_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_quantity_finite_check"
	CHECK ("stock_layers"."quantity" > '-Infinity'::numeric AND "stock_layers"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_remaining_quantity_finite_check"
	CHECK ("stock_layers"."remaining_quantity" > '-Infinity'::numeric AND "stock_layers"."remaining_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_layers" ADD CONSTRAINT "stock_layers_unit_cost_finite_check"
	CHECK ("stock_layers"."unit_cost" > '-Infinity'::numeric AND "stock_layers"."unit_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_finite_check"
	CHECK ("stock_movements"."quantity" > '-Infinity'::numeric AND "stock_movements"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_quantity_finite_check"
	CHECK ("stock_reservations"."quantity" > '-Infinity'::numeric AND "stock_reservations"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_quantity_finite_check"
	CHECK ("stock_transfer_lines"."quantity" > '-Infinity'::numeric AND "stock_transfer_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_usage_lines" ADD CONSTRAINT "stock_usage_lines_quantity_finite_check"
	CHECK ("stock_usage_lines"."quantity" > '-Infinity'::numeric AND "stock_usage_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_default_break_hours_finite_check"
	CHECK ("store_attendance_config"."default_break_hours" > '-Infinity'::numeric AND "store_attendance_config"."default_break_hours" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_default_work_hours_finite_check"
	CHECK ("store_attendance_config"."default_work_hours" > '-Infinity'::numeric AND "store_attendance_config"."default_work_hours" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_half_day_hours_finite_check"
	CHECK ("store_attendance_config"."half_day_hours" > '-Infinity'::numeric AND "store_attendance_config"."half_day_hours" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_holiday_regular_multiplier_finite_check"
	CHECK ("store_attendance_config"."holiday_regular_multiplier" > '-Infinity'::numeric AND "store_attendance_config"."holiday_regular_multiplier" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_holiday_spcl_nonwk_mult_finite_check"
	CHECK ("store_attendance_config"."holiday_special_non_working_multiplier" > '-Infinity'::numeric AND "store_attendance_config"."holiday_special_non_working_multiplier" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_holiday_spcl_working_mult_finite_check"
	CHECK ("store_attendance_config"."holiday_special_working_multiplier" > '-Infinity'::numeric AND "store_attendance_config"."holiday_special_working_multiplier" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_late_charge_per_minute_finite_check"
	CHECK ("store_attendance_config"."late_charge_per_minute" > '-Infinity'::numeric AND "store_attendance_config"."late_charge_per_minute" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_night_diff_multiplier_finite_check"
	CHECK ("store_attendance_config"."night_diff_multiplier" > '-Infinity'::numeric AND "store_attendance_config"."night_diff_multiplier" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_overtime_fixed_hourly_finite_check"
	CHECK ("store_attendance_config"."overtime_fixed_hourly" > '-Infinity'::numeric AND "store_attendance_config"."overtime_fixed_hourly" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_overtime_multiplier_finite_check"
	CHECK ("store_attendance_config"."overtime_multiplier" > '-Infinity'::numeric AND "store_attendance_config"."overtime_multiplier" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_required_hours_per_shift_finite_check"
	CHECK ("store_attendance_config"."required_hours_per_shift" > '-Infinity'::numeric AND "store_attendance_config"."required_hours_per_shift" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "store_item_thresholds" ADD CONSTRAINT "store_item_thresholds_low_stock_threshold_finite_check"
	CHECK ("store_item_thresholds"."low_stock_threshold" > '-Infinity'::numeric AND "store_item_thresholds"."low_stock_threshold" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_unremitted_ceiling_finite_check"
	CHECK ("stores"."unremitted_ceiling" > '-Infinity'::numeric AND "stores"."unremitted_ceiling" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_conversion_factor_finite_check"
	CHECK ("supplier_invoice_lines"."conversion_factor" > '-Infinity'::numeric AND "supplier_invoice_lines"."conversion_factor" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_line_total_finite_check"
	CHECK ("supplier_invoice_lines"."line_total" > '-Infinity'::numeric AND "supplier_invoice_lines"."line_total" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_quantity_finite_check"
	CHECK ("supplier_invoice_lines"."quantity" > '-Infinity'::numeric AND "supplier_invoice_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_unit_price_finite_check"
	CHECK ("supplier_invoice_lines"."unit_price" > '-Infinity'::numeric AND "supplier_invoice_lines"."unit_price" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_delivery_fee_finite_check"
	CHECK ("supplier_invoices"."delivery_fee" > '-Infinity'::numeric AND "supplier_invoices"."delivery_fee" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_other_fees_finite_check"
	CHECK ("supplier_invoices"."other_fees" > '-Infinity'::numeric AND "supplier_invoices"."other_fees" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_total_amount_finite_check"
	CHECK ("supplier_invoices"."total_amount" > '-Infinity'::numeric AND "supplier_invoices"."total_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_vat_amount_finite_check"
	CHECK ("supplier_invoices"."vat_amount" > '-Infinity'::numeric AND "supplier_invoices"."vat_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_vat_exclusive_amount_finite_check"
	CHECK ("supplier_invoices"."vat_exclusive_amount" > '-Infinity'::numeric AND "supplier_invoices"."vat_exclusive_amount" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_vat_rate_finite_check"
	CHECK ("supplier_invoices"."vat_rate" > '-Infinity'::numeric AND "supplier_invoices"."vat_rate" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_quantity_finite_check"
	CHECK ("supplier_return_lines"."quantity" > '-Infinity'::numeric AND "supplier_return_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_unit_cost_finite_check"
	CHECK ("supplier_return_lines"."unit_cost" > '-Infinity'::numeric AND "supplier_return_lines"."unit_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_advance_recovered_finite_check"
	CHECK ("thirteenth_month_payouts"."advance_recovered" > '-Infinity'::numeric AND "thirteenth_month_payouts"."advance_recovered" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_basic_pay_earned_finite_check"
	CHECK ("thirteenth_month_payouts"."basic_pay_earned" > '-Infinity'::numeric AND "thirteenth_month_payouts"."basic_pay_earned" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_gross_pay_finite_check"
	CHECK ("thirteenth_month_payouts"."gross_pay" > '-Infinity'::numeric AND "thirteenth_month_payouts"."gross_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "thirteenth_month_payouts" ADD CONSTRAINT "thirteenth_month_payouts_net_pay_finite_check"
	CHECK ("thirteenth_month_payouts"."net_pay" > '-Infinity'::numeric AND "thirteenth_month_payouts"."net_pay" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "till_count_lines" ADD CONSTRAINT "till_count_lines_counted_finite_check"
	CHECK ("till_count_lines"."counted" > '-Infinity'::numeric AND "till_count_lines"."counted" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "till_count_lines" ADD CONSTRAINT "till_count_lines_expected_finite_check"
	CHECK ("till_count_lines"."expected" > '-Infinity'::numeric AND "till_count_lines"."expected" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_quantity_finite_check"
	CHECK ("trade_discrepancies"."quantity" > '-Infinity'::numeric AND "trade_discrepancies"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ADD CONSTRAINT "trade_discrepancies_value_finite_check"
	CHECK ("trade_discrepancies"."value" > '-Infinity'::numeric AND "trade_discrepancies"."value" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_dispatch_cost_finite_check"
	CHECK ("trade_order_lines"."dispatch_cost" > '-Infinity'::numeric AND "trade_order_lines"."dispatch_cost" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_fulfilled_quantity_finite_check"
	CHECK ("trade_order_lines"."fulfilled_quantity" > '-Infinity'::numeric AND "trade_order_lines"."fulfilled_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_line_total_finite_check"
	CHECK ("trade_order_lines"."line_total" > '-Infinity'::numeric AND "trade_order_lines"."line_total" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_quantity_finite_check"
	CHECK ("trade_order_lines"."quantity" > '-Infinity'::numeric AND "trade_order_lines"."quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_rate_finite_check"
	CHECK ("trade_order_lines"."rate" > '-Infinity'::numeric AND "trade_order_lines"."rate" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_received_quantity_finite_check"
	CHECK ("trade_order_lines"."received_quantity" > '-Infinity'::numeric AND "trade_order_lines"."received_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_requested_quantity_finite_check"
	CHECK ("trade_order_lines"."requested_quantity" > '-Infinity'::numeric AND "trade_order_lines"."requested_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_suggested_quantity_finite_check"
	CHECK ("trade_order_lines"."suggested_quantity" > '-Infinity'::numeric AND "trade_order_lines"."suggested_quantity" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_delivery_fee_finite_check"
	CHECK ("trade_orders"."delivery_fee" > '-Infinity'::numeric AND "trade_orders"."delivery_fee" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_other_fees_finite_check"
	CHECK ("trade_orders"."other_fees" > '-Infinity'::numeric AND "trade_orders"."other_fees" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_total_amount_finite_check"
	CHECK ("trade_orders"."total_amount" > '-Infinity'::numeric AND "trade_orders"."total_amount" < 'Infinity'::numeric);
