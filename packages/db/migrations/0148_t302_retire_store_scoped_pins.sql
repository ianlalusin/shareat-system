-- 0148 — T-302 global PIN uniqueness: retire every PIN hashed under the old store-scoped key.
-- docs/tasks/302-global-pin-uniqueness.md §"the re-issue".
--
-- ⛔ **WHY THIS EXISTS AT ALL — T-302's spec said "no migration", and that was wrong.**
-- T-302 changes the lookup key from `HMAC(storeId:pin)` to `HMAC(orgId:pin)`. Nothing about that
-- needs a schema change: the unique index on `lookup_hash` (0137) already enforces "one live PIN,
-- one person" and keeps doing so under the new key. But it leaves every EXISTING `pin` row holding
-- a hash computed the old way — a hash the new code can never produce and therefore never match.
--
-- Those rows are not merely inert. They are LIVE credentials that cannot authenticate, and two
-- surfaces report them as working PINs:
--   * `apps/erp/src/app/staff/lib.ts`'s `livePinFor` → "Issued <date>" on the employment page;
--   * `packages/db/src/repo/stores.ts`'s `countActiveCredentials` → the BLOCKING `signIn`
--     readiness gate reads "N person(s) with a live PIN can sign in here".
-- So without this statement the deploy produces a silent failure that reports success: every
-- cashier's PIN stops working, and every screen that could have said so says the opposite.
--
-- ⭐ Revoking converts that into a state the system already renders honestly and already has a
-- remedy for: "No sign-in PIN issued yet — this person cannot sign in", with the issue-PIN form
-- directly beneath it.
--
-- ⚠️ **THIS IS THE CUTOVER'S ONLY DESTRUCTIVE STEP AND IT IS NOT REVERSIBLE BY ROLLBACK.**
-- Rolling the release symlink back restores the old CODE, whose store-scoped hashes would match
-- these rows again — but they are revoked by then, and `revoked_at` is not un-set by a rollback.
-- **Every PIN must be re-issued from Staff after this deploy, in the same sitting.** Admin email
-- and password sign-in is unaffected and is the way back in. T-304's cutover deliberately touched
-- zero credentials; T-302 is the task that spends that, and the blast radius grows with every
-- store provisioned after today.
--
-- ⚠️ Scoped to `kind = 'pin'` — a `firebase` credential (including a store terminal's, T-304) and a
-- `biometric` one (T-185) carry no `lookup_hash` of this shape and must not be touched. Idempotent:
-- `revoked_at is null` means a re-run revokes nothing.
--
-- Additive to the schema (no DDL), so `packages/db/schema/` is unchanged and there is no
-- `// NOTE: hand-added` comment to place (ADR-012 §5 step 3).
--
-- Hand-authored per ADR-012 §5 — `npm run db:generate` is retired and fails closed (DEF-242).

UPDATE "person_credentials"
SET "revoked_at" = now(),
    "revoke_reason" = 'Retired by T-302: PINs became unique across the whole business, so every PIN is hashed a new way and the old six digits no longer sign anyone in. Issue this person a new PIN from Staff.'
WHERE "kind" = 'pin'
  AND "revoked_at" IS NULL;
