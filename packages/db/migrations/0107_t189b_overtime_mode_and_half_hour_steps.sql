-- T-189b — overtime priced two ways, and hours in half-hour steps.
-- Ian, 2026-08-31: "for OT it must be configurable to x1.25 or fix amount, and time must be
-- computed by .5 escalation so hours are .5, 1, 1.5, 2 like that, no hanging minutes except for
-- computation of late."
--
-- Two changes, and only the first needs schema.
--
-- 1. OVERTIME PRICE. Until now the only way to price an OT hour was a multiplier on the hourly
--    equivalent of the daily rate. A store may now instead pay a FLAT amount per overtime hour —
--    which is what "or fix amount" means, and it REPLACES the rate rather than multiplying it.
--
-- 2. HALF-HOUR STEPS live in `packages/domain/src/payroll/compute.ts`, not here: they are a rule
--    about how minutes become hours, not a thing a row stores.
--
-- Hand-written, per DEF-073. Never edited after apply.

ALTER TABLE "store_attendance_config"
  ADD COLUMN "overtime_mode" text DEFAULT 'multiplier' NOT NULL;

-- Pesos per overtime HOUR. Null unless the store prices OT at a flat amount.
ALTER TABLE "store_attendance_config"
  ADD COLUMN "overtime_fixed_hourly" numeric(14, 2);

ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_overtime_mode_check"
  CHECK ("overtime_mode" in ('multiplier', 'fixed'));

-- ⭐ The dangerous combination is unrepresentable, the same shape T-152 used for the un-remitted
-- ceiling: a store that says it pays a fixed amount MUST say what the amount is. Without this a
-- store could switch to 'fixed' and every overtime hour would silently price at zero — no error,
-- no visual difference, and the staff who worked those hours paid nothing for them.
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_fixed_ot_needs_amount_check"
  CHECK ("overtime_mode" = 'multiplier' OR "overtime_fixed_hourly" IS NOT NULL);

ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_fixed_ot_positive_check"
  CHECK ("overtime_fixed_hourly" IS NULL OR "overtime_fixed_hourly" > 0);

-- ---------------------------------------------------------------------------------------------
-- 3. HOLIDAY PREMIUM, per holiday TYPE.
-- Ian, 2026-08-31: "holiday must be configurable too. 1.3, 1.5, 2."
--
-- ⭐ Three columns rather than one, because `attendance_days.holiday_type` ALREADY records which
-- kind of holiday a day was — 'regular', 'special_non_working', 'special_working' — and a single
-- configurable number would throw that away and price a regular holiday the same as a special one.
-- v1 hardcodes 2.0 / 1.3 and has no third at all.
--
-- Defaults follow Philippine practice and Ian's three figures: a regular holiday at 200%, a special
-- non-working day at 130%, and a special working day at 150%. ⚠️ Every one is now a setting, so a
-- store that pays differently changes a row rather than a constant.
ALTER TABLE "store_attendance_config"
  ADD COLUMN "holiday_regular_multiplier" numeric(4, 2) DEFAULT '2.00' NOT NULL;
ALTER TABLE "store_attendance_config"
  ADD COLUMN "holiday_special_non_working_multiplier" numeric(4, 2) DEFAULT '1.30' NOT NULL;
ALTER TABLE "store_attendance_config"
  ADD COLUMN "holiday_special_working_multiplier" numeric(4, 2) DEFAULT '1.50' NOT NULL;

-- ⛔ A multiplier below 1 would make working a holiday pay LESS than an ordinary day. The premium
-- is an add-on (`× multiplier − 1`), so anything under 1 turns it into a deduction.
ALTER TABLE "store_attendance_config" ADD CONSTRAINT "store_attendance_config_holiday_multipliers_check"
  CHECK ("holiday_regular_multiplier" >= 1
     AND "holiday_special_non_working_multiplier" >= 1
     AND "holiday_special_working_multiplier" >= 1);
