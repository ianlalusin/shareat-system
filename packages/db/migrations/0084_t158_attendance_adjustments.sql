-- T-158 — attendance_adjustments: the manager's decisions as attributed inputs.
-- docs/tasks/158-attendance-adjustments.md
--
-- v1 writes these decisions ONTO the session document beside the hours they modify, with a comment
-- insisting they never touch the computed fields. As rows they become inputs to T-157's engine
-- instead, which is what makes recompute-from-truth possible, attribution verifiable, and a
-- reversal a row rather than an erasure.
--
-- Hand-written per DEF-073. Lane B owns 0070-0089.

create table "attendance_adjustments" (
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid not null references "stores"("id") on delete restrict,
  "employment_id" uuid not null references "employments"("id") on delete restrict,

  "shift_day" date not null,
  "kind" text not null,

  "chosen_anchor_minute" integer,
  "effective_out_minute" integer,
  "is_half_day" text,

  "reason" text,

  -- ⛔ From resolveActor, NEVER a parameter (bible 7.1). Without a verified session, "who approved
  -- this" is a value the caller chose -- which is exactly landmine 17.
  "decided_by_session_id" uuid not null references "sessions"("id") on delete restrict,
  -- Denormalised on purpose: it is WHO DECIDED, and must not move if the session is later revoked.
  "decided_by_person_id" uuid not null references "persons"("id") on delete restrict,

  -- ⚠️ DEFERRABLE INITIALLY DEFERRED, and it is required rather than cautious.
  -- attendance_adjustments_live_unique is a plain (non-deferrable) partial unique index, so two
  -- live decisions of one kind are illegal even for a single statement -- which means the OLD row
  -- must be stamped as superseded BEFORE the new one is inserted. That stamp necessarily points at
  -- a row that does not exist yet, so the FK has to be checked at COMMIT rather than per statement.
  -- Both constraints then hold at every point an outside observer can see.
  "superseded_by_adjustment_id" uuid references "attendance_adjustments"("id") on delete restrict
    deferrable initially deferred,

  "created_at" timestamptz not null default now(),

  constraint "attendance_adjustments_kind_check"
    check ("kind" in ('start_anchor','early_out_approved','half_day_override','verify','void')),
  constraint "attendance_adjustments_reason_required_check"
    check ("kind" not in ('void','half_day_override') or "reason" is not null),

  -- Each kind's payload shape, held by the database rather than hoped for in a service.
  constraint "attendance_adjustments_payload_shape_check" check (
    ("kind" = 'start_anchor' and "chosen_anchor_minute" is not null
       and "effective_out_minute" is null and "is_half_day" is null)
    or ("kind" = 'early_out_approved' and "effective_out_minute" is not null
       and "chosen_anchor_minute" is null and "is_half_day" is null)
    or ("kind" = 'half_day_override' and "is_half_day" in ('true','false')
       and "chosen_anchor_minute" is null and "effective_out_minute" is null)
    or ("kind" in ('verify','void') and "chosen_anchor_minute" is null
       and "effective_out_minute" is null and "is_half_day" is null)
  ),
  constraint "attendance_adjustments_no_self_supersede_check"
    check ("superseded_by_adjustment_id" is null or "superseded_by_adjustment_id" <> "id")
);--> statement-breakpoint

-- ONE live decision of each kind per day. A change supersedes; it never duplicates.
create unique index "attendance_adjustments_live_unique"
  on "attendance_adjustments" ("employment_id", "shift_day", "kind")
  where "superseded_by_adjustment_id" is null;--> statement-breakpoint

create index "attendance_adjustments_employment_day_idx"
  on "attendance_adjustments" ("employment_id", "shift_day");--> statement-breakpoint
create index "attendance_adjustments_store_day_idx"
  on "attendance_adjustments" ("store_id", "shift_day");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Append-only, with ONE permitted transition: stamping superseded_by on a row that has not been
-- stamped. Same shape and same reasoning as store_attendance_config's guard -- compare whole rows
-- rather than listing columns, so a column added later is covered without anyone remembering.
-- ---------------------------------------------------------------------------------------------

create or replace function attendance_adjustments_refuse_mutation() returns trigger as $$
declare
  probe attendance_adjustments%rowtype;
begin
  if (tg_op = 'DELETE') then
    raise exception 'attendance_adjustments is append-and-supersede: a decision is never deleted (row %). Supersede it.', old.id
      using errcode = 'restrict_violation';
  end if;

  if (old.superseded_by_adjustment_id is null and new.superseded_by_adjustment_id is not null) then
    probe := new;
    probe.superseded_by_adjustment_id := old.superseded_by_adjustment_id;
    if (probe is not distinct from old) then
      return new;
    end if;
  end if;

  raise exception 'attendance_adjustments rows are immutable — supersede with a new decision instead of editing row %', old.id
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;--> statement-breakpoint

create trigger attendance_adjustments_append_only
  before update or delete on "attendance_adjustments"
  for each row execute function attendance_adjustments_refuse_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- A decision belongs to the employment's own store. Cross-row, so a CHECK cannot see it.
-- ---------------------------------------------------------------------------------------------

create or replace function attendance_adjustments_validate_insert() returns trigger as $$
declare
  emp record;
begin
  select store_id, org_id into emp from employments where id = new.employment_id;
  if (emp.store_id <> new.store_id or emp.org_id <> new.org_id) then
    raise exception 'adjustment store/org does not match employment %', new.employment_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;--> statement-breakpoint

create trigger attendance_adjustments_validate
  before insert on "attendance_adjustments"
  for each row execute function attendance_adjustments_validate_insert();--> statement-breakpoint

ALTER TABLE "attendance_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_adjustments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attendance_adjustments_org_isolation" ON "attendance_adjustments"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
