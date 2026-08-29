-- T-157b — the open-hour anchor, and overtime that is actually paid.
-- docs/tasks/157b-open-hour-anchor-and-overtime.md
--
-- Three columns. No new tables, so no classification or RLS registry change.
--
-- Hand-written per DEF-073. Lane B owns 0070-0089.

-- ---------------------------------------------------------------------------------------------
-- 1. How far a clock-in may be from an allowed hour and still count as aiming for it.
--
-- ⭐ Default 30, and on a FULL HOURLY grid it can never fire -- 30 is the mathematical maximum
-- distance when every hour is allowed, measured and confirmed across all 550 real August sessions
-- (0% beyond 30). It exists to catch a SPARSE or STALE grid, and there it is a signal: against
-- Lipa's stored [9,10,11,15,16,17,18] -- which has no 12, 13 or 14 though Ian's model says those
-- are allowed starts -- 42% of clock-ins land beyond it. The staff are not off-schedule; the
-- config is (DEF-087).
-- ---------------------------------------------------------------------------------------------

alter table "store_attendance_config"
  add column "anchor_window_minutes" integer not null default 30;--> statement-breakpoint

alter table "store_attendance_config"
  add constraint "store_attendance_config_anchor_window_check"
  check ("anchor_window_minutes" >= 0 and "anchor_window_minutes" <= 60);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Record the facts; do not destroy them.
--
-- ⛔ `late_minutes` was being stored with `late_grace_minutes` ALREADY SUBTRACTED, so Ian's
-- "5 mins late" recorded as 0 at Lipa, whose grace is exactly 5. A manager asking "was he late"
-- got the wrong answer, and Phase 5 could not apply a different policy to a number already
-- reduced. From here `late_minutes` is RAW and the graced figure is its own column.
-- ---------------------------------------------------------------------------------------------

alter table "attendance_days"
  add column "late_chargeable_minutes" integer not null default 0;--> statement-breakpoint

-- ⭐ Ian's "4 mins early out" had nowhere to live at all. It is recorded even when the day is
-- credited in full -- the fact that someone left early is worth knowing whether or not it cost
-- them anything.
alter table "attendance_days"
  add column "early_out_minutes" integer not null default 0;--> statement-breakpoint

alter table "attendance_days"
  add constraint "attendance_days_new_durations_non_negative_check"
  check ("late_chargeable_minutes" >= 0 and "early_out_minutes" >= 0);
