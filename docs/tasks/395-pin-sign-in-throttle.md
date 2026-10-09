# T-395: PIN sign-in, the second tier: a daily guess budget per store, an attempt log, and a finding (DEF-063)

**Status:** SPECIFIED 2026-10-10 by the Opus planner. Lane L3, wave 1, size S (1.5 days, two slices).
Migration **0NNN (allocated at merge)**. One question for Ian (Q1); the recommended option is built.

## Goal

Close what DEF-063 still leaves open after T-303. A person at a store terminal must not be able to guess
PINs at a steady pace for a whole day without the system stopping them and telling a manager.

## Source

- `docs/plans/remaining-build-plan.md` §1 row C7 and §3.3 (T-395, L3, wave 1, S 1.5). The plan says
  *"no attempt log, no lockout"*. ⚠️ **That premise is half stale.** The lockout shipped in T-303
  (`58f198a`, migration `0147`, live since 2026-09-13). The attempt log and the finding are still missing.
- `docs/DEFECTS-REGISTER.md` DEF-063: still `reported`. Its disposition asks for a per-store and
  per-device throttle with a lockout, and says *repeated failed sign-ins at one terminal is a finding,
  not a log line*.
- `docs/tasks/303-pin-attempt-lockout.md` (the shipped tier 1) and `docs/tasks/304-two-layer-terminal-sign-in.md`
  (layer 1 authenticates the tablet; the PIN is typed inside that terminal session).

## Research

### What is already in the tree (verified 2026-10-10)

| Piece | Where | State |
|---|---|---|
| Tier 1: 10 misses in a 60 s window, then a 2-minute pause, per store | `packages/db/src/repo/pin-attempts.ts` (`MISS_THRESHOLD`, `MISS_WINDOW_SECONDS`, `LOCK_COOLDOWN_SECONDS`) | Shipped, tested (`packages/auth/tests/integration/terminal-sign-in.test.ts`), never field-proven |
| Check before lookup, flat failure sentence, constant-cost miss | `packages/auth/src/sessions.ts` `signInWithPin`, `BAD_PIN`, `DUMMY_SCRYPT_HASH` | Shipped |
| Server-attested terminal id | `resolveTerminalIdentity` returns `deviceId` = the terminal's `persons.id`; `apps/erp/src/app/sign-in/actions.ts:76-77` passes it | Shipped, **and then dropped**: the throttle ignores it |
| History of misses | none. `pin_attempt_throttle` holds only the current window, and `clearOnSuccess` wipes it | **Missing** |
| A finding | none in `packages/db/src/repo/findings.ts` | **Missing** |

### The hole tier 1 leaves (the reason this task is worth doing)

Tier 1 uses a **fixed** 60-second window that starts at the first miss. T-303 test 4b pins this as
intended: *nine misses, a pause past 60 s, nine more: never locked.* So a patient guesser at 9 misses a
minute is **never paused**. That is about **12,960 guesses a day** at one store.

A second bypass: **a correct PIN clears the store counter** (`clearOnSuccess`). Any staff member can type
9 guesses, sign in with their own PIN, sign out, and repeat.

What that buys an attacker: PINs are six digits (10^6). A guess succeeds if it hits the PIN of anyone
with scope at that store (T-302). With 30 such people, a day at 12,960 guesses gives
1 - e^(-12,960 x 30 / 10^6), **about 32 % chance of signing in as somebody**. Nobody is told, because
nothing is recorded.

### Industry pattern (OWASP Authentication and Credential Stuffing cheat sheets)

| OWASP practice | Our reading |
|---|---|
| Count failures per account **and** per source; lock or slow down | A failed PIN names **no account** (T-303 §per device). The source is the store's terminal, which is server-attested. Count per store, record per terminal |
| Do not let the lockout enumerate users (same message, same timing) | Already built (`BAD_PIN`, `DUMMY_SCRYPT_HASH`). The new log must not reintroduce it |
| Do not let an attacker lock legitimate users out (account-lock DoS) | Per-person lockout rejected (T-303). The breaker below stops PIN sign-in at one store, never email sign-in, and a manager can reopen it |
| Progressive or exponential lockout over a longer horizon | **Adopted as tier 2**: a rolling 24-hour budget per store, on top of tier 1 |
| Log and alert on failed authentication | **Adopted**: `sign_in_attempts` plus a finding in the OIL feed |
| Short secrets need throttling more than long ones | Six digits is short. That is why the daily budget matters more than the 60-second window |

**What we are NOT doing, and why:**

- **No CAPTCHA.** A cashier at 6 a.m. cannot solve one, and the attacker is a person at the counter anyway.
- **No IP-based limits.** There is no IP on this path that means anything. T-303 already found the
  `X-Forwarded-For` trap.
- **No per-person lockout.** A failed PIN identifies nobody, and per-person lockout would let anyone take
  a cashier off the till.
- **No per-terminal lock tier.** A PIN that works at a store works at every terminal there, so the budget
  that bounds the risk is the store's. A second, lower per-terminal threshold would only shrink the blast
  radius when a store has two or more tablets. **The log records the terminal**, so if a second tablet is
  ever disrupted by one attacker, the data to tune a device tier already exists.
- **No server-side sleep or exponential delay.** It holds a connection per attempt and an attacker can
  use that to tie up the server. A refusal is cheaper.
- **No org-wide breaker.** An attacker at four stores gets four budgets. That still bounds the risk to
  about 0.6 % a day at the numbers below, and it would need four visible people.
- **No longer PINs.** That is the real fix for keyspace, but it changes every staff member's habit and
  T-302's issuance. It is a separate decision.
- **No change to email sign-in.** Firebase throttles it.

## Rulings

| # | Ruling | Reason |
|---|---|---|
| R1 | **Tier 1 is unchanged.** 10 / 60 s / 2 minutes, per store, cleared by a correct PIN. Ian ruled it on 2026-09-13 | Fumble tolerance at a shift change. This task adds a tier; it does not re-tune the first |
| R2 | **Tier 2, the daily budget:** when a store reaches **50 misses in the rolling 24 hours** (counted since the last reopen, if that is later), PIN sign-in at that store is **stopped** | Bounds a store's guess budget to 50 a day: 50 x 30 / 10^6, **about 0.15 % a day**, down from about 32 %. Tier 1 alone allows about 13,000 |
| R3 | **A correct PIN does not reset tier 2.** Tier 2 counts rows in the log, and nothing on the success path deletes them | Closes the own-PIN reset bypass |
| R4 | **Stopped means stopped until a manager reopens it** (Q1 option a, built). Constant `STOP_AUTO_REOPEN_MINUTES = null`; option b sets it to `60` | A daily budget that refills on its own is a slower tier 1. A human looking is the point |
| R5 | **Who reopens:** anyone holding **`enrol_staff`** at that store (manager, admin, super_admin; not staff). **No new capability** | Same family as issuing a PIN. T-217 gated `issuePinAction` on `enrol_staff` for the same reason. §7 rule 2 is not widened: whoever can issue a new PIN at a store can already let a new person in |
| R6 | **The reopen is audited** with an `audit_log` row (bible §7 rule 7): action `reopen_pin_sign_in`, entity `store`, before `{stoppedAt}`, after `{reopenedAt}`, source `web` | Every mutation writes an audit row |
| R7 | **What the person sees.** Tier 1 keeps T-303's sentence. Tier 2 says: *"PIN sign-in is stopped at this store after too many wrong PINs today. A manager can reopen it: sign in with email and password, then open Staff."* Same text whoever types, whatever was typed | No enumeration. It names the way out, as T-303 §Q3 requires |
| R8 | **The log records only misses and state changes.** One row per miss, one `lockout` row when tier 1 starts a pause, one `stopped` row when tier 2 trips. **Successes are not logged here** (they are already `sessions` rows with `device_id`). **Refusals while paused or stopped are not logged** | Write volume is bounded by the throttle itself. A refused attempt is not a guess, because no lookup ran |
| R9 | **The log never holds the PIN, any hash or prefix of it, or whether the miss was "unknown" or "real person, wrong store"** | A table that managers can read must not become a guessing aid or the oracle that `BAD_PIN` refuses to be |
| R10 | **State lives in Postgres**: new table `sign_in_attempts` (`org_column`) and two columns on `pin_attempt_throttle` (`stopped_at`, `reopened_at`, plus `reopened_by`) | RULES §1 rule 4. It is written after layer 1, so the org is known and there is no pre-auth write (DEF-333) |
| R11 | **Retention: 90 days, purged lazily.** Each miss deletes this org's rows older than 90 days in the same transaction. **No new timer.** Cutover class `purge` | The rows carry no personal data (store, terminal, time). An org with no misses has no rows. An org whose last miss was long ago keeps old rows until its next miss. That is accepted and stated |
| R12 | **Two findings, both `soft`.** `pinSignInFailures` per (store, terminal) and `pinSignInStopped` per store. ⛔ **Never `hard`**: `closeReadiness` blocks a period close on hard findings, and a sign-in problem must not block the books | See §Contract |
| R13 | **Clock terminals are not in scope.** The clock tablet identifies a person by **badge or fingerprint, never a PIN** (`apps/erp/src/app/clock/page.tsx`). Offline punches go through the Firestore inbox. **PIN sign-in is a server action, so it cannot happen offline, and there is nothing to throttle offline.** Badge guessing at the clock is **not throttled by this task** and is not assessed here | Stated plainly so nobody assumes it is covered |

## Contract

### Repo (`packages/db/src/repo/pin-attempts.ts`)

```ts
export const DAILY_MISS_BUDGET = 50;          // R2
export const DAILY_WINDOW_HOURS = 24;
export const STOP_AUTO_REOPEN_MINUTES: number | null = null;  // R4; Q1 option b = 60
export const ATTEMPT_RETENTION_DAYS = 90;     // R11
export const FINDING_DAILY_MISSES = 20;       // finding bar, R12
export const FINDING_LOOKBACK_DAYS = 7;

export interface ThrottleStatus { locked: boolean; lockedUntil: Date | null; stopped: boolean; stoppedAt: Date | null }

checkThrottle(tx, storeId): Promise<ThrottleStatus>
// `stopped` is decided in SQL against now(), the same as `locked`. With STOP_AUTO_REOPEN_MINUTES
// non-null, stopped = stopped_at is not null and stopped_at + interval > now().

recordMiss(tx, { orgId, storeId, deviceId }: { orgId: string; storeId: string; deviceId: string | null })
  : Promise<{ lockStarted: boolean; stopped: boolean }>
// ONE transaction, in this order:
// 1. The existing tier-1 upsert, unchanged except `RETURNING locked_until`. A returned row with a
//    non-null locked_until means THIS statement started the pause (the WHERE guard returns no row
//    for a miss on an already-locked store).
// 2. insert sign_in_attempts (kind 'miss'), plus kind 'lockout' when step 1 started a pause.
// 3. update pin_attempt_throttle set stopped_at = now()
//      where store_id = $s and stopped_at is null
//        and (select count(*) from sign_in_attempts a where a.store_id = $s and a.kind = 'miss'
//             and a.occurred_at > greatest(now() - interval '24 hours', coalesce(reopened_at, '-infinity')))
//            >= DAILY_MISS_BUDGET
//      returning id
//    and when a row comes back, insert kind 'stopped'.
// 4. delete from sign_in_attempts where org_id = $o and occurred_at < now() - interval '90 days'.

clearOnSuccess(tx, storeId)   // unchanged: clears tier 1 only; never touches stopped_at

reopen(tx, storeId, actorPersonId): Promise<{ reopened: boolean; stoppedAt: Date | null }>
// update ... set stopped_at = null, reopened_at = now(), reopened_by = $actor,
//               fail_count = 0, window_started_at = null, locked_until = null
//   where store_id = $s and stopped_at is not null returning the old stopped_at.
// Not stopped: returns { reopened: false } and writes nothing.

statusForStore(tx, storeId): Promise<ThrottleStatus & { missesToday: number; reopenedAt: Date | null }>
```

### Auth (`packages/auth/src/sessions.ts`)

- `signInWithPin` checks `stopped` **first**, then `locked`, both before `runPinSignIn`. Stopped means
  `AuthenticationError(STOPPED_MESSAGE)` (R7). Nothing else changes in the order.
- Both `recordMiss` call sites pass `deviceId: input.deviceId ?? null`. `deviceId` stays optional in the
  signature. The production caller already passes it; changing it would mean editing about 60 test call
  sites in other tasks' files.

### Reopen (`packages/auth/src/credentials-admin.ts`, beside the other actor-gated credential functions)

```ts
reopenPinSignIn(tx: Tx, actor: Actor, storeId: string): Promise<{ reopened: boolean }>
// first statement: await authorize(tx, actor, 'enrol_staff', { storeId });
// then pinAttemptsRepo.reopen(...); on reopened, auditLogRepo.append(...) per R6. One transaction.
```

### Findings (`packages/db/src/repo/findings.ts`, spread in `packages/domain/src/findings/index.ts` `listFindings`)

| kind | key | fires when | severity |
|---|---|---|---|
| `pinSignInFailures` | `pinSignInFailures:{storeId}:{deviceId or 'none'}` | in the last 7 Manila days, some Manila day at that terminal had at least 20 misses, **or** at least one `lockout` | soft |
| `pinSignInStopped` | `pinSignInStopped:{storeId}` | `pin_attempt_throttle.stopped_at` is set (and, with auto-reopen, not yet expired) | soft |

Detail strings, in plain words. Failures: *"{n} wrong PINs at {terminal name} ({store}) on {date},
between {first} and {last}; it paused {k} time(s). A wrong PIN does not say who typed it. If this was not
a known mix-up, ask who was at the counter."* Stopped: *"PIN sign-in at {store} has been stopped since
{time} after {n} wrong PINs in a day. Nobody can sign in by PIN there until a manager reopens it on the
Staff page."* Times use `formatBusinessDateTime` (Manila), never a bare `toLocale*`.

Both key shapes end in a uuid or `none`, so `keyPeriod` returns null for them. Add labels to
`apps/erp/src/app/findings/lib.ts` `KIND_LABEL`: *"Repeated wrong PINs at a terminal"*, *"PIN sign-in stopped at a store"*.

### Screen (`apps/erp/src/app/staff/`)

A **PIN sign-in** panel on `/staff`, for the selected store, shown to anyone who holds `enrol_staff` there.
It shows one of three states: *Normal* (with today's miss count), *Paused until {time}* (tier 1), or
*Stopped since {time}* with a **Reopen PIN sign-in** button. The button posts `reopenPinSignInAction`
(`staff/actions.ts`), which runs `withOrgPrincipal` and `reopenPinSignIn`, then flashes *"PIN sign-in
reopened at {store}."* or the refusal. A refused or no-op reopen changes nothing.

## Invariants

| # | Invariant |
|---|---|
| I1 | Every T-303 invariant (1-8) still holds. T-303's tests stay green unedited, except mechanical signature updates |
| I2 | Stopped is checked before any credential lookup or KDF, and before tier 1 |
| I3 | Only `reopen` clears `stopped_at`. A correct PIN, a tier-1 expiry, and a new window never do |
| I4 | Tier 2 counts only `miss` rows, only in the last 24 hours, only since the last reopen |
| I5 | An unknown PIN and a real-person-wrong-store PIN write byte-identical `sign_in_attempts` rows (apart from `id` and `occurred_at`) |
| I6 | `sign_in_attempts` has exactly the columns in §Migration. No column can hold a PIN or its derivative |
| I7 | Exactly one `lockout` row per pause, and exactly one `stopped` row per stop, under concurrent misses |
| I8 | Both findings are `soft`. Neither can block `closeReadiness` |
| I9 | Reopen requires `enrol_staff` **at that store**, writes exactly one `audit_log` row, and is a no-op on a store that is not stopped |
| I10 | Every read and write runs under `withOrgPrincipal(orgId)`, never the auth door (DEF-333) |
| I11 | Email sign-in works while a store is stopped |

Tier 2 is approximate under concurrency. Two misses committing together may each see 49 and neither
trips. The next miss trips. The budget can overrun by the number of misses in flight at that moment. That
is accepted and stated.

## Slices

| Slice | BUILDER files | TESTER files | Size |
|---|---|---|---|
| **S1** log + tier 2 enforcement | `packages/db/migrations/0NNN_t395_sign_in_attempts.sql` (new), `packages/db/migrations/meta/_journal.json`, `packages/db/schema/sign-in-attempts.ts` (new), `packages/db/schema/pin-attempts.ts`, `packages/db/schema/index.ts`, `packages/db/src/rls/registry.ts`, `packages/db/src/cutover/classification.ts`, `packages/db/src/repo/pin-attempts.ts`, `packages/auth/src/sessions.ts` | `packages/auth/tests/integration/t395-pin-daily-budget.test.ts` (new); mechanical updates only in `packages/auth/tests/integration/terminal-sign-in.test.ts` (truncate list, `recordMiss` signature if called directly) and any shared reset helper that lists tables | 0.75 day |
| **S2** findings + reopen + panel + smoke | `packages/db/src/repo/findings.ts`, `packages/domain/src/findings/index.ts`, `packages/auth/src/credentials-admin.ts`, `packages/auth/src/index.ts` (export), `apps/erp/src/app/staff/{page.tsx,actions.ts,PinSignInPanel.tsx (new)}`, `apps/erp/src/app/findings/lib.ts`, `scripts/smoke-pin-throttle.ts` (new), `package.json` (`smoke:pin-throttle` script) | `packages/db/tests/integration/t395-sign-in-findings.test.ts` (new), `packages/auth/tests/integration/t395-reopen.test.ts` (new), `apps/erp/tests/integration/t395-reopen-action.test.ts` (new); `apps/erp/tests/t343-s6c-screen-labels.test.ts` only if its fixture list needs the two kinds | 0.75 day |

- **Disjoint paths.** BUILDER writes only the files in its column and never anything under `tests/`. TESTER
  writes only under `**/tests/**` and never `src/`, `schema/` or `migrations/`. S2 starts after S1 merges.
- **One Sonnet lane** (L3) is enough. Tester first, then builder, per slice.
- Out-of-list needs: stop and report. The orchestrator, not the lane, edits `docs/DEFECTS-REGISTER.md`
  (DEF-063), `PROJECT_BIBLE.md` §13 (a row for R2-R5, by the Opus planner at merge), `docs/ROADMAP.html`
  and the board.

## Tests (TESTER writes first; each red leg is shown red on HEAD or against the named mutant)

Integration tests run against real Postgres. Time is moved by back-dating rows with SQL (the T-303 tests'
own idiom), never by sleeping.

**S1, `t395-pin-daily-budget.test.ts`**

1. **Patient guesser is stopped.** 9 misses, roll the window (back-date `window_started_at`), repeated
   until 50 misses. The store is stopped, and the next attempt with the **correct** PIN is refused with
   the stopped sentence and **no credential lookup** (the malformed-PIN trick from T-303 test 1). Red on HEAD.
2. **Own-PIN reset does not refill the budget.** 49 misses with a correct sign-in between every 9, then one
   miss: stopped. *Mutant: `clearOnSuccess` deletes the store's log rows.*
3. **Only the last 24 h count.** Insert 49 `miss` rows at `now() - 25 hours`, then 1 real miss: not stopped.
   *Mutant: drop the time filter.*
4. **Only since reopen.** Stop the store, reopen, then 1 miss: not stopped. *Mutant: ignore `reopened_at`.*
5. **Only misses count.** 49 misses plus `lockout` rows, then 1 miss: stopped at exactly 50, not before.
   *Mutant: `kind` filter removed, which stops at fewer.*
6. **Success writes no log row; a refusal while paused or stopped writes no log row.** *Mutant: log on every call.*
7. **I5 parity.** An unknown PIN and a real-person-other-store PIN leave identical rows (compare every
   column except `id`, `occurred_at`).
8. **I6 shape.** `information_schema.columns` for `sign_in_attempts` equals the list in §Migration exactly.
   *Mutant: add a `pin_hint` column.*
9. **I7 concurrency.** 15 parallel misses from 0: exactly one `lockout` row. From 45 committed: exactly
   one `stopped` row. *Mutant: insert `lockout` whenever `locked_until` is non-null after the upsert.*
10. **Device attribution.** A miss through `signInWithPin(null, { ..., deviceId })` writes that `device_id`.
    *Mutant: `deviceId: null` hard-coded.*
11. **Retention.** A 91-day-old row in this org is gone after the next miss anywhere in the org. A 91-day-old
    row in **another org** is untouched. *Mutant: delete without `org_id`, which RLS also blocks, so also
    assert the delete runs under the principal.*
12. **I11.** Email sign-in succeeds while the store is stopped.
13. **RLS.** Under org B's principal, org A's `sign_in_attempts` rows are invisible and an insert with
    org A's id is refused.

**S2**

14. `t395-sign-in-findings.test.ts`: 19 misses in a Manila day at one terminal gives no finding; 20 gives
    one; 1 `lockout` alone gives one; rows 8 days old give none; two terminals give two keys; a stopped
    store gives `pinSignInStopped`, and after reopen it is gone. Both are `soft`, and `closeReadiness` is
    not blocked by them. *Mutants: `>` for `>=`; `hard`; a missing `org_id` filter.*
15. `t395-reopen.test.ts`: manager at the store reopens it, with one `audit_log` row, `reopened_by` set
    and the counters zeroed. **Staff role refused** (the ✗ fires). **Manager scoped to another store refused.**
    Reopen of a store that is not stopped writes nothing (no audit row). *Mutant: authorize removed;
    authorize without `storeId`.*
16. `t395-reopen-action.test.ts`: the action takes the actor from the session (not the form), uses
    `storeId` only as the resource, and flashes the result. The existing `no-client-supplied-actor`
    and `t342-no-null-tx-from-actions` guards stay green.

## Migration — 0NNN (allocated at merge)

Hand-authored per ADR-012 §5. `db:generate` is retired. The `_journal.json` `when` must exceed the
previous entry's. No applied migration is edited.

```sql
CREATE TABLE "sign_in_attempts" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "store_id" uuid NOT NULL REFERENCES "stores"("id") ON DELETE RESTRICT,
  "device_id" uuid REFERENCES "persons"("id") ON DELETE RESTRICT,  -- the terminal's persons row; null only for a caller with no terminal
  "kind" text NOT NULL CHECK ("kind" in ('miss','lockout','stopped')),
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "sign_in_attempts_store_time_idx" ON "sign_in_attempts" ("store_id", "occurred_at");
CREATE INDEX "sign_in_attempts_org_time_idx" ON "sign_in_attempts" ("org_id", "occurred_at");
ALTER TABLE "sign_in_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sign_in_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sign_in_attempts_org_isolation" ON "sign_in_attempts"
  USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());

ALTER TABLE "pin_attempt_throttle" ADD COLUMN "stopped_at" timestamp with time zone;
ALTER TABLE "pin_attempt_throttle" ADD COLUMN "reopened_at" timestamp with time zone;
ALTER TABLE "pin_attempt_throttle" ADD COLUMN "reopened_by" uuid REFERENCES "persons"("id") ON DELETE RESTRICT;
```

The statement-breakpoint markers and FK constraint names follow `0147`'s style. Registry:
`sign_in_attempts: { scope: 'org_column', reason: 'A sign-in attempt happens at a store terminal after layer 1, so its org is known; never a pre-auth write (DEF-333).' }`.
Classification: `purge`, with the same reason as `pin_attempt_throttle`: attempt history from December has
no business in January's ledger.

## Smoke (§9.4)

**What can be exercised locally, and how.** SMOKETEST.md §3 explains that layer 1 (the Firebase ID token
in the tablet's browser) cannot be faked from a script. Everything after the token check can be:

1. `make-test-dbs` gives `shareat_test_setup`. Then `bootstrap-org --store-code=SMK --pin=246810 --confirm`.
   Then `npm run provision-terminal -- --store=SMK --uid=smoke-terminal --confirm`. This creates a real
   terminal person and credential; the uid is never verified because Firebase is not called.
2. `npm run smoke:pin-throttle -- --uid=smoke-terminal --good-pin=246810 --misses=50` (new script; it
   refuses any database without `_test`). It calls the real `resolveTerminalIdentity(null, uid)`, then
   the real `signInWithPin(null, ...)`. Phase A: 10 misses in a row, then one more attempt, which gets
   the pause sentence; then it waits out the 2-minute pause once. Phase B: misses with the correct PIN
   after every 9th, so tier 1 never pauses, until 50 misses in total. It prints the throttle row, log
   counts by kind, `stopped_at`, and the sentence each attempt got. Expected: one `lockout` row, the
   own-PIN resets do not help, stopped at the 50th miss, and the correct PIN then refused with the
   stopped sentence.
3. Forge an admin session (SMOKETEST §3) and serve on 9008. `/findings` shows both new findings with their
   labels and terminal name. `/staff?store=<SMK>` shows *Stopped since {time}*. Press **Reopen**: the flash
   appears, and the panel shows *Normal*. Screenshot at 375 and 1366 px, light and dark.
4. Run the script again with `--misses=0`: the correct PIN signs in.

**Unmet locally, stated plainly:** the tablet's own screen after a wrong PIN, which needs a real Firebase
terminal account. That path is unchanged in shape: the sentence travels through the same
`preSessionMessage`, the same as T-303's. **Post-deploy field check (out of hours, at Lipa's real
tablet):** 10 wrong PINs show the pause sentence with a Manila clock time. This also field-proves T-303,
which has never run in the field. Do not trip tier 2 in production; the local smoke covers it.

## Out of scope

- Re-tuning tier 1 (R1). A per-terminal lock tier, an org-wide breaker, CAPTCHA, IP limits, longer PINs,
  and email-path throttling (§Research).
- Badge or fingerprint guessing at the clock terminal (R13).
- Excluding these two kinds from the manager scorecard. A failures finding that ages out after 7 days
  counts as "cleared" for that store's manager. That is a small distortion, and it is accepted.
- A screen listing the raw attempt log. The finding and the panel are the surfaces; the table is for
  queries.
- Notifying anyone by SMS or email when a store is stopped.

## Done when

- S1 and S2 are merged. Tests 1-16 are green, and every named mutant was shown red. T-303's tests are green.
- Typecheck is clean. The affected unit and integration tests pass locally. The full suite passes in CI on
  the PR. `npm run build` passes with the dev server stopped.
- The migration is hand-authored. `sign_in_attempts` is classified in both `registry.ts` and
  `classification.ts`, and the build's classification guards pass.
- The smoke steps 1-4 ran, with output and screenshots in the hand-back, and the unmet part is named.
- The hand-back carries a `FOR IAN` block. The orchestrator moves DEF-063 to `fixed` (T-303 tier 1 plus
  T-395 tier 2, the log and the finding), corrects plan row C7's stale *"no lockout"*, and asks the Opus
  planner for the bible §13 row covering R2-R5.

## Questions for Ian

**Q1. When too many wrong PINs are typed at a store in one day, what should happen?**
Example: someone at the counter types wrong PINs slowly, 9 a minute, so the 2-minute pause never starts.
By the 50th wrong PIN that day:

- **(a) PIN sign-in at that store stops until a manager reopens it** from the Staff page, after signing in
  with email. A finding tells you which tablet and when. **Recommended, and built.** It caps guessing at
  about 50 a day per store, roughly a 1-in-700 chance of hitting someone's PIN, instead of about 1-in-3.
  The cost: if it trips before opening time, the cashier waits for a manager.
- **(b) The same, but it reopens by itself after 60 minutes.** No manager needed. Guessing is capped at
  roughly 50 an hour instead of 50 a day.
- **(c) No stop; only the finding.** Nothing is blocked. You find out the next time someone opens Findings.

The number 50 is a starting point. Today nobody records wrong PINs, so nobody knows how many honest
mistakes a busy store makes in a day. The log will show it within two weeks, and the number is one constant.
