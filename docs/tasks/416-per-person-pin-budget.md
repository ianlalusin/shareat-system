# T-416 — Administrator-PIN approvals get a per-person miss cap, off the store's sign-in budget (DEF-653)

**Status:** spec written 2026-10-16, not started. Opus spec. Closes **DEF-653** (T-412 M6, deferred).
**Model: SONNET** for every slice (auth + schema). Tests first, confirmed red for the right reason; one mutant per
invariant; a **fresh Sonnet audit** (no build context) after S2. **Migration 0200** (reserved for this task), hand-authored
per ADR-012 §5. ⛔ A migration is gated on the **FULL integration suite on a fresh DB** (memory "full suite for
migrations"; CI PR, row 296) — never only this task's files. Size M.

## The problem (as built at `9c1704b`)
- `verifyAdminApproval` (`packages/auth/src/admin-approval.ts:38-64`) charges its miss through `runChargedPinLookup`
  (`packages/auth/src/sessions.ts:112-155`) with `{ orgId, storeId }` — the **record's store**, or the org bucket
  (`storeId: null`, migration 0199) for org-level actions (`apps/erp/src/app/cutover/actions.ts:118,142`).
- That is the store's sign-in budget: `chargeAttempt` (`packages/db/src/repo/pin-attempts.ts:61-168`), tier 1 =
  `MISS_THRESHOLD` 10 per 60 s (`:18-20`), tier 2 = `DAILY_MISS_BUDGET = 50` in a **rolling 24 h** (`:23-24`, counted
  `:90-103`); a stop lasts until a manager reopens it (`STOP_AUTO_REOPEN_MINUTES = null`, `:26`; `reopenPinSignIn`,
  `packages/auth/src/credentials-admin.ts:312-331`, gated on `enrol_staff` at the store).
- So (a) a manager with N stores has N × 50 approval guesses a day plus the org bucket; (b) anyone signed in can type 50
  wrong approval PINs and **stop PIN sign-in at a store for every cashier** until a manager reopens it.

## Design — research, evaluate, propose
**Rejected: a new table.** It would duplicate `chargeAttempt`'s lock / count / stop / refund / purge sequence, which took
T-303, T-395 and DEF-626 to get exact under concurrency. A second copy is a second place for that bug to come back.
**Chosen: a third bucket kind on the two existing tables.** Today a bucket is "a store" or (0199) "the organisation".
Add "a person": nullable `actor_person_id` on `pin_attempt_throttle` and `sign_in_attempts`. The bucket key is the
**signed-in actor** (`actor.personId` from `resolveActor`) — the person typing, known BEFORE the lookup, so the
charge-before-lookup invariant (T-395 R14) holds unchanged. (Keying on the PIN's owner is impossible: unknown until
after the lookup, and absent for a wrong PIN.)
**An approval charges ONLY the actor's bucket** — never a store's, never the org's. Approvals and sign-ins stop sharing
anything: a bad approval actor can lock out only themselves.

**The limits (one named block in `pin-attempts.ts`):** `APPROVAL_DAILY_MISS_CAP = 10` misses per person in a rolling
24 h. An admin types their PIN a few times a day; 10 wrong is far past fat-fingering, and with k administrators the
guess odds are 10·k in 1,000,000 a day. Tier 1 (the 60 s pause) is **skipped** for the actor bucket — its message says
"this terminal", which is false here, and the cap of 10 already bounds a burst.
**Reset semantics.** The existing budget is a **rolling 24 h window, not a Manila calendar day** (`:96-97`), and Ian's
business day ends at store closing time (bible row 348) — a person spans stores with different closings, so a calendar
or business-day reset has no single right midnight and lets 10 at 23:59 plus 10 at 00:01 through. Proposed: the same
rolling 24 h window, and a capped person **auto-lifts 24 h after the cap tripped** (`chargeAttempt`'s existing
`stopAutoReopenMinutes` option = 1440 for this bucket), or earlier when an administrator resets it. Open Question 1.

### What the capped person sees (one sentence, no names, ids, counts or times)
`APPROVAL_PIN_CAPPED = 'Too many wrong administrator PINs from your account today. An administrator can clear this on
your user page, or try again tomorrow.'` Shown for EVERY attempt while capped, correct PIN included, with **zero
lookups** (as I6 does today). PIN sign-in at any store is unaffected.

### Who can reset, and where
An administrator holding `manage_users` (admin / super_admin only, org-scoped: `capabilities.ts:553,764,960`) on
`/admin/users/[personId]`: a status line ("Administrator-PIN approvals: capped since <business time>" or nothing) and a
"Clear the approval-PIN cap" button (plain button; this is not a Tier P action). **Nobody may clear their own cap**
(refused: "Another administrator must clear this."). Not capped = no-op, nothing written. No new capability
(`CAPABILITY-MATRIX.md` unchanged).

### Audit trail
- `auth.approval_pin_capped` — the attempt that TRIPS the cap writes one row (system actor, `entityId` = the capped
  person, `after: { cap: APPROVAL_DAILY_MISS_CAP }`), exactly like `auth.pin_stopped_for_day`: in the caller's tx when
  one is given, else via the outbox (`security-events.ts`, new `enqueueApprovalPinCapped` beside `enqueuePinStoppedForDay`
  `:142`). An already-capped attempt writes nothing more.
- `reset_approval_pin_cap` — the reset, in the same tx as the update: `actorPersonId` = the administrator, `entityId` =
  the person, `before: { cappedAt }`, `after: { resetAt }`.
- Every miss stays a `sign_in_attempts` row (`kind='miss'`, `actor_person_id` set), so "who guessed how often" is
  queryable; the 90-day purge (`:155-165`) covers these rows as it does today.
Register both in `packages/db/src/audit/catalogue.ts` (T-402 pattern, `def(…, 'T-416', …)`; scope per the catalogue's
own rules — org-level, entity table `persons`).

## Migration 0200 — `packages/db/migrations/0200_t416_actor_approval_bucket.sql`
Header per ADR-012 §5 step 2 (task, DEF-653, why). Statements, `--> statement-breakpoint` between each:
1. `ALTER TABLE pin_attempt_throttle ADD COLUMN actor_person_id uuid` and the same on `sign_in_attempts`.
2. Same-org composite FKs `(org_id, actor_person_id) -> persons(org_id, id)` ON DELETE RESTRICT on both tables
   (`*_actor_person_id_same_org_fk`, the 0194 pattern) — plus the single-column FK to `persons(id)` the schema declares.
3. CHECK on both: `NOT (store_id IS NOT NULL AND actor_person_id IS NOT NULL)` — at most one key. (Not "exactly one":
   0199 org-bucket rows have neither and are kept; nothing is backfilled or deleted.)
4. ⛔ **Drop and recreate** `pin_attempt_throttle_org_bucket_unique` as `ON (org_id) WHERE store_id IS NULL AND
   actor_person_id IS NULL` — the 0199 predicate would make a second person's bucket in the same org a unique violation.
5. `CREATE UNIQUE INDEX pin_attempt_throttle_actor_unique ON pin_attempt_throttle (org_id, actor_person_id) WHERE
   actor_person_id IS NOT NULL`; `CREATE INDEX sign_in_attempts_actor_time_idx ON sign_in_attempts (actor_person_id,
   occurred_at)`.
RLS, policies and grants unchanged (both tables are already `org_column`, RLS from 0190, UPDATE/DELETE granted).
Journal: idx 200, `when = 1803267107084 + 86_400_000 = 1803353507084`, tag `0200_t416_actor_approval_bucket`.
Schema files mirror every column/FK/index/CHECK; the partial unique indexes are expressible in the builder (as 0199's is).
**Classification / registry:** both tables are already listed — `packages/db/src/cutover/classification.ts:282-293`
(`purge`) and `packages/db/src/rls/registry.ts:414-427` (`org_column`). No new entry is needed, but **both reasons say
"a throttle belongs to a store" and must be reworded** to name the person bucket (still `purge`, still `org_column`;
the person is in one org, and the write is after `resolveActor`, never pre-auth).

## Code shape
- `pin-attempts.ts`: replace `storeId: string | null` with `type Bucket = { store: string } | { org: true } |
  { actor: string }` in `chargeAttempt`, `refundOnSuccess`, `clearOnSuccess`; the `bucket(col)` filter (`:70-74`) gains
  the actor arm, and ⛔ the org arm gains `and actor_person_id is null` (else the org bucket counts every person's misses).
  `chargeAttempt` opts gain `dailyMissBudget` and `tier1: boolean`. New `resetActorCap(tx, orgId, personId, byPersonId)`
  (mirrors `reopen`, `:195-211`) and `statusForActor(tx, orgId, personId)`.
- `sessions.ts`: `runChargedPinLookup` takes the `Bucket`; `signInWithPin` passes `{ store }` (behaviour identical).
  A `stopped` charge on an actor bucket throws `APPROVAL_PIN_CAPPED`, never `STOPPED_MESSAGE`.
- `admin-approval.ts`: charge `{ actor: actor.personId }` with `{ dailyMissBudget: APPROVAL_DAILY_MISS_CAP, tier1: false,
  stopAutoReopenMinutes: 1440 }`. `storeId` stays in the signature (it still scopes the row-196 `can` fallback); the
  30 callers in `apps/erp/src/app` do not change. The 0199 org-bucket branch is no longer reached by approvals; keep
  the arm (harmless, keeps Open Question 2 cheap).
- `credentials-admin.ts`: `resetApprovalPinCap(tx, actor, personId)` — `authorize(…, 'manage_users')`, refuse self,
  repo reset, audit row; export from `packages/auth/src/index.ts`.

## Files — BUILDER (only these)
`packages/db/migrations/0200_t416_actor_approval_bucket.sql` · `packages/db/migrations/meta/_journal.json` ·
`packages/db/schema/pin-attempts.ts` · `packages/db/schema/sign-in-attempts.ts` · `packages/db/src/repo/pin-attempts.ts`
· `packages/db/src/audit/catalogue.ts` · `packages/db/src/cutover/classification.ts` (reason text) ·
`packages/db/src/rls/registry.ts` (reason text) · `packages/auth/src/sessions.ts` · `packages/auth/src/admin-approval.ts`
· `packages/auth/src/credentials-admin.ts` · `packages/auth/src/security-events.ts` · `packages/auth/src/index.ts` ·
`apps/erp/src/app/admin/users/actions.ts` · `apps/erp/src/app/admin/users/[personId]/page.tsx`.

## Files — TESTER (only these; disjoint from the builder's)
NEW `packages/auth/tests/integration/t416-approval-pin-cap.test.ts` (A1–A11) ·
NEW `packages/db/tests/integration/t416-actor-bucket-schema.test.ts` (A12–A13) ·
EDIT `packages/auth/tests/integration/t412-admin-approval.test.ts` — **I2c, I6 and I11 asserted the old shared budget
and are deliberately superseded**: I2c becomes "the miss is on the actor's bucket and on NO store"; I6 moves to A3;
I11 (and its mutant M12) is inverted to A4. Every other T-412 case stays green unedited.
**Unedited and green:** `packages/auth/tests/integration/t395-pin-daily-budget.test.ts`, `t395-reopen.test.ts`,
`terminal-sign-in.test.ts`, `packages/db/tests/integration/t395-*.test.ts` — sign-in behaviour does not change.

## Acceptance cases (each names the mutant it kills; every mutant shown red, then reverted)
- **A1** one wrong approval writes one `miss` with `actor_person_id` = actor and `store_id` NULL; the record's store has
  0 miss rows. **Kills M1:** charge `{ store: storeId }` as before.
- **A2** 10 misses in 24 h, then the 11th attempt — the admin's CORRECT PIN — reads `APPROVAL_PIN_CAPPED`, zero lookups,
  and exactly one `auth.approval_pin_capped` row exists. **Kills M2:** cap read as `DAILY_MISS_BUDGET` (50).
- **A3** with the actor capped, a cashier's correct PIN signs in at that store; the store is neither paused nor stopped.
  **Kills M3:** also charge the store bucket.
- **A4** 5 wrong approvals on a store-A record + 5 on a store-B record cap the person (no N × cap). **Kills M4:** key the
  bucket on (actor, store).
- **A5** actor P capped; actor Q in the same org approves with the admin's PIN. **Kills M5:** drop
  `actor_person_id = $` from the actor filter (any person's misses count).
- **A6** the 0199 org bucket counts no actor-bucket misses (seed 10 actor misses; an org-bucket charge is not stopped).
  **Kills M6:** omit `and actor_person_id is null` from the org arm.
- **A7** 10 misses 25 h old do not cap. **Kills M7:** window 48 h.
- **A8** cap tripped 24 h + 1 min ago, no reset: the next correct approval succeeds. **Kills M8:** `stopAutoReopenMinutes`
  null for the actor bucket.
- **A9** 10 correct approvals leave 0 miss rows for the actor; the next wrong one is a plain `ADMIN_PIN_REFUSED`.
  **Kills M9:** skip `refundOnSuccess` for the actor bucket.
- **A10** `tx = null` path: a wrong approval's miss row survives the throw. **Kills M10:** charge inside the lookup tx.
- **A11** reset: an admin clears P's cap -> P approves again, one `reset_approval_pin_cap` row (admin, P, before/after);
  a manager is refused (`manage_users`); P clearing their own cap is refused; clearing an uncapped person writes nothing.
  **Kills M11a** drop the `authorize`, **M11b** drop the self check, **M11c** audit on a no-op.
- **A12** schema: a row with both `store_id` and `actor_person_id` is rejected; a second throttle row for the same
  (org, person) is rejected; two different persons in one org both get buckets; a person of another org is rejected by
  the same-org FK. **Kills M12a** drop the CHECK, **M12b** keep 0199's org index predicate, **M12c** drop the composite FK.
- **A13** the capped sentence is the same string for every capped person and contains no name, id, digit or time.
  **Kills M13:** interpolate the person's name.

## Done when
`npm run typecheck` clean; A1–A13 and the edited T-412 file green; T-395 files green unedited; `npm test` (journal
guards) green; migration proven on a scratch DB (ADR-012 §5 step 8); **FULL integration suite green on a fresh DB in CI**;
M1–M13 red then reverted; fresh audit closed; `/admin/users/[personId]` cap line + clear button screenshotted at 390 and
1280 on 9008; DEF-653 marked fixed in the register with the commit.

## Questions for Ian (Open Questions page)
1. **When does a capped person get unlocked?** (a) automatically 24 hours after it tripped, or sooner by an admin —
   recommended, nobody is stuck overnight; (b) only when an admin clears it — stricter, but a lone admin who mistypes is
   stuck until another admin acts.
2. **Should there also be a company-wide ceiling?** (a) no, per person only — recommended; a ceiling shared by everyone
   is exactly what lets one bad actor block everyone; (b) yes, e.g. 100 wrong approval PINs a day across the company.
3. **Is 10 wrong PINs a day per person right?** Recommended 10; say a number if you want it stricter or looser.
