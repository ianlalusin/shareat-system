-- 0158 — T-339 slice 5 / DEF-236: `attendance_credentials` refuses a blank revoke reason.
-- docs/tasks/339-small-defects-batch-1.md "Slice 5".
--
-- `attendance_credentials_revoke_check` (0100) binds only `revoked_at IS NOT NULL AND revoked_by
-- IS NOT NULL AND revoke_reason IS NOT NULL` — a `''` or `'   '` reason passes it today. Sibling
-- `person_credentials_revoke_check` (0138) already closed the same gap on the other table with a
-- `btrim(...) <> ''` clause; this repeats that fix here.
--
-- ⛔ **The obvious spelling of the non-blank clause is NULL-BLIND** — same trap 0138 documents. A
-- CHECK constraint passes when its expression evaluates to TRUE *or NULL*, so
--     ("revoked_at" is not null and btrim("revoke_reason") <> '')
-- accepts a revoked row whose reason is NULL: `btrim(NULL) <> ''` is NULL, `FALSE OR NULL` is
-- NULL, and the row goes in — waving through exactly the "missing" case the constraint exists to
-- forbid, while still refusing "blank". The explicit `IS NOT NULL` below is load-bearing, and this
-- table's own `t339-attendance-revoke-reason-check.test.ts` (NULL-blind trap case) is what keeps it
-- that way.
--
-- ⚠️ Unlike `person_credentials_revoke_check`, this table's shape check
-- (`attendance_credentials_shape_check`) does not bind `revoked_by`; that column stays
-- independently nullable per this table's own design — only the reason gains the non-blank clause.
--
-- The backfill is idempotent (same reasoning as 0138: not a `NOT VALID` case) and fires
-- `attendance_credentials_mirror_enqueue` for any backfilled row — expected, since a revoked
-- credential's mirror row should reflect the corrected reason.
--
-- HAND-WRITTEN, per DEF-073/DEF-121/DEF-242 (ADR-012 §5) — drizzle-kit's snapshot chain has been
-- dead since 0019. Never edited after apply.

UPDATE "attendance_credentials"
   SET "revoke_reason" = 'Revoked with a blank reason before one was required — DEF-236.'
 WHERE "revoked_at" IS NOT NULL AND btrim("revoke_reason") = '';--> statement-breakpoint

ALTER TABLE "attendance_credentials" DROP CONSTRAINT "attendance_credentials_revoke_check";--> statement-breakpoint

ALTER TABLE "attendance_credentials"
  ADD CONSTRAINT "attendance_credentials_revoke_check" CHECK (
    ("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL AND btrim("revoke_reason") <> '')
  );
