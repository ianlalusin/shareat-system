-- T-189c — payroll periods, configured rather than assumed.
-- Ian, 2026-08-31: "look how payroll dates are configured in v1, it must be configurable."
--
-- v1's shape, read at source (`src/lib/payroll/compute.ts` `derivePeriods`, `PayrollConfig`):
--
--   periodType          'monthly' | 'semi_monthly' | 'weekly'   default semi_monthly
--   semiMonthlyCutoffs  [number, number]                        e.g. [15, 31]
--   payoutLagDays       number
--
-- ⚠️ ONE cutoff day here, not two. v1 stores a PAIR and `derivePeriods` only ever reads
-- `cutoffs[0]` — the second period always runs to the last day of the month, computed, never read
-- from the config. The second element is dead weight that can disagree with reality (a stored 31
-- in February), so v2 stores the one number that is actually used.
--
-- ⭐ These live on `store_attendance_config` rather than in a table of their own, and deliberately:
-- v2 already keeps `overtime_multiplier` and `night_diff_multiplier` there, so that row is in
-- practice "this store's shift and pay settings". A SECOND effective-dated per-store config table
-- would have to be superseded in lockstep with this one, and two rows that must move together are
-- two rows that will eventually disagree.
--
-- Hand-written, per DEF-073. Never edited after apply.

ALTER TABLE "store_attendance_config"
  ADD COLUMN "payroll_period_type" text DEFAULT 'semi_monthly' NOT NULL;

-- The day the FIRST semi-monthly period ends. The second runs from the next day to month end,
-- which is why only one number is stored.
ALTER TABLE "store_attendance_config"
  ADD COLUMN "semi_monthly_cutoff_day" integer DEFAULT 15 NOT NULL;

-- Days after a period ends before the money is actually handed over. v1's `payoutLagDays`.
ALTER TABLE "store_attendance_config"
  ADD COLUMN "payout_lag_days" integer DEFAULT 0 NOT NULL;

ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_period_type_check"
  CHECK ("payroll_period_type" in ('monthly', 'semi_monthly', 'weekly'));

-- ⛔ 1..27, not 1..31. A cutoff of 28 or later would make February's second period empty or
-- inverted — and 27 is the last day that leaves a real second period in every month of every year.
-- v1 clamps this at read time instead, which means a store can HOLD a value that its own code
-- silently ignores; here the bad value cannot be stored at all.
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_cutoff_day_check"
  CHECK ("semi_monthly_cutoff_day" between 1 and 27);

ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_payout_lag_check"
  CHECK ("payout_lag_days" between 0 and 31);
