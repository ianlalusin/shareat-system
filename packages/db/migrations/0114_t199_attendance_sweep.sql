-- T-199 — the missed clock-out sweep, and the alarm that notices it stopped. Closes DEF-119.
--
-- ⭐ TWO RULES PRODUCE THE SAME SITUATION AND MUST PRODUCE THE SAME RECORD (v1's
-- `auto-clock-out.ts`, read at source):
--   · `auto_clock_out_hour` — a wall-clock hour at which every still-open day is cleared, "so the
--     floor is empty before the store opens". Live at all three v1 stores: 02:00.
--   · `max_shift_hours`     — the per-day backstop: open longer than the cap was clearly forgotten.
--
-- ⛔ `auto_clock_out_hour` IS NULLABLE AND DEFAULTS TO NULL — "this store never auto-clears" is the
-- state every store is in today, and DEF-087's lesson is that an unset value must never masquerade
-- as a chosen one. ⚠️ v1 guards `Number('') === 0` in TypeScript because a blank config value would
-- silently mean "clear at MIDNIGHT" — the one hour a floor is most likely to still have people on
-- it, at a store that never opted in. Here the type system and the CHECK do that work instead: a
-- blank cannot become a 0, because the column is an integer and null is a distinct state.

alter table "store_attendance_config"
  add column "auto_clock_out_hour" integer,
  add column "max_shift_hours" integer not null default 16;--> statement-breakpoint

alter table "store_attendance_config"
  add constraint "store_attendance_config_auto_clock_out_hour_check"
  check ("auto_clock_out_hour" is null or ("auto_clock_out_hour" between 0 and 23));--> statement-breakpoint

-- ⚠️ A cap below the required shift would close every shift the moment it started. The floor is
-- generous rather than exact: this is a BACKSTOP for a forgotten tap, not a second policy on hours.
alter table "store_attendance_config"
  add constraint "store_attendance_config_max_shift_hours_check"
  check ("max_shift_hours" between 10 and 24);--> statement-breakpoint

-- The sweep joins depreciation and amortisation on T-140's scheduler.
alter table "scheduler_runs" drop constraint "scheduler_runs_job_check";--> statement-breakpoint
alter table "scheduler_runs"
  add constraint "scheduler_runs_job_check"
  check ("job" in ('depreciation', 'amortisation', 'attendance_sweep'));
