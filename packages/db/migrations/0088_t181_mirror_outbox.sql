-- T-181 — mirror_outbox: the transactional outbox behind Lane A.
-- docs/tasks/181-lane-a-publisher.md, bible 5.1
--
-- The row change and its publish intent commit in ONE transaction; a relay drains the outbox
-- afterwards. 15.4 forbids dual-write and this is the sanctioned way to keep that promise.
--
-- ⭐ Enqueued by TRIGGERS, not by service calls. The outbox's whole guarantee is "the change and
-- its intent commit together", and a trigger makes that true by construction for every write path
-- that will ever exist -- a backfill, a cron, a module written in November. 12's standard is
-- "structurally impossible, not merely avoided by care"; a service call somebody forgets is care.
--
-- Hand-written per DEF-073. Lane B owns 0070-0089.

-- ---------------------------------------------------------------------------------------------
-- 1. One global version sequence.
--
-- NOT updated_at: two rows updated in the same millisecond are indistinguishable, and clock skew
-- between writers makes "newer" unanswerable. A sequence is a total order by construction, which
-- is what 5.1's "the publisher writes only when srcVersion is newer" actually needs.
-- ---------------------------------------------------------------------------------------------

create sequence "mirror_version_seq" as bigint start with 1 increment by 1;--> statement-breakpoint

create table "mirror_outbox" (
  -- ⭐ bigserial, not uuid. The relay reads in INSERTION ORDER and a monotonic integer is the
  -- cheapest possible watermark.
  "id" bigserial primary key,
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid not null references "stores"("id") on delete restrict,

  "entity" text not null,
  "entity_id" uuid not null,
  "op" text not null,
  "src_version" bigint not null,

  "enqueued_at" timestamptz not null default now(),
  "published_at" timestamptz,
  "attempts" integer not null default 0,
  "last_error" text,

  constraint "mirror_outbox_entity_check" check ("entity" in ('roster','attendance_config','day_feed')),
  constraint "mirror_outbox_op_check" check ("op" in ('upsert','delete')),
  constraint "mirror_outbox_attempts_check" check ("attempts" >= 0)
);--> statement-breakpoint

create index "mirror_outbox_drain_idx" on "mirror_outbox" ("published_at", "id");--> statement-breakpoint
create index "mirror_outbox_entity_idx" on "mirror_outbox" ("entity", "entity_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. The generic enqueue. One function, driven by trigger arguments, because every source table
-- below carries org_id, store_id and id under those names.
-- ---------------------------------------------------------------------------------------------

create or replace function mirror_enqueue() returns trigger as $$
declare
  v_row jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  v_entity text := tg_argv[0];
  v_op text := case when tg_op = 'DELETE' then 'delete' else 'upsert' end;
begin
  insert into mirror_outbox (org_id, store_id, entity, entity_id, op, src_version)
  values (
    (v_row->>'org_id')::uuid,
    (v_row->>'store_id')::uuid,
    v_entity,
    (v_row->>'id')::uuid,
    v_op,
    nextval('mirror_version_seq')
  );
  return coalesce(new, old);
end;
$$ language plpgsql;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Hot-set item 1 -- the roster.
--
-- ⚠️ An employment is not the only thing that changes what a terminal should show. A position
-- reassignment and a name change both alter the roster row, and neither touches `employments`.
-- Both are wired below, because a roster that silently stops updating is exactly the class of
-- failure this lane exists to remove.
-- ---------------------------------------------------------------------------------------------

create trigger employments_mirror_enqueue
  after insert or update or delete on "employments"
  for each row execute function mirror_enqueue('roster');--> statement-breakpoint

create or replace function mirror_enqueue_employment_parent() returns trigger as $$
declare
  v_row jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  e record;
begin
  select id, org_id, store_id into e from employments where id = (v_row->>'employment_id')::uuid;
  if found then
    insert into mirror_outbox (org_id, store_id, entity, entity_id, op, src_version)
    values (e.org_id, e.store_id, 'roster', e.id, 'upsert', nextval('mirror_version_seq'));
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;--> statement-breakpoint

create trigger employment_positions_mirror_enqueue
  after insert or update or delete on "employment_positions"
  for each row execute function mirror_enqueue_employment_parent();--> statement-breakpoint

-- A person's display name is on the roster document. Renaming one must reach the terminals.
create or replace function mirror_enqueue_person_employments() returns trigger as $$
begin
  if (new.display_name is distinct from old.display_name)
     or (new.is_active is distinct from old.is_active) then
    insert into mirror_outbox (org_id, store_id, entity, entity_id, op, src_version)
    select e.org_id, e.store_id, 'roster', e.id, 'upsert', nextval('mirror_version_seq')
    from employments e
    where e.person_id = new.id and e.ended_on is null;
  end if;
  return new;
end;
$$ language plpgsql;--> statement-breakpoint

create trigger persons_mirror_enqueue
  after update on "persons"
  for each row execute function mirror_enqueue_person_employments();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. Hot-set item 3 -- the store attendance config, which 5.3 marks PRIORITY.
--
-- Landmine 15: v1 does not cache this offline, so "a terminal keeps accepting a credential method
-- an admin has just disabled and the rejection surfaces only at sync time, as a silent dead
-- letter". A kill switch that arrives after the roster is a kill switch that did not work -- the
-- drain orders this entity first, see publisher.ts.
-- ---------------------------------------------------------------------------------------------

create trigger store_attendance_config_mirror_enqueue
  after insert or update on "store_attendance_config"
  for each row execute function mirror_enqueue('attendance_config');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. Hot-set item 4 -- the current-day feed.
-- ---------------------------------------------------------------------------------------------

create trigger attendance_days_mirror_enqueue
  after insert or update on "attendance_days"
  for each row execute function mirror_enqueue('day_feed');--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 6. ⛔ DEF-089 -- sequence privileges, and the gap this migration walked into.
--
-- Migration 0011 grants the app role SELECT/INSERT/UPDATE/DELETE on all tables AND sets
-- ALTER DEFAULT PRIVILEGES ... ON TABLES so every future table inherits them. It grants USAGE on
-- all SEQUENCES that existed at the time -- and sets NO default privilege for future ones.
--
-- ⚠️ Nothing noticed for 67 migrations because every table since has used uuidv7() defaults.
-- mirror_outbox is the first bigserial since 0011, and it failed immediately with
-- "permission denied for sequence mirror_outbox_id_seq". Anyone adding a serial column would have
-- hit the same wall, in whatever module they happened to be writing.
--
-- Both grants below, plus the default privilege 0011 omitted, so the next one just works.
-- ---------------------------------------------------------------------------------------------

GRANT USAGE, SELECT ON SEQUENCE "mirror_version_seq" TO "shareat_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "mirror_outbox_id_seq" TO "shareat_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "shareat_app";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 7. RLS.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "mirror_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mirror_outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mirror_outbox_org_isolation" ON "mirror_outbox"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
