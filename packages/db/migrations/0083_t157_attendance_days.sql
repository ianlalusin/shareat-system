-- T-157 — attendance_days: the adjudicated day.
-- docs/tasks/157-attendance-adjudication.md
--
-- The third of three tables, and the split is the point. v1 carries the raw taps, the computation
-- and the manager's overlay in ONE document, held apart only by a comment. Here the fact
-- (attendance_punches) is append-only, the decision (attendance_adjustments, T-158) is
-- append-and-supersede, and this is DERIVED -- recomputable, then frozen when payroll consumes it.
--
-- Hand-written per DEF-073. Lane B owns 0070-0089.

create table "attendance_days" (
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid not null references "stores"("id") on delete restrict,
  "person_id" uuid not null references "persons"("id") on delete restrict,
  "employment_id" uuid not null references "employments"("id") on delete restrict,

  "shift_day" date not null,

  -- ⭐ The historical-integrity link. A day names the config row it was computed under, so
  -- re-deriving a March day in June yields March's answer. Discovery 15's payslip guarantee stops
  -- being a promise about restraint and becomes a foreign key.
  "attendance_config_id" uuid not null references "store_attendance_config"("id") on delete restrict,

  -- The evidence, referenced rather than copied.
  "first_in_punch_id" uuid references "attendance_punches"("id") on delete restrict,
  "last_out_punch_id" uuid references "attendance_punches"("id") on delete restrict,

  "anchor_minute" integer,
  "anchor_mode" text not null,
  "end_minute" integer,

  "computed_minutes" integer not null default 0,
  "is_half_day" boolean not null default false,
  "capped_at_required" boolean not null default false,
  "late_minutes" integer not null default 0,
  "undertime_forgiven_minutes" integer not null default 0,

  "break_minutes" integer not null default 0,
  "allowable_break_minutes" integer not null default 0,
  "break_over_minutes" integer not null default 0,

  "night_diff_minutes" integer not null default 0,

  "is_holiday" boolean not null default false,
  "holiday_type" text,
  "holiday_minutes" integer not null default 0,

  -- Recorded, never paid here. The approval gate is Phase 5.
  "pending_ot_minutes" integer not null default 0,

  "status" text not null,
  "anomalies" text[] not null default '{}'::text[],
  "explain" text[] not null default '{}'::text[],

  "computed_at" timestamptz not null default now(),
  "computed_from_punch_count" integer not null default 0,

  -- Phase 5 sets these. The FK to a pay run is deliberately absent until that table exists.
  "frozen_at" timestamptz,
  "frozen_by_pay_run_id" uuid,

  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz,

  constraint "attendance_days_status_check"
    check ("status" in ('open','computed','needs_review','verified','voided')),
  constraint "attendance_days_anchor_mode_check"
    check ("anchor_mode" in ('exact','previous','next','unallowed')),
  constraint "attendance_days_holiday_type_check"
    check ("holiday_type" is null or "holiday_type" in ('regular','special_non_working','special_working')),

  -- Every duration is non-negative. A negative paid minute is not a small error.
  constraint "attendance_days_non_negative_check" check (
    "computed_minutes" >= 0 and "late_minutes" >= 0 and "break_minutes" >= 0
    and "break_over_minutes" >= 0 and "night_diff_minutes" >= 0 and "pending_ot_minutes" >= 0
    and "undertime_forgiven_minutes" >= 0 and "holiday_minutes" >= 0
  ),
  constraint "attendance_days_frozen_pair_check"
    check (("frozen_at" is null) = ("frozen_by_pay_run_id" is null)),
  constraint "attendance_days_holiday_pair_check"
    check ("is_holiday" or "holiday_type" is null)
);--> statement-breakpoint

-- One row per person per shift day.
create unique index "attendance_days_employment_shift_day_unique"
  on "attendance_days" ("employment_id", "shift_day");--> statement-breakpoint
create index "attendance_days_store_shift_day_idx" on "attendance_days" ("store_id", "shift_day");--> statement-breakpoint
create index "attendance_days_status_idx" on "attendance_days" ("store_id", "status");--> statement-breakpoint
create index "attendance_days_config_idx" on "attendance_days" ("attendance_config_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⛔ A FROZEN day is never recomputed.
--
-- Discovery 15 "Intent worth preserving" #6 -- the payslip guarantee -- enforced by a trigger
-- rather than by the service remembering to check. Once a pay run has consumed a day, a late
-- punch, a corrected anchor or a bug fix must not silently restate what was paid; the correction
-- goes through payroll, where somebody is accountable for it.
--
-- ⭐ Unfreezing is refused too. A frozen day that can be quietly unfrozen is not frozen.
-- ---------------------------------------------------------------------------------------------

create or replace function attendance_days_refuse_frozen_update() returns trigger as $$
begin
  if (tg_op = 'DELETE') then
    if (old.frozen_at is not null) then
      raise exception 'attendance day % is frozen by pay run % and cannot be deleted',
        old.id, old.frozen_by_pay_run_id using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if (old.frozen_at is not null) then
    raise exception 'attendance day % is frozen by pay run % — recomputation is refused. Correct it through payroll, not by restating the day.',
      old.id, old.frozen_by_pay_run_id using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$ language plpgsql;--> statement-breakpoint

create trigger attendance_days_frozen_immutable
  before update or delete on "attendance_days"
  for each row execute function attendance_days_refuse_frozen_update();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "attendance_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_days" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attendance_days_org_isolation" ON "attendance_days"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
