-- T-159 — clock_terminals: a device that authenticates as itself.
-- docs/tasks/159-firestore-rules-and-device-identity.md, bible 5.3
--
-- ⛔ There is deliberately NO secret column. v1 stores {id, secret} in plaintext localStorage,
-- which is a bearer credential for every enrolled fingerprint template at that store. The fix is
-- not encryption, it is delegation: the device signs in to Firebase Auth once with a one-time
-- custom token and the SDK holds the refresh material from then on. Nothing long-lived of ours
-- sits on the device to leak.
--
-- Hand-written per DEF-073. Lane B owns 0070-0089.

create table "clock_terminals" (
  -- ⭐ This id IS the deviceId claim in the device's token and on every inbox event. One
  -- identifier end to end, so the token, the event and the row cannot get out of step.
  "id" uuid primary key default uuidv7(),
  "org_id" uuid not null references "organizations"("id") on delete restrict,
  "store_id" uuid not null references "stores"("id") on delete restrict,

  "label" text not null,
  "firebase_uid" text not null,

  "provisioned_by" uuid references "persons"("id") on delete restrict,
  "provisioned_at" timestamptz not null default now(),

  -- ⚠️ NULL until the device completes its FIRST sign-in. T-153 finding 3: a device cannot begin
  -- authenticating offline, so "provisioned" and "ready" are different states and the UI must not
  -- conflate them -- a terminal carried out of signal before its first sign-in cannot write a
  -- single punch.
  "activated_at" timestamptz,

  "last_seen_at" timestamptz,

  "revoked_at" timestamptz,
  "revoked_by" uuid references "persons"("id") on delete restrict,
  "revoke_reason" text,

  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz,

  -- Revocation is a triple or none of it. A revoked row nobody can explain is not an audit trail.
  constraint "clock_terminals_revoked_triple_check" check (
    ("revoked_at" is null and "revoked_by" is null and "revoke_reason" is null)
    or ("revoked_at" is not null and "revoked_by" is not null and "revoke_reason" is not null)
  ),
  constraint "clock_terminals_label_not_blank_check" check (length(trim("label")) > 0)
);--> statement-breakpoint

create unique index "clock_terminals_firebase_uid_unique" on "clock_terminals" ("firebase_uid");--> statement-breakpoint
create index "clock_terminals_store_id_idx" on "clock_terminals" ("store_id");--> statement-breakpoint
create index "clock_terminals_org_id_idx" on "clock_terminals" ("org_id");--> statement-breakpoint
create index "clock_terminals_last_seen_idx" on "clock_terminals" ("store_id", "last_seen_at");--> statement-breakpoint

ALTER TABLE "clock_terminals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clock_terminals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clock_terminals_org_isolation" ON "clock_terminals"
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());
