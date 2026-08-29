-- T-156 — attendance_punches: the append-only raw fact.
-- docs/tasks/156-attendance-punches.md
--
-- Bible 5.1 (Lane B): "Events record RAW FACTS ONLY... They never carry a computed business
-- outcome (late/OT/hours/pay). Postgres adjudicates, always."
-- Bible 4.2 rule 9 names this table: "Append-only where the audit trail matters -- ledger entries,
-- stock movements, attendance punches. Correction = compensating entry, never UPDATE."
--
-- Hand-written per DEF-073. Lane B owns 0070-0089.

create table "attendance_punches" (
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid not null references "stores"("id") on delete restrict,
  "person_id" uuid not null references "persons"("id") on delete restrict,
  "employment_id" uuid not null references "employments"("id") on delete restrict,

  -- The idempotency key, and it is a UNIQUE constraint rather than a timer (bible 4.2 rule 10:
  -- "This replaces debounce/throttle guesswork"). Also the Firestore inbox document id.
  "client_punch_id" text not null,

  "occurred_at" timestamptz not null,
  -- Computed on write. Bible 6: "the row has an explicit business_date computed on write -- never
  -- re-derived per query at read time". This is the 05:00 SHIFT day, not the midnight business day.
  "shift_day" date not null,

  "method" text not null,
  -- The device ASSERTS; the server ADJUDICATES. See the schema file -- bible 5.1's own example of a
  -- raw fact carries no intent at all, and an offline terminal cannot know the direction reliably.
  "asserted_intent" text not null,

  "device_id" text,
  "source" text not null,
  -- The VERIFIED actor, from resolveActor (T-138). v1 takes this as a client-supplied parameter,
  -- which is landmine 17.
  "captured_by_session_id" uuid references "sessions"("id") on delete restrict,

  -- receivedAt - occurredAt IS the offline lag, and the only honest measure of it.
  "received_at" timestamptz not null default now(),

  "supersedes_punch_id" uuid references "attendance_punches"("id") on delete restrict,
  "void_reason" text,

  "created_at" timestamptz not null default now(),
  "created_by" uuid references "persons"("id") on delete restrict,

  constraint "attendance_punches_method_check"
    check ("method" in ('pin','nfc','qr','fingerprint','face','manual')),
  constraint "attendance_punches_intent_check"
    check ("asserted_intent" in ('in','out','break_start','break_end')),
  constraint "attendance_punches_source_check"
    check ("source" in ('online','offline_replay','manual_entry','import')),

  -- A punch from the FUTURE is refused. Five minutes is ordinary clock skew; an hour is a broken
  -- device, and accepting it would let a terminal book tomorrow's shift.
  --
  -- ⚠️ Note what is deliberately ABSENT: any upper bound on how OLD a punch may be. v1 rejects
  -- anything past 72h and dead-letters it (landmine 14) -- and because the event lived in a private
  -- IndexedDB it was then unreachable, with no recovery UI anywhere. In v2 the event lives in
  -- Firestore, so 72h becomes an adjudication FLAG rather than a data-loss cliff.
  constraint "attendance_punches_not_future_check"
    check ("occurred_at" <= "received_at" + interval '5 minutes'),

  -- Both or neither. A void reason with nothing voided explains a correction that never happened.
  constraint "attendance_punches_correction_pair_check"
    check (("supersedes_punch_id" is null) = ("void_reason" is null)),
  constraint "attendance_punches_no_self_supersede_check"
    check ("supersedes_punch_id" is null or "supersedes_punch_id" <> "id")
);--> statement-breakpoint

-- The dedupe. Everything else about replay safety follows from this one index.
create unique index "attendance_punches_client_punch_id_unique"
  on "attendance_punches" ("client_punch_id");--> statement-breakpoint

create index "attendance_punches_store_shift_day_idx"
  on "attendance_punches" ("store_id", "shift_day");--> statement-breakpoint
create index "attendance_punches_employment_occurred_idx"
  on "attendance_punches" ("employment_id", "occurred_at");--> statement-breakpoint
-- The ingest-lag monitor: an event that arrived long after it happened is alertable.
create index "attendance_punches_store_received_idx"
  on "attendance_punches" ("store_id", "received_at");--> statement-breakpoint

-- One correction per punch. A chain corrects the correction, and stays readable.
create unique index "attendance_punches_supersedes_unique"
  on "attendance_punches" ("supersedes_punch_id") where "supersedes_punch_id" is not null;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Cross-row validation, at INSERT. A CHECK cannot see another row, and these two rules are both
-- about agreement BETWEEN rows.
-- ---------------------------------------------------------------------------------------------

create or replace function attendance_punches_validate_insert() returns trigger as $$
declare
  emp record;
  target record;
begin
  select store_id, org_id, person_id into emp from employments where id = new.employment_id;

  -- A punch filed against an employment at another store is a punch attributed to the wrong job.
  -- The FK proves the employment EXISTS; only this proves it is the right one.
  if (emp.store_id <> new.store_id) then
    raise exception 'punch store % does not match employment % (store %)',
      new.store_id, new.employment_id, emp.store_id
      using errcode = 'check_violation';
  end if;
  if (emp.org_id <> new.org_id) then
    raise exception 'punch org % does not match employment % (org %)', new.org_id, new.employment_id, emp.org_id
      using errcode = 'check_violation';
  end if;
  if (emp.person_id <> new.person_id) then
    raise exception 'punch person % is not the person employed under % (person %)',
      new.person_id, new.employment_id, emp.person_id
      using errcode = 'check_violation';
  end if;

  -- A correction corrects a punch of the SAME employment. Correcting across employments would
  -- silently move a punch between two jobs, which is precisely what a correction must never do.
  if (new.supersedes_punch_id is not null) then
    select employment_id into target from attendance_punches where id = new.supersedes_punch_id;
    if (target.employment_id <> new.employment_id) then
      raise exception 'a correction must belong to the same employment as the punch it supersedes'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;--> statement-breakpoint

create trigger attendance_punches_validate
  before insert on "attendance_punches"
  for each row execute function attendance_punches_validate_insert();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Append-only. Modelled on journal_lines_posted_immutable (migration 0004).
--
-- ⚠️ DEF-036's lesson, applied structurally: that trigger checked `entry_status = 'posted'` only,
-- so it stopped guarding the moment a 'reversed' status appeared. This one takes NO state argument
-- at all -- every UPDATE and every DELETE is refused unconditionally -- so there is no state for a
-- future column or status to slip past.
-- ---------------------------------------------------------------------------------------------

create or replace function attendance_punches_refuse_mutation() returns trigger as $$
begin
  raise exception 'attendance_punches is append-only (bible 4.2 rule 9): % on punch % is refused. A correction is a NEW punch with supersedes_punch_id set.',
    tg_op, coalesce(old.id::text, '?')
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;--> statement-breakpoint

create trigger attendance_punches_append_only
  before update or delete on "attendance_punches"
  for each row execute function attendance_punches_refuse_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "attendance_punches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_punches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attendance_punches_org_isolation" ON "attendance_punches"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
