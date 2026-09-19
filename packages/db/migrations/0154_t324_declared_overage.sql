-- 0154 — T-324: `remittance_lines.declared_overage` — the release valve for cash a verified-day
-- cap cannot yet attribute. docs/tasks/324-cap-the-cash-handover.md §3.5, §5.
--
-- NULL means "never asked" (every row before this migration); 0.00 means "I declare no overage" —
-- packages/core/src/money.ts:15-16, a zero amount is a legitimate value, not "unset". Nothing
-- bounds the declaration's size: it converts a silent sweep into a deliberate act, and the
-- resulting positive variance lands in remittance_variances for the office to see. It is a speed
-- bump, not an approval gate (spec §3.5).
--
-- No new table, so no rls/registry.ts or cutover/classification.ts entry is required (ADR-012 §5
-- step 4). remittance_lines already carries RLS and keeps it unchanged.

ALTER TABLE "remittance_lines" ADD COLUMN "declared_overage" numeric(14, 2);--> statement-breakpoint

-- Mirrors `remittance_lines_amount_positive_check`'s shape: nullable, but never negative when set.
ALTER TABLE "remittance_lines" ADD CONSTRAINT "remittance_lines_declared_overage_check"
	CHECK ("remittance_lines"."declared_overage" IS NULL OR "remittance_lines"."declared_overage" >= 0);
