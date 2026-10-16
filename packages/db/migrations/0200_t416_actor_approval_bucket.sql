-- 0200 - T-416: a per-person bucket for administrator-approval PIN misses (DEF-653).
-- docs/tasks/416-per-person-pin-budget.md; hand-authored per ADR-012 s5. Builds on 0199 (journal head).
--
-- WHY. Approval misses were charged to the record's store (or the org bucket, 0199), so a manager with N stores had
-- N x 50 guesses a day and anyone signed in could stop PIN sign-in at a store for every cashier. A bucket is now also
-- "a person": the signed-in actor typing the approval PIN. Approvals charge ONLY that bucket.
--
-- SHAPE. Nullable actor_person_id on pin_attempt_throttle and sign_in_attempts. A row has at most one key (store, or
-- actor, or neither = the 0199 org bucket); nothing is backfilled or deleted. The 0199 org-bucket unique index must
-- be narrowed to rows with no actor, otherwise a second person's bucket in the same org is a unique violation.
-- RLS, policies and grants are unchanged (both tables are already org_column, RLS from 0190).
ALTER TABLE "pin_attempt_throttle" ADD COLUMN "actor_person_id" uuid;
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD COLUMN "actor_person_id" uuid;
--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_actor_person_id_persons_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_actor_person_id_persons_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_actor_person_id_same_org_fk" FOREIGN KEY ("org_id", "actor_person_id") REFERENCES "persons"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_actor_person_id_same_org_fk" FOREIGN KEY ("org_id", "actor_person_id") REFERENCES "persons"("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pin_attempt_throttle" ADD CONSTRAINT "pin_attempt_throttle_one_key_check" CHECK (NOT ("store_id" IS NOT NULL AND "actor_person_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ADD CONSTRAINT "sign_in_attempts_one_key_check" CHECK (NOT ("store_id" IS NOT NULL AND "actor_person_id" IS NOT NULL));
--> statement-breakpoint
DROP INDEX "pin_attempt_throttle_org_bucket_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "pin_attempt_throttle_org_bucket_unique" ON "pin_attempt_throttle" ("org_id") WHERE "store_id" IS NULL AND "actor_person_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "pin_attempt_throttle_actor_unique" ON "pin_attempt_throttle" ("org_id", "actor_person_id") WHERE "actor_person_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "sign_in_attempts_actor_time_idx" ON "sign_in_attempts" ("actor_person_id", "occurred_at");
