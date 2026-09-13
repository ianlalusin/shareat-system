-- 0147 — T-304 (DEF-333) two-layer terminal sign-in + T-303 (DEF-333) PIN attempt throttle.
-- docs/tasks/304-two-layer-terminal-sign-in.md, docs/tasks/303-pin-attempt-lockout.md.
--
-- Three independent changes, one migration slot (allocated by the orchestrator for this cycle):
--   1. `persons.kind` — explicit discriminator for a terminal's own `persons` row (option (a)).
--      Never inferred from `credential.storeId is not null` — see persons.ts's own comment.
--   2. `pin_attempt_throttle` — one row per store, `org_column`, ported from v1's Firestore
--      throttle (ERP-rebuild/src/lib/actions/attendance-clock.actions.ts:440-512).
--   3. `v_active_employments` replaced forward (never edited — RULES §1 rule 9, same idiom
--      0143/0145 use for functions) to exclude a terminal-kind person, so a terminal appears in
--      no staff listing and no headcount without a query at every call site having to remember to
--      filter it — the "no convenient proxy" instruction applied to the READ side too.
--
-- Hand-authored per ADR-012 §5 — `npm run db:generate` is retired and fails closed (DEF-242).

-- ---------------------------------------------------------------------------------------------
-- 1. persons.kind
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "persons" ADD COLUMN "kind" text NOT NULL DEFAULT 'person';--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_kind_check" CHECK ("kind" in ('person', 'terminal'));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. pin_attempt_throttle
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "pin_attempt_throttle" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE UNIQUE INDEX "pin_attempt_throttle_store_id_unique" ON "pin_attempt_throttle" ("store_id");--> statement-breakpoint

-- RLS — declared in packages/db/src/rls/registry.ts as `org_column`; this is that declaration
-- applied. ENABLE and FORCE as the table is created, never retrofitted (bible row 112).
ALTER TABLE "pin_attempt_throttle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pin_attempt_throttle_org_isolation" ON "pin_attempt_throttle"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. v_active_employments — replaced forward, never edited (0080's own definition, unchanged
-- except for the one added predicate).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW "v_active_employments" as
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
    and p."is_active"
    and p."kind" = 'person';
