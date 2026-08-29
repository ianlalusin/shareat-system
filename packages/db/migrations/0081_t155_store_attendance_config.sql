-- T-155 — store_attendance_config: per-store attendance policy, EFFECTIVE-DATED.
-- docs/tasks/155-shift-day-and-attendance-config.md
--
-- Rows are IMMUTABLE once superseded. An attendance_days row (T-157) names the config row it was
-- computed under, so recomputing a March day in June yields March's answer -- which is how the
-- payslip guarantee (discovery 15 "Intent worth preserving" #6) and recompute-from-truth stop
-- being in tension. Editing a superseded row is a silently rewritten payslip; the trigger refuses.
--
-- Hand-written per DEF-073. Lane B owns 0070-0089.

-- ---------------------------------------------------------------------------------------------
-- ⚠️ Postgres forbids a SUBQUERY in a CHECK constraint, and the normalisation rule below needs one
-- (aggregate the array back sorted and distinct, and compare). An IMMUTABLE function is the
-- sanctioned way to express it declaratively -- the guarantee stays AT THE DATABASE BOUNDARY rather
-- than moving into a service that every future write path would have to remember to call.
-- ---------------------------------------------------------------------------------------------

create or replace function is_normalised_hour_set(hours integer[]) returns boolean as $$
  -- ⚠️ COALESCE both ends, and it is not defensive noise -- it closes a hole this constraint had
  -- when first written. `array_length('{}', 1)` is NULL, not 0, so `NULL between 1 and 24` is NULL,
  -- `true and NULL` is NULL, and **a CHECK constraint PASSES when its expression is NULL.** An
  -- EMPTY allowed-hours set was therefore accepted -- meaning no start hour is ever allowed, so
  -- every punch anchors as 'unallowed' and every day at that store reads as off-schedule. Silent,
  -- and exactly the failure class this project exists to eliminate. Caught by the test that
  -- asserted the refusal.
  select coalesce(
    coalesce(array_length(hours, 1), 0) between 1 and 24
      and hours <@ array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]
      and hours = (select array_agg(distinct h order by h) from unnest(hours) h),
    false
  );
$$ language sql immutable;--> statement-breakpoint

create table "store_attendance_config" (
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid not null references "stores"("id") on delete restrict,

  "effective_from" date not null,
  "superseded_at" timestamptz,

  -- Shift shape. Every default is v1's, from ERP-rebuild/src/types/attendance-config.ts.
  "required_hours_per_shift" numeric(4,2) not null default 9,
  "half_day_hours" numeric(4,2) not null default 5,
  "short_shift_half_day_ot" boolean not null default false,
  "allowed_shift_start_hours" integer[] not null default '{9,10,11,14,15,16,17,18}'::integer[],
  "time_mode" text not null default 'open',
  "half_day_on_missing_tap" boolean not null default false,
  "default_work_hours" numeric(4,2) not null default 8,
  "default_break_hours" numeric(4,2) not null default 1,

  -- Premiums.
  "night_diff_enabled" boolean not null default true,
  "night_diff_start_hour" integer not null default 22,
  "night_diff_end_hour" integer not null default 6,
  "night_diff_multiplier" numeric(4,2) not null default 1.10,
  "overtime_multiplier" numeric(4,2) not null default 1.25,

  -- Grace. All three default to 0 so shipping a fix never retroactively moves anyone's pay.
  "late_grace_minutes" integer not null default 0,
  "early_out_grace_minutes" integer not null default 0,
  "undertime_grace_minutes" integer not null default 0,

  -- Late policy. Three mutually exclusive modes; record_only by default, because a store must opt
  -- into charging money for lateness.
  "late_policy" text not null default 'record_only',
  "late_charge_per_minute" numeric(14,2) not null default 0,
  "late_infraction_points" integer not null default 1,

  -- Terminal. The four credential kill switches are bible 5.3 hot-set item 3 -- a NEW cache
  -- addition, not a port. Landmine 15: v1 does not cache these offline, so a terminal keeps
  -- accepting a method an admin just disabled and the rejection surfaces only as a dead letter.
  "break_enabled" boolean not null default true,
  "credential_passcode" boolean not null default true,
  "credential_nfc" boolean not null default true,
  "credential_fingerprint" boolean not null default true,
  "credential_face" boolean not null default true,

  "created_at" timestamptz not null default now(),
  "created_by" uuid references "persons"("id") on delete restrict,

  constraint "store_attendance_config_time_mode_check" check ("time_mode" in ('open','fixed')),
  constraint "store_attendance_config_late_policy_check"
    check ("late_policy" in ('record_only','charge_per_minute','infraction')),
  constraint "store_attendance_config_night_window_check"
    check ("night_diff_start_hour" between 0 and 23 and "night_diff_end_hour" between 0 and 23),

  -- A store that switched to charging and left the rate at zero has a policy that LOOKS enforced
  -- and costs nothing. Same failure mode as a credit limit that is stored, displayed and checked
  -- nowhere.
  constraint "store_attendance_config_charge_rate_check"
    check ("late_policy" <> 'charge_per_minute' or "late_charge_per_minute" > 0),

  constraint "store_attendance_config_half_day_below_required_check"
    check ("half_day_hours" < "required_hours_per_shift"),
  constraint "store_attendance_config_positive_hours_check"
    check ("required_hours_per_shift" > 0 and "half_day_hours" > 0),
  constraint "store_attendance_config_grace_non_negative_check"
    check ("late_grace_minutes" >= 0 and "early_out_grace_minutes" >= 0 and "undertime_grace_minutes" >= 0),

  -- The allowed-start-hours normalisation. Non-empty, every value a real hour, and stored SORTED
  -- AND DISTINCT so no reader anywhere has to defend against '{14,9,9}'. See the function above
  -- for why it is a function and not an inline expression.
  constraint "store_attendance_config_allowed_hours_check"
    check (is_normalised_hour_set("allowed_shift_start_hours"))
);--> statement-breakpoint

create index "store_attendance_config_store_id_idx" on "store_attendance_config" ("store_id");--> statement-breakpoint
create index "store_attendance_config_store_effective_idx"
  on "store_attendance_config" ("store_id", "effective_from");--> statement-breakpoint

-- Exactly one LIVE config per store.
create unique index "store_attendance_config_live_unique"
  on "store_attendance_config" ("store_id") where "superseded_at" is null;--> statement-breakpoint
create unique index "store_attendance_config_store_effective_unique"
  on "store_attendance_config" ("store_id", "effective_from");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Immutability. A superseded row is history; editing it rewrites a payslip that has already been
-- paid, silently. DELETE is refused always -- a config row with days pointing at it cannot go.
--
-- Modelled on journal_lines_posted_immutable (migration 0004). ⚠️ DEF-036's lesson applies: that
-- trigger checked only the states that existed when it was written and stopped guarding when a new
-- one appeared. This one takes no state argument for DELETE at all, and for UPDATE it allows
-- exactly ONE transition -- stamping superseded_at on a row that has not been stamped -- so a new
-- column added later is covered without anyone remembering to extend it.
-- ---------------------------------------------------------------------------------------------

create or replace function store_attendance_config_refuse_mutation() returns trigger as $$
declare
  probe store_attendance_config%rowtype;
begin
  if (tg_op = 'DELETE') then
    raise exception 'store_attendance_config is append-and-supersede: a config row is never deleted (row %)', old.id
      using errcode = 'restrict_violation';
  end if;

  -- The ONE legitimate update: stamping superseded_at on a row that has not been stamped, and
  -- changing nothing else. Rewinding superseded_at to null is refused too -- that would resurrect
  -- a retired policy over days already computed under its successor.
  --
  -- Written as "copy NEW, put OLD's superseded_at back, and compare whole rows" rather than as a
  -- list of columns: a column added to this table in a later migration is covered automatically.
  -- DEF-036's lesson -- a guard written against the columns that exist today stops guarding when a
  -- new one appears -- with no list to forget to extend.
  if (old.superseded_at is null and new.superseded_at is not null) then
    probe := new;
    probe.superseded_at := old.superseded_at;
    if (probe is not distinct from old) then
      return new;
    end if;
  end if;

  raise exception 'store_attendance_config rows are immutable — supersede with a new row instead of editing row %', old.id
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;--> statement-breakpoint

create trigger store_attendance_config_immutable
  before update or delete on "store_attendance_config"
  for each row execute function store_attendance_config_refuse_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "store_attendance_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_attendance_config" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "store_attendance_config_org_isolation" ON "store_attendance_config"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
