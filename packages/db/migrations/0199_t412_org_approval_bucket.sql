-- 0198 - T-412 S1: an organisation-level bucket for administrator-approval PIN misses.
-- docs/tasks/412-confirm-destructive-tiers.md "How the server verifies a Tier P action"; orchestrator ruling 1 (2026-10-15).
-- Hand-authored per ADR-012 s5. Builds on 0197 (journal head).
--
-- WHY. A few Tier P actions have no store of their own (posting the opening balances, the cutover, org-wide pay and sales).
-- A wrong administrator PIN typed there must still cost an attempt, and it must not borrow (or spend) any store's budget.
-- So `store_id` becomes NULLABLE on pin_attempt_throttle and sign_in_attempts: a row with store_id NULL is the ORGANISATION's
-- own bucket, same limits as a store's. Every existing row has a store; nothing is backfilled.
--
-- SHAPE. The existing UNIQUE index on pin_attempt_throttle(store_id) already allows several NULLs, so one bucket per
-- organisation needs its own partial unique index. The composite same-org FKs (org_id, store_id) are MATCH SIMPLE: a NULL
-- store_id skips the check, which is what we want. RLS and grants are unchanged (org_id is still NOT NULL).
ALTER TABLE "pin_attempt_throttle" ALTER COLUMN "store_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "sign_in_attempts" ALTER COLUMN "store_id" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "pin_attempt_throttle_org_bucket_unique" ON "pin_attempt_throttle" ("org_id") WHERE "store_id" IS NULL;
