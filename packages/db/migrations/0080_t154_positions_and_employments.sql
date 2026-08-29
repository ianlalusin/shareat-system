-- T-154 — positions, employments, employment_positions: the staff master record.
-- docs/tasks/154-positions-and-employments.md · docs/plans/phase-4-attendance.md §2
--
-- Hand-written per DEF-073: `db:generate`'s snapshot chain has been dead since 0019 and would
-- propose re-creating seventeen migrations' worth of schema. Hand-writing is the convention here.
--
-- Lane B owns migrations 0070-0089. 0061-0069 are left for the accounting lane.

-- ---------------------------------------------------------------------------------------------
-- positions — the taxonomy. Canonical rows (store_id IS NULL) and store-defined extras.
-- ---------------------------------------------------------------------------------------------

create table "positions" (
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid references "stores"("id") on delete restrict,
  "name" text not null,
  "is_canonical" boolean not null default false,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz,
  "created_by" uuid references "persons"("id") on delete restrict,

  -- Canonical and org-wide are the same fact stated twice; hold the row to it.
  constraint "positions_canonical_is_org_wide_check" check ("is_canonical" = ("store_id" is null))
);--> statement-breakpoint

create index "positions_org_id_idx" on "positions" ("org_id");--> statement-breakpoint
create index "positions_store_id_idx" on "positions" ("store_id");--> statement-breakpoint

-- The identity-defining rule, as an expression index Drizzle's builder cannot express.
-- COALESCE to the nil uuid so every canonical row for an org lands in ONE uniqueness group;
-- without it, NULL store_id would make each canonical row distinct from every other and a
-- duplicate 'Cashier' could be seeded twice.
create unique index "positions_org_scope_name_unique"
  on "positions" ("org_id", coalesce("store_id", '00000000-0000-0000-0000-000000000000'::uuid), lower(trim("name")));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- employments — a person holds a job at a store.
-- ---------------------------------------------------------------------------------------------

create table "employments" (
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid not null references "stores"("id") on delete restrict,
  "person_id" uuid not null references "persons"("id") on delete restrict,
  "staff_code" text not null,
  "employment_status" text not null,
  "started_on" date not null,
  "ended_on" date,
  "notes" text,
  "photo_file_id" uuid references "stored_files"("id") on delete restrict,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz,
  "created_by" uuid references "persons"("id") on delete restrict,

  constraint "employments_status_check" check (
    "employment_status" in ('regular','probationary','contractual','part-time','resigned','terminated','inactive')
  ),
  constraint "employments_dates_ordered_check" check ("ended_on" is null or "ended_on" >= "started_on"),

  -- A terminated employment with no end date, and an end date with a live status, are BOTH
  -- unrepresentable. An equality, not two implications, so neither direction can be forgotten.
  constraint "employments_ended_status_pair_check" check (
    ("employment_status" in ('resigned','terminated')) = ("ended_on" is not null)
  )
);--> statement-breakpoint

create index "employments_org_id_idx" on "employments" ("org_id");--> statement-breakpoint
create index "employments_store_id_idx" on "employments" ("store_id");--> statement-breakpoint
create index "employments_person_id_idx" on "employments" ("person_id");--> statement-breakpoint

-- At most ONE OPEN employment per person per store. Two open rows at one store is the shape that
-- lets a punch land on the wrong one and payroll pay it twice.
create unique index "employments_open_person_store_unique"
  on "employments" ("person_id", "store_id") where "ended_on" is null;--> statement-breakpoint

create unique index "employments_store_staff_code_unique"
  on "employments" ("store_id", lower("staff_code"));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- employment_positions — many positions, exactly one primary.
-- ---------------------------------------------------------------------------------------------

create table "employment_positions" (
  "id" uuid primary key default uuidv7(),
  -- CASCADE is deliberate and matches person_identities: an assignment is genuinely part of the
  -- employment, not an independent record (bible 4.2 rule 3).
  "employment_id" uuid not null references "employments"("id") on delete cascade,
  "position_id" uuid not null references "positions"("id") on delete restrict,
  "is_primary" boolean not null default false,
  "created_at" timestamptz not null default now()
);--> statement-breakpoint

create unique index "employment_positions_employment_position_unique"
  on "employment_positions" ("employment_id", "position_id");--> statement-breakpoint
create index "employment_positions_position_id_idx" on "employment_positions" ("position_id");--> statement-breakpoint

-- Exactly one primary per employment. The same partial-unique-index pattern person_roles uses.
create unique index "employment_positions_one_primary_unique"
  on "employment_positions" ("employment_id") where "is_primary";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- v_active_employments — "is this person on the roster" is DERIVED (bible 4.2 rule 7).
--
-- Discovery 15 8 records that v1 already treats the active-staff count as a projection invariant
-- ("activeStaffCountDelta ... must always equal count(staff where isActive==true)") and then keeps
-- the boolean column anyway. Nothing here stores it: this view is the only answer.
-- ---------------------------------------------------------------------------------------------

create view "v_active_employments" as
  select
    e."id",
    e."org_id",
    e."store_id",
    e."person_id",
    e."staff_code",
    e."employment_status",
    e."started_on",
    p."display_name"
  from "employments" e
  join "persons" p on p."id" = e."person_id"
  where e."ended_on" is null
    and e."employment_status" not in ('resigned','terminated','inactive')
    and p."is_active";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — org isolation is enforced by PostgreSQL, not by remembering to write WHERE org_id.
-- Scoping declared in packages/db/src/rls/registry.ts; these policies are that declaration applied.
--
-- app_current_org() is used rather than a raw current_setting cast: DEF-077 — SET LOCAL on a custom
-- GUC resets to '' (not NULL) at commit, so a pooled connection reused by a request that sets no
-- org leaves the previous value's empty string behind, and the raw cast then throws.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "positions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "positions_org_isolation" ON "positions"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

ALTER TABLE "employments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "employments_org_isolation" ON "employments"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

ALTER TABLE "employment_positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employment_positions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "employment_positions_org_isolation" ON "employment_positions"
	USING (exists (select 1 from employments e where e.id = employment_positions.employment_id and e.org_id = app_current_org()))
	WITH CHECK (exists (select 1 from employments e where e.id = employment_positions.employment_id and e.org_id = app_current_org()));
