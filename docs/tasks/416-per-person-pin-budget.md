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

**The limits (one named block in `pin-attempts.ts`):** `APPROVAL_DAILY_MISS_CAP = 5` misses per person in a rolling
24 h (**Ian, 2026-10-16**). An admin types their PIN a few times a day; 5 wrong is past fat-fingering. **The real
company-wide bound** is 5 × (the number of signed-in people who can reach a Tier P action — i.e. hold that action's
capability) guesses a day, each guess matching any of the k administrators' PINs; no company-wide cap on top (Ian, Q2).
**Tier 1 (the 60 s pause) needs no option:** its threshold is 10 per 60 s (`:18`), and step 2's daily check (cap 5)
runs before it, so an actor bucket is stopped long before tier 1 could fire — no `lockout` row is ever written for it.
Say so in a comment beside the constant; if either number is re-tuned so that tier 1 could fire first, that comment
is the tripwire (its "this terminal" sentence would be wrong for a person).
**Reset semantics.** The existing budget is a **rolling 24 h window, not a Manila calendar day** (`:96-97`), and Ian's
business day ends at store closing time (bible row 348) — a person spans stores with different closings, so a calendar
or business-day reset has no single right midnight and lets 5 at 23:59 plus 5 at 00:01 through. So: the same
rolling 24 h window, and a capped person **auto-lifts 24 h after the cap tripped** (`chargeAttempt`'s existing
`stopAutoReopenMinutes` option = `APPROVAL_CAP_AUTO_LIFT_MINUTES = 1440` for this bucket), or earlier when an
administrator clears it (**Ian, 2026-10-16, Q1**).

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
- EVERY actor-bucket row (`miss`, `stopped`; `lockout` cannot occur, above) carries `actor_person_id`, so "who guessed how often" is
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
  { actor: string }` in `chargeAttempt`, `refundOnSuccess`, `clearOnSuccess`. Every per-bucket SQL fragment gets three arms:
  - **row filter** `bucket(col)` (`:70-74`): store `store_id = $s` (unchanged) · org `org_id = $o and store_id is null
    and actor_person_id is null` (⛔ the new `and actor_person_id is null`, else the org bucket counts every person's
    misses) · actor `org_id = $o and actor_person_id = $p`.
  - **ON CONFLICT** (`:74`): store `on conflict (store_id)` (unchanged) · org `on conflict (org_id) where store_id is null
    and actor_person_id is null` · actor `on conflict (org_id, actor_person_id) where actor_person_id is not null`. ⛔ After
    0200 narrows the 0199 index, today's `on conflict (org_id) where store_id is null` no longer matches any index and
    Postgres raises (42P10) — the predicate must match the index exactly.
  - **inserts**: the lock upsert (`:78-79`) and all three `sign_in_attempts` inserts (`:108,141,148`) write
    `actor_person_id` (NULL for store/org buckets).
  - `chargeAttempt` opts gain `dailyMissBudget` (default `DAILY_MISS_BUDGET`). No `tier1` option (see "The limits").
- New `resetActorCap(tx, orgId, personId, byPersonId)` (shape of `reopen`, `:195-211`) and `statusForActor(tx, orgId,
  personId)`. ⛔ Both apply the **auto-lift rule** (`stopped_at + 1440 min > now()`), unlike `reopen` (any non-null
  `stopped_at` counts as stopped, `:204-205`) and `statusForStore` (constant `null` auto-lift, `:244`): a cap that has
  auto-lifted reads "not capped" and a clear of it is a no-op that writes nothing. Pass the minutes in, one constant.
- `sessions.ts`: `runChargedPinLookup` takes the `Bucket`; `signInWithPin` passes `{ store }` (behaviour identical).
  A `stopped` charge on an actor bucket throws `APPROVAL_PIN_CAPPED`, never `STOPPED_MESSAGE`.
- `admin-approval.ts`: charge `{ actor: actor.personId }` with `{ dailyMissBudget: APPROVAL_DAILY_MISS_CAP,
  stopAutoReopenMinutes: APPROVAL_CAP_AUTO_LIFT_MINUTES }`. `storeId` stays in the signature (it still scopes the
  row-196 `can` fallback); the 30 callers in `apps/erp/src/app` do not change. The 0199 org-bucket arm is no longer
  reached by approvals; keep it (harmless; no other caller is touched).
- `credentials-admin.ts`: `resetApprovalPinCap(tx, actor, personId)` — `authorize(…, 'manage_users')`, refuse self,
  repo reset, audit row only when something was cleared; export from `packages/auth/src/index.ts`.
- Stray comments that say "migration 0198" for what is 0199 (`schema/pin-attempts.ts:26,42`,
  `schema/sign-in-attempts.ts:23`, `repo/pin-attempts.ts:68`, `sessions.ts:105`): correct to 0199 while editing these files.

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
and are deliberately superseded**: I2c becomes "the miss is on the actor's bucket and on NO store"; I6 (which killed
T-412's M7, skip `refuseIfCharged`) moves under **A2**; I11 (and its mutant M12) is inverted to A4. Every other T-412
case stays green unedited.
**Unedited and green:** `packages/auth/tests/integration/t395-pin-daily-budget.test.ts`, `t395-reopen.test.ts`,
`terminal-sign-in.test.ts`, `packages/db/tests/integration/t395-*.test.ts` — sign-in behaviour does not change.

## Acceptance cases (each names the mutant it kills; every mutant shown red, then reverted)
- **A1** one wrong approval writes one `miss` with `actor_person_id` = actor and `store_id` NULL; the record's store has
  0 miss rows. **Kills M1:** charge `{ store: storeId }` as before.
- **A2** 5 misses in 24 h, then the 6th attempt — the admin's CORRECT PIN — reads `APPROVAL_PIN_CAPPED` with zero
  lookups; exactly one `auth.approval_pin_capped` row exists; and EVERY `sign_in_attempts` row written (5 `miss`, 1
  `stopped`) and the throttle row carry `actor_person_id` = actor, none a `store_id`. **Kills M2** cap read as
  `DAILY_MISS_BUDGET` (50); **M2b** skip `refuseIfCharged` (T-412's M7, carried over from I6); **M2c** the `stopped`
  insert omits `actor_person_id`.
- **A3** with the actor capped, a cashier's correct PIN signs in at that store; the store is neither paused nor stopped.
  **Kills M3:** also charge the store bucket.
- **A4** 3 wrong approvals on a store-A record + 2 on a store-B record cap the person (no N × cap). **Kills M4:** key
  the bucket on (actor, store).
- **A5** actor P capped; actor Q in the same org approves with the admin's PIN. **Kills M5:** drop
  `actor_person_id = $` from the actor filter (any person's misses count).
- **A6** the org bucket never counts actor misses: seed **50** actor-bucket `miss` rows in the last hour (spread over
  several persons), then one org-bucket charge (`storeId: null` path) is NOT stopped, and the org bucket's own miss count
  read directly is 1. **Kills M6:** omit `and actor_person_id is null` from the org arm (50 ≥ `DAILY_MISS_BUDGET` trips it).
- **A6b** an org-bucket charge and an actor-bucket charge in the same org both succeed on a migrated DB (no 42P10, no
  unique violation). **Kills M6b:** leave the org `on conflict (org_id) where store_id is null` unchanged.
- **A7** 5 misses 25 h old do not cap. **Kills M7:** window 48 h.
- **A8** cap tripped 24 h + 1 min ago, no reset: the next correct approval succeeds. **Kills M8:** `stopAutoReopenMinutes`
  null for the actor bucket.
- **A9** 10 correct approvals leave 0 miss rows for the actor; the next wrong one is a plain `ADMIN_PIN_REFUSED`.
  **Kills M9:** skip `refundOnSuccess` for the actor bucket.
- **A10** `tx = null` path: a wrong approval's miss row survives the throw. **Kills M10:** charge inside the lookup tx.
- **A11** clear: an admin clears P's cap -> P approves again, one `reset_approval_pin_cap` row (admin, P, before/after);
  a manager is refused (`manage_users`); P clearing their own cap is refused; clearing an uncapped person writes nothing;
  **a cap that auto-lifted (tripped 24 h + 1 min ago) reads "not capped" in `statusForActor`, and clearing it is a no-op
  with no audit row.** **Kills M11a** drop the `authorize`, **M11b** drop the self check, **M11c** audit on a no-op,
  **M11d** `resetActorCap`/`statusForActor` treat any non-null `stopped_at` as capped (the `reopen` shape).
- **A12** schema: a row with both `store_id` and `actor_person_id` is rejected; a second throttle row for the same
  (org, person) is rejected; two different persons in one org both get buckets; a person of another org is rejected by
  the same-org FK. **Kills M12a** drop the CHECK, **M12b** keep 0199's org index predicate, **M12c** drop the composite FK.
- **A13** the capped sentence is the same string for every capped person and contains no name, id, digit or time.
  **Kills M13:** interpolate the person's name.

## Done when
`npm run typecheck` clean; A1–A13 and the edited T-412 file green; T-395 files green unedited; `npm test` (journal
guards) green; migration proven on a scratch DB (ADR-012 §5 step 8); **FULL integration suite green on a fresh DB in CI**;
every named mutant red then reverted; fresh audit closed; `/admin/users/[personId]` cap line + clear button screenshotted at 390 and
1280 on 9008; DEF-653 marked fixed in the register with the commit.

## Ian's answers (2026-10-16)
1. Unlock: automatically 24 h after the cap tripped; an administrator may clear it sooner.
2. No company-wide cap.
3. Cap = **5** wrong administrator PINs per person per rolling 24 h.
