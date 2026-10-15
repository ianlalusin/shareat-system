-- 0198 - T-401 S6: the usage tolerance band and the usage auto-post flag. docs/tasks/401-erp-menu-catalog-master.md "S5 rulings" point 7 (I28) and
-- Ian's ruling of 2026-10-14 (bible row 335).
--
-- WHAT. Three columns, no new table:
--   organizations.usage_tolerance  numeric(5,4) NOT NULL DEFAULT 0.1000  - the org-wide band, a fraction (0.10 = 10%).
--   items.usage_tolerance          numeric(5,4) NULL                      - a per-item override; NULL means "use the org setting".
--   stock_usage_records.auto_posted boolean NOT NULL DEFAULT false      - true when the system (not a manager) posted the record
--                                                                         at 14:00 Manila the day after its business date (Ian, 15 Oct).
-- Both tolerances are checked to lie in [0, 1], and carry the repo-wide `*_finite_check` of the real form (T-371 G4).
--
-- WHY. A manager-posted staff usage draft is the actual usage that moves stock; the POS pull finalizes into a usage DRAFT at expected (no stock moves) and is the expectation the drafts are checked against. The check is
-- "actual within tolerance x expected" per (store, day, item), and the tolerance is the item's own override, else the org's.
-- No backfill: every existing org reads the default 10%, no item has an override.
--
-- GRANTS / RLS. No new table, so no policy or grant change: `organizations` and `items` keep the policies and the UPDATE grant
-- the app already uses (setIdentity, setItemPurchaseUnit). The setters are admin-only (`set_menu_depletion`) in the domain.
ALTER TABLE "organizations" ADD COLUMN "usage_tolerance" numeric(5,4) DEFAULT 0.1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_usage_tolerance_check" CHECK ("usage_tolerance" >= 0 AND "usage_tolerance" <= 1);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_usage_tolerance_finite_check" CHECK ("usage_tolerance" > '-Infinity'::numeric AND "usage_tolerance" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "usage_tolerance" numeric(5,4);--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_usage_tolerance_check" CHECK ("usage_tolerance" IS NULL OR ("usage_tolerance" >= 0 AND "usage_tolerance" <= 1));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_usage_tolerance_finite_check" CHECK ("usage_tolerance" > '-Infinity'::numeric AND "usage_tolerance" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD COLUMN "auto_posted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD CONSTRAINT "stock_usage_auto_posted_shape_check" CHECK ("auto_posted" = false OR "posted_at" IS NOT NULL);--> statement-breakpoint
-- Audit rulings A4 / A7 (Ian, 15 Oct; docs/tasks/401-erp-menu-catalog-master.md "S6 audit rulings").
--   stock_usage_lines.expected_qty            numeric(14,3) NULL - the expectation the POS pull wrote this line with (its SNAPSHOT); null for a
--                                                                  line staff added by hand. Never recomputed.
--   pos_usage_pull_lines.draft_expected_qty   numeric(14,3) NULL - the same snapshot kept per (draft, item) on the pull's own lines, so it
--                                                                  survives staff removing and re-typing a line (T-168 has no edit-quantity
--                                                                  call). The band at post time and at month close reads THIS, summed per item.
--   stock_usage_records.pull_voided           boolean NOT NULL DEFAULT false - set when a pull was voided after staff edited its draft: the draft
--                                                                  is kept as a manual draft (never auto-posts) and the queue flags it.
ALTER TABLE "stock_usage_lines" ADD COLUMN "expected_qty" numeric(14,3);--> statement-breakpoint
ALTER TABLE "stock_usage_lines" ADD CONSTRAINT "stock_usage_lines_expected_qty_check" CHECK ("expected_qty" IS NULL OR "expected_qty" >= 0);--> statement-breakpoint
ALTER TABLE "stock_usage_lines" ADD CONSTRAINT "stock_usage_lines_expected_qty_finite_check" CHECK ("expected_qty" > '-Infinity'::numeric AND "expected_qty" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" ADD COLUMN "draft_expected_qty" numeric(14,3);--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" ADD CONSTRAINT "pos_usage_pull_lines_draft_expected_qty_check" CHECK ("draft_expected_qty" IS NULL OR "draft_expected_qty" >= 0);--> statement-breakpoint
ALTER TABLE "pos_usage_pull_lines" ADD CONSTRAINT "pos_usage_pull_lines_draft_expected_qty_finite_check" CHECK ("draft_expected_qty" > '-Infinity'::numeric AND "draft_expected_qty" < 'Infinity'::numeric);--> statement-breakpoint
ALTER TABLE "stock_usage_records" ADD COLUMN "pull_voided" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Audit ruling A1: a scheduled job's script run by hand (`--manual`) writes audit source 'manual' (the timer's run writes 'cron').
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_source_check";--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_source_check" CHECK ("source" IN ('web', 'pos', 'customer', 'website', 'apk', 'kiosk', 'cron', 'ingestor', 'etl', 'manual'));--> statement-breakpoint
-- Audit ruling A1: the usage auto-post is a scheduler job (it writes a scheduler_runs row). Hand-authored per ADR-012 section 5; the list below
-- is every job SCHEDULER_JOBS names (0157's list plus usage_auto_post).
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";--> statement-breakpoint
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay',
	                 'order_wastage_backstop', 'finding_observation', 'budget_reissue', 'recurring_expenses',
	                 'orphan_file_sweep', 'fiscal_period_seed', 'usage_auto_post'));
