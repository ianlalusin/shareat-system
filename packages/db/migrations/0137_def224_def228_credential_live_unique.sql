-- 0137 — T-237: `person_credentials`' two unique indexes become PARTIAL, on live rows only.
-- docs/tasks/237-def-224-firebase-credential-lifecycle.md §2.2 and §3.
--
-- ⛔ **DEF-224** — a Firebase uid that was unlinked could never be linked again. `external_id`'s
-- index covered revoked rows too, so the re-insert raised 23505 and T-232's own sentence, *"ask an
-- administrator to link it"*, was advice nobody could follow.
--
-- ⛔ **DEF-228** — the same shape one index over, with a live security hole beside it. `setPin`
-- inserts a new PIN row and ends the person's SESSIONS ('superseded') without revoking the old
-- CREDENTIAL, so a previous PIN goes on signing that person in forever. Retiring it is the fix, and
-- retiring it is impossible while `lookup_hash`'s index is total: the revoked row would keep the
-- hash, so changing a PIN back to an earlier one would then fail for everybody.
-- ⚠️ **This migration alone is not the DEF-228 fix and must not ship without T-237 slice C.** On its
-- own it removes the error that currently makes the same-digits case visible (DEF-177) while
-- leaving the old PIN working.
--
-- ⭐ Not a new idea: `attendance_credentials` has been partial on `revoked_at is null` since T-185
-- (`schema/attendance-credentials.ts:110-118`) — *"a revoked card id may be reissued, which is what
-- makes revocation reversible in practice."* This makes the older table consistent with it.
--
-- ⚠️ **The index NAMES are deliberately unchanged.** `apps/erp/src/app/staff/actions.ts:58` matches
-- `person_credentials_lookup_hash_unique` as a literal in a regex over the raw driver error
-- (DEF-177's mapped sentence). A rename would have dropped that sentence to a raw 23505 with a green
-- build and green tests — the sweep found it because index names were grepped as names, not only as
-- schema references.
--
-- ⚠️ Uniqueness among LIVE rows is unchanged. Two live rows still collide: one uid signs in as
-- exactly one person, one lookup hash is exactly one credential in a store. Only history stops
-- competing with the present. ⛔ In particular this does NOT open one Firebase account across two
-- organisations — `findActiveCredentialByExternalId` ends `const [row] = …` with no ORDER BY, on the
-- owner connection where RLS does not apply, so two live rows would sign a franchise owner into an
-- arbitrary org on different days, silently (T-237 §2.3).
--
-- HAND-WRITTEN, per DEF-073/DEF-121 — drizzle-kit's snapshot chain has been dead since 0019.
-- Never edited after apply.

DROP INDEX "person_credentials_lookup_hash_unique";--> statement-breakpoint

CREATE UNIQUE INDEX "person_credentials_lookup_hash_unique"
	ON "person_credentials" ("lookup_hash")
	WHERE "person_credentials"."revoked_at" IS NULL AND "person_credentials"."lookup_hash" IS NOT NULL;--> statement-breakpoint

DROP INDEX "person_credentials_external_id_unique";--> statement-breakpoint

CREATE UNIQUE INDEX "person_credentials_external_id_unique"
	ON "person_credentials" ("external_id")
	WHERE "person_credentials"."revoked_at" IS NULL AND "person_credentials"."external_id" IS NOT NULL;
