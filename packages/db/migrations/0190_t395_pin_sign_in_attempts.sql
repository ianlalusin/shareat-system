-- 0190 - T-395 S1 (DEF-063, DEF-626): PIN sign-in tier 2, the attempt log.
-- docs/tasks/395-pin-sign-in-throttle.md (Contract, Migration).
--
--   1. sign_in_attempts - one row per wrong PIN charged, one per tier-1 pause, one per tier-2 stop.
--      org_column table; written after layer 1, so the org is known (never a pre-auth write, DEF-333).
--      The columns can hold no PIN, hash or prefix (invariant I6).
--   2. pin_attempt_throttle gains stopped_at / reopened_at / reopened_by (tier 2 state).
--
-- Hand-authored per ADR-012 section 5 - db:generate is retired (DEF-242).

CREATE TABLE "sign_in_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_attempts_kind_check" CHECK ("kind" in ('miss', 'lockout', 'stopped'))
);--> statement-breakpoint

ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_device_id_persons_id_fk"
	FOREIGN KEY ("device_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "sign_in_attempts_store_time_idx" ON "sign_in_attempts" ("store_id", "occurred_at");--> statement-breakpoint
CREATE INDEX "sign_in_attempts_org_time_idx" ON "sign_in_attempts" ("org_id", "occurred_at");--> statement-breakpoint

ALTER TABLE "sign_in_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sign_in_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sign_in_attempts_org_isolation" ON "sign_in_attempts"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- DELETE: a success refunds its own charge and each charge purges rows older than 90 days.
-- UPDATE ("id") only: the purge selects its batch FOR UPDATE SKIP LOCKED, and Postgres requires the UPDATE
-- privilege for FOR UPDATE (ADR-012 section 5 4a; 0169's lesson). No row is ever actually updated.
GRANT UPDATE ("id") ON "sign_in_attempts" TO "shareat_app";--> statement-breakpoint
GRANT DELETE ON "sign_in_attempts" TO "shareat_app";--> statement-breakpoint

ALTER TABLE "pin_attempt_throttle" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD COLUMN "reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD COLUMN "reopened_by" uuid;--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_reopened_by_persons_id_fk"
	FOREIGN KEY ("reopened_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
