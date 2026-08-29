-- T-185 — attendance_credentials: what a terminal scans, and who it belongs to.
-- docs/tasks/185-credential-enrolment-and-mirror.md, bible §5.3 and §13 row 164.
--
-- Hand-written per DEF-073.
--
-- ⚠️ THE FIRST MIGRATION IN LANE B'S SECOND BLOCK. 0080-0089 is fully consumed (T-154 … T-182), so
-- the phase's remainder claims 0100-0119 — chosen over 0090-0099 to leave clear air above `main`,
-- which is at 0070 and advancing. Per DEF-091 the journal `when` is DERIVED FROM `idx`
-- (base + (idx - 59) days), never from `previous.when + 86400000`: a reserved number block only
-- works if it reserves the timestamps too.
--
-- ⛔ `face` is deliberately absent from the kind CHECK. Everything in this table is published to
-- the credential mirror, so a face row would be a face template on a tablet by construction —
-- bible §5.3, "never mirrored, never cached, never bundled", after the 2026-07-04 exfiltration
-- finding. Making it unrepresentable is the same move that removed the PIN from
-- attendance_punches.method.

create table "attendance_credentials" (
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid not null references "stores"("id") on delete restrict,
  "employment_id" uuid not null references "employments"("id") on delete restrict,

  "kind" text not null,
  "card_id" text,
  "match_token" text,
  "templates" text[],

  "enrolled_by" uuid not null references "persons"("id") on delete restrict,
  "enrolled_at" timestamp with time zone not null default now(),

  "revoked_at" timestamp with time zone,
  "revoked_by" uuid references "persons"("id") on delete restrict,
  "revoke_reason" text,

  constraint "attendance_credentials_kind_check" check ("kind" in ('card','fingerprint')),

  -- ⛔ Each kind's shape, enforced here rather than hoped for in a service.
  constraint "attendance_credentials_shape_check" check (
    ("kind" = 'card' and "card_id" is not null
       and "match_token" is null and "templates" is null)
    or ("kind" = 'fingerprint' and "match_token" is not null
       and "templates" is not null and array_length("templates", 1) between 1 and 2
       and "card_id" is null)
  ),

  -- ⛔ A revocation with no human or no reason is not an audit trail.
  constraint "attendance_credentials_revoke_check" check (
    ("revoked_at" is null and "revoked_by" is null and "revoke_reason" is null)
    or ("revoked_at" is not null and "revoked_by" is not null and "revoke_reason" is not null)
  )
);--> statement-breakpoint

-- ⭐ Two LIVE credentials with the same value makes "who punched?" unanswerable, and an ambiguous
-- credential check that picks the first match is how the wrong person gets paid.
-- ⚠️ PARTIAL on revoked_at is null — a revoked card id may be reissued, which is exactly what
-- happens when a badge is lost and reprinted with the same number.
create unique index "attendance_credentials_card_live_unique"
  on "attendance_credentials" ("org_id", "card_id")
  where "revoked_at" is null and "card_id" is not null;--> statement-breakpoint
create unique index "attendance_credentials_token_live_unique"
  on "attendance_credentials" ("org_id", "match_token")
  where "revoked_at" is null and "match_token" is not null;--> statement-breakpoint

create index "attendance_credentials_lookup_idx"
  on "attendance_credentials" ("store_id", "kind", "revoked_at");--> statement-breakpoint
create index "attendance_credentials_employment_idx"
  on "attendance_credentials" ("employment_id");--> statement-breakpoint

ALTER TABLE "attendance_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attendance_credentials_org_isolation" ON "attendance_credentials"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- The fourth mirror entity: `credential`.
--
-- ⭐ It publishes to biometricMirror/{storeId}/credentials/{id} — the TERMINAL-ONLY path T-159's
-- ruleset already guards, and the reason the card id went into hot-set item 2 rather than item 1
-- (§13 row 164): a card is a bearer credential, so on the roster every store member could read
-- every badge and impersonate any colleague.
-- ---------------------------------------------------------------------------------------------

alter table "mirror_outbox"
  drop constraint "mirror_outbox_entity_check";--> statement-breakpoint
alter table "mirror_outbox"
  add constraint "mirror_outbox_entity_check"
  check ("entity" in ('roster','attendance_config','day_feed','credential'));--> statement-breakpoint

create trigger "attendance_credentials_mirror_enqueue"
  after insert or update or delete on "attendance_credentials"
  for each row execute function mirror_enqueue('credential');
