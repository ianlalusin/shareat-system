-- T-189d — the payout date, configured two ways.
-- Ian, 2026-08-31: "the payout date must be configurable also."
--
-- `payout_lag_days` (0108) answers "N days after the period ends", which is one of the two ways a
-- Philippine business actually sets payday. The other, and the more common one, is a FIXED DAY OF
-- THE MONTH — paid on the 10th and the 25th — which a lag cannot express: the gap between a period
-- end and a fixed payday is a different number of days every month.
--
-- ⭐ So a mode, the same shape `overtime_mode` uses:
--
--   lag         payout = period end + payout_lag_days
--   fixed_days  payout = the next occurrence of payout_days[period index], on or after the end
--
-- ⚠️ `payout_days` is an integer ARRAY, and that is the same reasoning `allowed_shift_start_hours`
-- already records: a set of small integers has no fields, no identity and no lifecycle, so a child
-- table would mint a uuid and a created_at in order to store the number 10. NOT a map-as-record.
--
-- Hand-written, per DEF-073. Never edited after apply.

ALTER TABLE "store_attendance_config"
  ADD COLUMN "payout_mode" text DEFAULT 'lag' NOT NULL;

-- One day-of-month per period, in period order: semi-monthly takes two, monthly one, weekly up to
-- five. ⚠️ Shorter than the period count is legal — the LAST entry then applies to the rest, which
-- is what a store paying every week on a Friday actually means.
ALTER TABLE "store_attendance_config"
  ADD COLUMN "payout_days" integer[] DEFAULT '{}'::integer[] NOT NULL;

ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_payout_mode_check"
  CHECK ("payout_mode" in ('lag', 'fixed_days'));

-- ⛔ The dangerous combination is unrepresentable, as with fixed overtime: a store that says it
-- pays on fixed days MUST say which. Otherwise payday would silently fall back to the period end.
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_fixed_days_needed_check"
  CHECK ("payout_mode" = 'lag' OR cardinality("payout_days") > 0);

-- ⚠️ 1..31 per entry. A 31 in a 30-day month is CLAMPED to the month end when the date is derived,
-- rather than refused here — "pay on the last day" is a real instruction and 31 is how people
-- write it.
-- ⚠️ `ALL`, not `<@ ARRAY(SELECT generate_series(...))` — a CHECK constraint may not contain a
-- SUBQUERY, and Postgres refuses the whole migration with "cannot use subquery in check
-- constraint". An empty array satisfies both quantifiers, which is correct: empty is legal in
-- `lag` mode and already refused in `fixed_days` mode by the constraint above.
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_payout_days_range_check"
  CHECK (1 <= ALL("payout_days") AND 31 >= ALL("payout_days"));
