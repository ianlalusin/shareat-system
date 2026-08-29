-- T-161 — inbox_quarantine: an event that could not be ingested, and can still be recovered.
-- docs/tasks/161-lane-b-ingestor.md, bible 5.4 rule 5
--
-- Landmine 14 is v1's dead letter: "no admin/manager UI was found anywhere in the app that reads
-- dead-lettered punches out of a device's IndexedDB". In v2 the event lives in Firestore rather
-- than a private device store, so it is never unreachable -- which is what makes a real quarantine
-- possible instead of a bin with better manners.
--
-- ⭐ And it HEALS. client_punch_id is UNIQUE, so a re-delivery updates the same row; an event stuck
-- as unknown_credential at 09:00 ingests cleanly at 09:05 once the staffer is enrolled, with no
-- human action at all.
--
-- Hand-written per DEF-073. Lane B owns 0070-0089.

create table "inbox_quarantine" (
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  -- ⚠️ Nullable: a store_mismatch event is quarantined precisely BECAUSE the store it claims cannot
  -- be trusted, so the terminal's own store is recorded and the claim stays in raw_event.
  "store_id" uuid references "stores"("id") on delete restrict,

  "client_punch_id" text not null,
  -- Nullable: an unknown_device event names a terminal that cannot be resolved.
  "device_id" uuid references "clock_terminals"("id") on delete restrict,

  -- ⛔ The event EXACTLY as received. 11 rule 5: "dirty data is surfaced, not silently coerced".
  -- By definition we failed to parse this shape, so storing our reading of it would preserve the
  -- mistake rather than the evidence.
  "raw_event" jsonb not null,

  "reason_code" text not null,
  "reason_detail" text,

  "first_seen_at" timestamptz not null default now(),
  "last_seen_at" timestamptz not null default now(),
  "attempts" integer not null default 1,

  "resolved_at" timestamptz,
  "resolved_by" uuid references "persons"("id") on delete restrict,
  "resolution" text,
  "resolution_reason" text,

  constraint "inbox_quarantine_reason_check" check ("reason_code" in (
    'malformed','unknown_device','revoked_device','unknown_credential',
    'method_disabled','store_mismatch','future_timestamp','internal_error')),
  constraint "inbox_quarantine_resolution_check"
    check ("resolution" is null or "resolution" in ('ingested','discarded')),

  -- Resolved_at and resolution travel together, always.
  constraint "inbox_quarantine_resolved_pair_check"
    check (("resolved_at" is null) = ("resolution" is null)),

  -- ⭐ resolved_by is NULLABLE on purpose, and only for 'ingested'. A quarantine that HEALS has no
  -- person behind it -- the staffer was enrolled, the event was re-delivered, and it went through
  -- on its own. Demanding an attributor there would force a sentinel person into the audit trail
  -- and make an automatic recovery look like somebody's decision.
  constraint "inbox_quarantine_resolver_check"
    check ("resolved_by" is null or "resolved_at" is not null),

  -- ⛔ DISCARDING is the one action that loses a real shift, so it needs BOTH a human and a reason.
  constraint "inbox_quarantine_discard_attribution_check" check (
    "resolution" is distinct from 'discarded'
    or ("resolved_by" is not null and "resolution_reason" is not null)
  ),
  constraint "inbox_quarantine_attempts_check" check ("attempts" >= 1)
);--> statement-breakpoint

create unique index "inbox_quarantine_client_punch_id_unique"
  on "inbox_quarantine" ("client_punch_id");--> statement-breakpoint
create index "inbox_quarantine_open_idx"
  on "inbox_quarantine" ("store_id", "resolved_at", "first_seen_at");--> statement-breakpoint
create index "inbox_quarantine_reason_idx" on "inbox_quarantine" ("reason_code");--> statement-breakpoint

ALTER TABLE "inbox_quarantine" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbox_quarantine" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "inbox_quarantine_org_isolation" ON "inbox_quarantine"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
