-- 0138 — T-239 / DEF-229: a revocation on `person_credentials` records WHY, not only who and when.
-- docs/tasks/239-def-229-credential-revoke-reason.md §3.
--
-- ⛔ **The register's own instruction was wrong, and this is the correction.** DEF-229 asked for
-- *"the same check shape as the attendance table"*. `attendance_credentials_revoke_check` binds all
-- THREE columns together — a revoked row there must name a person as well as a reason. Copied
-- verbatim onto this table it would refuse a row this system deliberately writes: `setPin`
-- (`packages/auth/src/sessions.ts`) retires the PIN it replaces with `revoked_by` NULL, because it
-- sits below the domain and has no `Actor` to name. `repo/sessions.ts` argues it at length — naming
-- the staffer instead would record that they revoked their own credential when an administrator
-- re-issued it, and *a fabricated attribution is worse than an absent one because it reads as
-- evidence*. **So the reason pairs with the TIMESTAMP; `revoked_by` stays independently nullable.**
-- Every PIN re-issue would throw under the sibling's shape — DEF-228 reopened from the other side.
--
-- ⛔ **And the obvious spelling of the non-blank clause is NULL-BLIND.** A CHECK constraint passes
-- when its expression evaluates to TRUE *or NULL*, so this —
--     ("revoked_at" is not null and btrim("revoke_reason") <> '')
-- — accepts a revoked row whose reason is NULL: `btrim(NULL) <> ''` is NULL, `FALSE OR NULL` is
-- NULL, and the row goes in. Proven on a lane database with two temp tables before this was
-- written: the naive form refuses a *blank* reason and waves through a *missing* one, which is the
-- single row the constraint exists to forbid. The explicit `IS NOT NULL` below is load-bearing, and
-- `credentials-admin.test.ts`' raw-SQL control is what keeps it that way.
--
-- ⚠️ **Stricter than its sibling, deliberately (spec §5).** `attendance_credentials` accepts `''`
-- and leaves the trim to its domain layer — the service as sole defence, which bible §15.11 calls
-- out: no layer may be the only one for a given risk. The divergence is logged in the register
-- rather than left for whoever copies the next one to discover.
--
-- ⚠️ The backfill is idempotent and was a no-op on every database it has been applied to
-- (`shareat_dev` 19 credentials / 0 revoked, `shareat_test` 0, `shareat_test_t216b` 9 / 0 revoked;
-- production holds no organisation at all yet). It is written anyway: it costs one statement now
-- and it is what stops the table carrying two permanent classes of row — the alternative,
-- `ADD CONSTRAINT … NOT VALID`, leaves a `VALIDATE CONSTRAINT` that fails years later on rows
-- nobody remembers. `person_credentials` is class `keep` at cutover, so revocations are not purged
-- on 1 January and whatever accumulates is kept.
--
-- HAND-WRITTEN, per DEF-073/DEF-121 — drizzle-kit's snapshot chain has been dead since 0019.
-- Never edited after apply.

ALTER TABLE "person_credentials" ADD COLUMN "revoke_reason" text;--> statement-breakpoint

UPDATE "person_credentials"
   SET "revoke_reason" = 'Revoked before a reason was required — DEF-229.'
 WHERE "revoked_at" IS NOT NULL AND "revoke_reason" IS NULL;--> statement-breakpoint

ALTER TABLE "person_credentials"
  ADD CONSTRAINT "person_credentials_revoke_check" CHECK (
    ("revoked_at" IS NULL AND "revoke_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL AND btrim("revoke_reason") <> '')
  );
