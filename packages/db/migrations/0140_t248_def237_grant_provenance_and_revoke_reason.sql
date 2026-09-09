-- 0140 — T-248 / DEF-237: person_grants records WHERE a grant came from and WHY it was revoked.
-- docs/tasks/248-def-237-revoke-elevated-grants-on-admin-arrival.md §1.
--
-- Two gaps, one migration (cheaper and more coherent than two, per the orchestrator's ruling):
--
-- 1. `grant_source` — until now, `assignRole`'s automatic grant-time-fallback elevation
--    (bible row 115), `elevateManager`'s manual "explicit tick" re-elevation (bible row 116),
--    `createFirstAdmin`'s owner-equivalence grant, and an ordinary admin hand-grant
--    (`grantCapabilityAsActor`) all wrote structurally IDENTICAL `person_grants` rows — same
--    columns, sometimes the same `granted_by`. Nothing said which was which. T-248 (DEF-237,
--    bible row 188) needs to revoke exactly the first two kinds when an organisation gains an
--    administrator, and NEVER the other two — a fabricated guess at provenance would risk
--    stripping a deliberately-granted capability, which is the exact harm this task exists to
--    prevent. So the source is recorded going forward, not inferred backward.
--
-- ⛔ **Pre-existing ACTIVE grants get `grant_source = NULL`, deliberately, not backfilled by
--    inference.** There is no reliable way to reconstruct whether a row predating this column was
--    auto-elevated or hand-granted — a fabricated attribution is worse than an absent one,
--    because it reads as evidence (the same reasoning `person_credentials.revoked_by` staying
--    NULL for a `setPin` supersede already established in this codebase, migration 0137).
--    `NULL` is never eligible for the new revocation (which matches only `'elevation'`), so
--    nothing already-active is at risk either way — but only `NULL` is a TRUE statement about
--    what is known, and treating it as `'grant'` (the superficially "safe" direction) would not be.
--
-- 2. `revoke_reason` — `person_grants` could not record WHY any grant was ever revoked, elevation
--    or otherwise. Same shape as `person_credentials_revoke_check` (migration 0138, T-239 /
--    DEF-229), copied rather than re-derived: the reason pairs with `revoked_at`; `revoked_by`
--    (which this table has never had, unlike `person_credentials`) stays out of scope here — a
--    third column is a decision of its own, not folded in silently.
--
-- ⛔ **The null-blind trap, avoided on purpose.** A CHECK constraint passes when its expression
--    evaluates to NULL, so the naive spelling —
--        ("revoked_at" is not null and btrim("revoke_reason") <> '')
--    — accepts a revoked row whose reason is NULL: `btrim(NULL) <> ''` is NULL, `FALSE OR NULL`
--    is NULL, and the row is admitted. The explicit `IS NOT NULL` term below is load-bearing;
--    `roles.test.ts`'s raw-SQL control (T-248 §Tests case, mirroring T-239 §10 case 3) is what
--    keeps it that way — it fails red without that term, on purpose, before trusting the shape.
--
-- ⚠️ The `revoke_reason` backfill is idempotent and is verified against every reachable database
--    before this migration is treated as done (see the task's READY report) — the same discipline
--    T-239 held itself to, not assumed here.
--
-- HAND-WRITTEN, per DEF-073/DEF-121/DEF-242 — drizzle-kit's snapshot chain has been dead since
-- 0019 (13 snapshots against a 123-entry journal; `db:generate` fails on a false rename question
-- about `expense_categories` before it would ever reach this table). Never edited after apply.

ALTER TABLE "person_grants" ADD COLUMN "grant_source" text;--> statement-breakpoint

ALTER TABLE "person_grants"
  ADD CONSTRAINT "person_grants_source_check" CHECK (
    "grant_source" IS NULL OR "grant_source" IN ('elevation', 'owner', 'grant')
  );--> statement-breakpoint

ALTER TABLE "person_grants" ADD COLUMN "revoke_reason" text;--> statement-breakpoint

UPDATE "person_grants"
   SET "revoke_reason" = 'Revoked before a reason was required — DEF-237.'
 WHERE "revoked_at" IS NOT NULL AND "revoke_reason" IS NULL;--> statement-breakpoint

ALTER TABLE "person_grants"
  ADD CONSTRAINT "person_grants_revoke_check" CHECK (
    ("revoked_at" IS NULL AND "revoke_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL AND btrim("revoke_reason") <> '')
  );
