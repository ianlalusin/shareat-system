# T-237 — DEF-224: a Firebase credential's lifecycle after it is linked

> **Status**: ✅ **APPROVED 2026-09-08 (orchestrator, all three slices) and BUILT.** typecheck clean ·
> unit 73 files, 1138 passed / 1 skipped · integration 55 passed across the four suites that touch
> `person_credentials`, of which 12 are new. §12 is the as-built delta — read it before the spec, it
> records the one deviation that matters (the index names did **not** change) and the third defect
> this work uncovered.
>
> _(Original header, kept: **SPEC — lane D, 2026-09-08. Written before any code.**)_
>
> Closes **DEF-224** (`docs/DEFECTS-REGISTER.md:297`), found by the Opus reviewer of T-232 slice 1.
> ⚠️ **Two things in this spec are more than the register asked for**, both flagged with ⛔ and both
> the orchestrator's call: §3 (a second, unreported defect in the same index family, entangled with
> part 1 — the same migration) and §5.4 (one lockout guard). Everything else is the register's own
> three parts.
>
> ⭐ **I am the migration lane. This task holds migration `0137` and no other lane gets a slot
> while it is open.**
>
> **Lane boundary (orchestrator, 2026-09-08).** Every path this task writes to is inside lane D's
> own: `packages/db/schema/`, `packages/db/migrations/`, `packages/auth/`,
> `apps/erp/src/app/admin/users/` and their tests. ⭐ **It needs nothing under
> `apps/erp/src/app/sign-in/**` or `apps/erp/src/app/setup/**`** — lane B's while DEF-222 is open —
> and that is a property of the design rather than a lucky accident: the sign-in path reads
> `person_credentials` through `findActiveCredentialByExternalId`, whose signature and semantics do
> not change here (§2.4). Two paths outside the list are **requested, not assumed**: a one-comment
> edit to `packages/domain/src/organizations/index.ts` (§7 slice A — it names the index by its old
> name) and `docs/ops/README.md` (§6). Both are sequencing requests for the orchestrator.

---

## Goal

**A Firebase account that was linked can be unlinked, and a uid that was unlinked can be linked
again.** Today neither is true: there is no screen, and the database refuses the re-link. And
unlinking must end that person's live sessions, because a credential that no longer signs anyone in
while its 7-day session keeps working is a revocation in name only.

---

## 1. What the register says, and what I verified before writing this

| Claim (DEF-224) | Verified | Where |
|---|---|---|
| `person_credentials_external_id_unique` is a PLAIN unique index, not partial on `revoked_at is null` | ✅ | `packages/db/schema/sessions.ts:94` · created `packages/db/migrations/0018_t138_identity_sessions.sql:49` |
| So a revoked uid can never be re-linked — the re-insert hits `23505` | ✅ by reading, **not yet by execution**; §8 case 1 is that proof, written to fail first | `packages/db/src/repo/sessions.ts:119` inserts unconditionally |
| No screen unlinks a Firebase credential | ✅ | `sessionsRepo.revokeCredential` (`repo/sessions.ts:136`) has **zero production callers** — only `packages/auth/tests/integration/sessions.test.ts:262,285`. `/admin/users` writes roles, scopes and grants only (`apps/erp/src/app/admin/users/actions.ts`) |
| Revoking the row does not end sessions already issued | ✅ | `revokeCredential` touches `person_credentials` only; nothing calls `endAllForPerson` after it |
| `verifyIdToken` runs without `checkRevoked`, and `signInWithFirebase` mints a 7-day session | ✅ | `apps/erp/src/lib/firebase-auth-admin.ts:97` · `BROWSER_SESSION_TTL_MS` = 7 days, `packages/auth/src/sessions.ts:32` |
| The same index stops one Firebase account linking to a **second organisation** | ✅ that it stops it — ⛔ **but see §2.3: this task deliberately does not enable it, and the register's framing invites the wrong fix** | — |

---

## 2. Part 1 — the index

### 2.1 What it is now

```ts
// packages/db/schema/sessions.ts:94
uniqueIndex('person_credentials_external_id_unique').on(t.externalId),
```

Plain, over the whole table. `external_id` is NULL for `pin` and `biometric` rows, and Postgres
treats NULLs as distinct, so PIN rows never collide with each other here — the index constrains
`firebase` rows only, which is why nothing has tripped it yet.

### 2.2 What it becomes, and why this exact shape

```ts
uniqueIndex('person_credentials_external_id_live_unique')
  .on(t.externalId)
  .where(sql`${t.revokedAt} is null and ${t.externalId} is not null`),
```

⭐ **Not a new idea — the same table family already learned this lesson.**
`packages/db/schema/attendance-credentials.ts:110-118` carries
`attendance_credentials_card_live_unique` and `..._token_live_unique`, both partial on
`revoked_at is null`, with the comment *"a **revoked** card id may be reissued, which is what makes
revocation reversible in practice."* `person_credentials` is the older table and never got the
treatment. This change makes the two consistent, down to the `_live_unique` naming, rather than
inventing a shape.

⚠️ **The `external_id is not null` half of the predicate is not redundant.** It is what keeps the
index small and, more importantly, what makes the index's *name* true: it is the live-firebase-uid
index, not "every row that happens to have a null external id".

### 2.3 ⛔ What this deliberately does NOT enable — one uid in two organisations

The register mentions, in the same breath, that this index *"stops one Firebase account linking to a
second organisation (a franchise owner across two orgs)"*. **A partial-on-`revoked_at` index does
not change that, and this task must not be read as opening it.** Two *live* rows with the same
`external_id` still collide, which is correct, because:

`packages/db/src/repo/sessions.ts:60-78` — `findActiveCredentialByExternalId` ends with `const [row]
= await tx.select(…)`: **one row, whichever Postgres returns first, with no `order by`.** It runs at
sign-in inside `apps/erp/src/app/sign-in/actions.ts`' plain `transaction()` — the owner connection,
where RLS does not apply — so with two live rows it would not even see an ambiguity. It would sign
the franchise owner into an arbitrary one of their two organisations, differently on different days,
with no error anywhere.

⛔ So multi-org linking is **out of scope (§10)** and needs its own task: the sign-in path would
first have to learn to *resolve* an org (a chooser, or a per-org sub-domain), and only then may the
index widen. Written down here because the register's sentence reads like a second half of this fix,
and building it would produce exactly the silent, non-deterministic misrouting bible §13 row 112
calls the worse of the two identity failures.

### 2.4 Every reader of `external_id`, and why none of them breaks

`grep -rn "externalId\|external_id"` over `packages`, `apps`, `scripts`, `tests` — the complete list
of non-test hits:

| File:line | What it does | Effect of the change |
|---|---|---|
| `packages/db/src/repo/sessions.ts:76` | `findActiveCredentialByExternalId` — `where external_id = $1 and revoked_at is null` | ⭐ **None, and it gets faster.** It already filters on `revoked_at is null`, so the new partial index is precisely the index this query wants |
| `packages/db/src/repo/sessions.ts:128` | `insertCredential` — writes `externalId ?? null` | The write it used to refuse now succeeds. That is the fix |
| `packages/db/src/repo/sessions.ts:50,72,109` | `external_id` selected into `CredentialRow` | None — a projection |
| `packages/domain/src/organizations/index.ts:348,356` | `bootstrapOrganization` links the first admin's uid; its comment cites the index by its **old name** | ⚠️ Comment must be updated with the rename — §7 lists the file for that reason and no other |
| `apps/erp/src/lib/firebase-auth-admin.ts:56` | a doc comment | None |

**Raw SQL swept, per the standing rule** (memory: *grep raw SQL before dropping a column* — a
rename is the same hazard, since typecheck sees only builder references):
`grep -rn "external_id" packages/db/migrations/*.sql` returns `0018` lines 8, 16, 17 and 49 — the
column, the two halves of `person_credentials_shape_check`, and the index creation. **No raw-string
query anywhere in the codebase names `external_id` or the index.** Nothing reads the index by name
except the migration that created it.

⚠️ **A non-zero control for that sweep**, because a sweep that matches nothing exits 0 and looks
clean: the same grep over `person_credentials` returns 20+ hits in the same files, so the pattern and
the paths are right and the narrow result is a real absence.

---

## 3. ⛔ Found in passing (row 164) — the SAME defect, one index over, plus a live security hole

**`person_credentials_lookup_hash_unique` (`schema/sessions.ts:93`, migration `0018:48`) is also a
plain unique index**, and the PIN path has the mirror of DEF-224 — with a second, worse bug beside
it. Both verified by reading `setPin` (`packages/auth/src/sessions.ts:260-288`) and its three
callers.

### 3.1 A re-issued PIN never retires the old one

`setPin` checks `findActiveCredentialByLookupHash` (which filters `revoked_at is null`), refuses only
when the live row belongs to **someone else** (`:273`), inserts a new `pin` row (`:276`), then calls
`endAllForPerson(trx, personId, 'superseded', storeId)` (`:283`).

⛔ **It ends the SESSIONS and never revokes the CREDENTIAL.** The old row keeps `revoked_at = null`,
so `signInWithPin` still finds it by its own lookup hash and its own bcrypt compare still passes:
**the previous PIN goes on signing that person in forever.** No caller compensates —
`apps/erp/src/app/staff/actions.ts:197` (`issuePinAction`), `packages/domain/src/organizations/index.ts:341`
(the bootstrap) and `scripts/dev-seed.ts:165` all call it bare. The word *"superseded"* in that call
is what makes it read correct.

### 3.2 Re-issuing the SAME six digits raises a raw `23505`

The pre-check passes for the same person (`taken.personId !== input.personId` is false), so the
insert runs with a lookup hash the person's own live row already holds → unique violation → the
transaction aborts and `issuePinAction` shows a driver error. *"Re-type the PIN you already have"* is
not an exotic input on a screen an owner uses.

### 3.3 ⭐ Why this belongs in THIS task's migration, not a later one

The two halves are entangled, and fixing §3.1 alone makes §3.2 **worse**: once `setPin` revokes the
old row before inserting, the revoked row still holds that lookup hash, and a plain unique index
refuses the re-insert exactly as it does today — so *changing your PIN back to a previous one* would
start failing for everybody, not just for the same-digits case. **The partial index is a
prerequisite for the logic fix, and it is one line in the migration this task already owns.** The
alternative is a second migration against the same table for the same defect class, in a later task,
by whichever lane holds the slot then.

**Requested:** the migration covers **both** indexes, and slice C fixes `setPin`. If the
orchestrator prefers the PIN half deferred, say so on approval — slice A's `lookup_hash` line and
slice C come out together and slices A(firebase half) and B stand unchanged. ⛔ What must not happen
is the index change without the logic fix: that would leave §3.1's hole open while removing the
error that currently makes §3.2 visible.

---

## 4. Part 2a — how "unlink ends that person's sessions" is done today

**It already exists, it is already named for this, and it has never been called.**

```ts
// packages/db/src/repo/sessions.ts:241 — "The shift-end path, and the revoke-a-credential path.
//                                        Returns the count so a caller can say '3 sessions ended'."
export async function endAllForPerson(
  tx: Tx, personId: string, reason: SessionEndReason, storeId?: string,
): Promise<number>
```

`SessionEndReason = 'signed_out' | 'shift_end' | 'revoked' | 'superseded'` (`repo/sessions.ts:15`).
Its two live callers are `endShift` (`packages/auth/src/sessions.ts:243`, `'shift_end'`) and `setPin`
(`:283`, `'superseded'`).

⭐ **`'revoked'` is in the enum and nothing has ever passed it.** T-138 designed the reason for this
path and the path was never built. So unlink **reuses** `endAllForPerson(tx, personId, 'revoked')` —
no new function, no second way to end a session, and the `sessions.ended_reason` column starts
carrying the value it was defined for. (Memory: *"t-done" can mean ZERO callers* — this is the first
caller, and §8 case 4 is its first execution.)

⚠️ **Person-wide, not credential-scoped, and that is deliberate.** `endAllForPerson` has no
`credentialId` filter. Unlinking one credential ends *every* live session for that person, including
a PIN session at a terminal. That is the correct blast radius for the situation the defect
describes — *"this person's account is compromised or they have left"* — and narrowing it would need
a new repo function, i.e. exactly the second path the orchestrator asked me not to add. **Stated so
the screen can say it out loud** (§5.3).

---

## 5. Part 2b — the screen

### 5.1 Where it goes

`/admin/users/[personId]` (T-219) is the per-person access screen and already renders role, store
scope and capability grants from `userDetail()`. Sign-in accounts belong on the same page: it is the
one place an administrator already answers *"what can this person do, and how do they get in?"*.

The model to copy is `apps/erp/src/app/staff/[employmentId]/credentials/` (attendance cards and
fingerprints): a list of live credentials, a revoke control per row with a reason, and a thin action
that calls one gated domain function. `apps/erp/src/app/staff/lib.ts:75` already reads
`sessionsRepo.listLiveForPerson` for that screen's live-session count, so the read has a precedent
too.

### 5.2 The gate

`authorize(tx, actor, 'manage_users', {})` — org-scoped, `super_admin` and `admin` only
(`packages/auth/src/capabilities.ts:482,688`), the same capability `setStoreScopeAction` uses
(`admin/users/actions.ts:109`). ⛔ Not `enrol_staff`: that is store-scoped and matrix-true for
`manager` (`:687`), and a manager linking a Firebase account to a person is granting **office**
access to the whole organisation's books.

⛔ **The gate lives in the domain function, not in the action** — `admin/users/actions.ts:10-15`
states the rule and DEF-180 is what happens when a route file owns a rule: *"a rule in one route file
is a rule the next route file misses."*

### 5.3 What the screen shows and says

A **Sign-in accounts** section listing live credentials for the person (`listLiveForPerson`), each
row: kind (`PIN — <store>` / `Email (Firebase)`), when it was created, and for `firebase` an
**Unlink** control. Below it, one sentence of consequence, because the blast radius in §4 is wider
than the button implies:

> Unlinking signs this person out everywhere, including terminals, and the account can be linked
> again later.

And a **Link an email account** control: one field, the Firebase uid, with the sentence *"from the
Firebase console — this is not an email address."*

⚠️ **Linking takes a uid, not an email, and the spec is choosing that on purpose.** Resolving an
email to a uid needs `getUserByEmail`, which is an **authenticated** Admin SDK call and therefore a
service-account credential — the one thing `firebase-auth-admin.ts` is documented as not needing
(T-232 decision 2). Making `/admin/users` depend on `FIREBASE_SERVICE_ACCOUNT_KEY` would put a
credential on the identity path that today has none, and would break the screen on any deployment
where storage is unconfigured. A uid pasted from the console is one extra step for the administrator
and costs the deployment nothing. ⛔ **Overrule this on approval and it becomes a lookup** — it is
~15 lines and one more env dependency, and I would rather be told than assume.

### 5.4 ⛔ One guard, and one guard only — the last way in

Unlinking your own credential is **allowed**: it narrows your own authority, and
`packages/auth/src/roles.ts:339-343` already ruled on that shape — *"revoking your own grant is
self-demotion: it narrows authority, so it cannot escalate, and refusing it would stop someone
dropping a capability they no longer want to hold."* You are simply signed out immediately, which is
honest.

**But one case is not self-demotion, it is an organisation losing its only door:** unlinking the
**last live credential** of the **last active admin**. Nobody can then sign in at all — the recovery
is a shell on the droplet and `scripts/bootstrap-org.ts`' database posture, which is Ian at a laptop
on a Sunday. So:

> ⛔ Refused when the target person holds no other live credential **and** is the organisation's only
> active `admin`. Message: *"This is the last way into this organisation. Give someone else an admin
> role, or issue this person a PIN, before unlinking it."*

`accessRepo.activeAdminPersonIds(orgId)` (`packages/db/src/repo/access.ts:212-224`) already answers
the second half; `listLiveForPerson` answers the first. Two reads, one condition, one test.

⚠️ **Deliberately NOT guarded**: unlinking a non-last credential, unlinking someone else's, or
unlinking the last credential of a *non-last* admin. Each of those is recoverable from the screen by
somebody who is still signed in, and a guard that fires on recoverable cases is a guard people learn
to route around.

---

## 6. Part 3 — the seven-day window, and what to write about it

The register's part 3 said *"state the seven-day consequence in `docs/ops` until (2) exists."* (2)
exists as of this task, so the ops note changes from a warning into a procedure:

> **To cut off a person's access:** unlink their email account on `/admin/users/<person>`. That ends
> their live sessions immediately. ⛔ **Disabling the account in Firebase alone does not.** v2 checks
> the Firebase token only at sign-in; the session it mints then is its own, and lives up to seven
> days. Firebase's console stops the *next* sign-in, not the current session.

⛔ **`checkRevoked: true` is not the answer and this spec declines it.** It would need a
service-account credential on the identity path (§5.3), it costs a network round-trip per sign-in,
and — decisively — it only hardens the *sign-in* moment. A session already issued is never
re-verified against Firebase, so the seven-day window it is supposed to close stays exactly as wide.
The control is unlink; the honest documentation of that is the fix. ⚠️ Shortening
`BROWSER_SESSION_TTL_MS` is also declined here: it is a change to every office user's day for a case
that now has a direct control, and it belongs to whoever revisits session policy, not to this task.

---

## 7. Slices, and the exact files

### Slice A — the migration and the schema (⭐ the only migration slot open)

| Path | Change |
|---|---|
| `packages/db/schema/sessions.ts` | both `uniqueIndex` calls → partial `_live_unique` forms |
| `packages/db/migrations/0137_def224_credential_live_unique.sql` | **new file.** `drop index` ×2, `create unique index … where …` ×2 |
| `packages/db/migrations/meta/_journal.json` | `idx: 137`, `when: 1797910307084` (= 0136's `1797823907084` + 86 400 000, the file's own spacing) |
| `packages/db/migrations/meta/0137_snapshot.json` | as generated |
| `packages/domain/src/organizations/index.ts` | **one comment only** — it names the old index (`:348`) |

⚠️ **A new migration file, never an edit of an applied one**, and `when` tracks `idx` — a reserved
number block must reserve timestamps too, or Drizzle silently skips one and the index never lands
while everything reports success.
⚠️ **No table is added**, so `packages/db/src/cutover/classification.ts` and
`packages/db/src/rls/registry.ts` are untouched. `person_credentials` is already registered
(`registry.ts:344`, `scope: 'derived'` via `persons.org_id`) and an index change does not touch a
policy. **Both files are named here only to say they were checked.**

### Slice B — link and unlink (the register's part 2)

| Path | Change |
|---|---|
| `packages/auth/src/credentials-admin.ts` | **new.** `linkFirebaseCredential(tx, actor, { personId, uid })` and `unlinkCredential(tx, actor, { credentialId })` — `authorize('manage_users')`, §5.4's guard, `revokeCredential` + `endAllForPerson(…, 'revoked')`, returning the ended count |
| `packages/auth/src/index.ts` | export both |
| `apps/erp/src/app/admin/users/lib.ts` | `userDetail` gains the live-credential list (`listLiveForPerson`) |
| `apps/erp/src/app/admin/users/actions.ts` | `linkFirebaseAction`, `unlinkCredentialAction` — thin adapters, gate stays in the domain |
| `apps/erp/src/app/admin/users/[personId]/page.tsx` | the **Sign-in accounts** section |
| `docs/ops/README.md` | §6's procedure |

⚠️ A **new file in `packages/auth`** rather than more of `sessions.ts`: everything in that file is
either unauthenticated by nature (`signInWithPin`, `resolveActor`) or actor-less (`setPin`), and
these two are the first credential functions that take an `Actor` and call `authorize`. Mixing them
in would put a gated function beside the sign-in primitives that deliberately have no gate. Say the
word if you would rather it lived in `sessions.ts`.

### Slice C — ⛔ the PIN half (§3), requested, separable

| Path | Change |
|---|---|
| `packages/auth/src/sessions.ts` | `setPin` revokes the person's live PIN for that store **before** inserting the new one, and the `'superseded'` session-end stays |

### 8. Tests

Real Postgres, lane DB `shareat_test_t216b`, via `it.mjs`. Written to fail first — each case's
failure mode is named so a green-on-first-run result is treated as the bug it would be.

| # | Case | Fails today with |
|---|---|---|
| 1 | ⭐ **The defect, executed.** Link uid → revoke → **link the same uid again** → succeeds, and `findActiveCredentialByExternalId` resolves to the new row | `23505` on the re-insert |
| 2 | Two **live** rows for one uid are still refused (§2.3's boundary) | — must stay red-to-green-to-red: it passes before and after, and is here so a later widening cannot happen silently |
| 3 | `unlinkCredential` revokes the row **and** returns the count of sessions it ended; `listLiveForPerson` then shows neither | no such function |
| 4 | ⭐ The ended sessions carry `ended_reason = 'revoked'` — the enum value nothing has ever written | no writer |
| 5 | A `manager` actor is refused `unlinkCredential` and `linkFirebaseCredential`; an `admin` is allowed | no function |
| 6 | §5.4: the last live credential of the only active admin is refused, with that sentence; the same unlink succeeds once a second admin exists | no guard |
| 7 | Unlinking your OWN credential is allowed and ends your own session | no function |
| 8 | ⛔ §3.1: `setPin` twice → the **first** PIN no longer signs in (`signInWithPin` refuses it) | **passes today** — the old PIN still works. This is the security assertion of slice C |
| 9 | ⛔ §3.2: `setPin` with the **same six digits** twice → succeeds, one live row | `23505` |
| 10 | Re-run unchanged: `packages/auth/tests/integration/sessions.test.ts`, `packages/domain/tests/integration/first-run-setup.test.ts`, `tests/integration/email-sign-in.test.ts` — all three write or read `person_credentials` through the changed indexes |

Plus `tests/unit/rls-registry.test.ts` and the migration-journal guard, which the schema change puts
in the blast radius whether or not it changes their expectations.

### 9. Invariants

1. **A uid that was unlinked can be linked again** — the whole defect, and case 1 is the proof.
2. **One uid, one live credential, still** — §2.3. Multi-org linking is not opened here.
3. **Revoking a credential and ending its person's sessions happen in ONE transaction, or neither
   does.** A revoked row beside a live session is the defect wearing different clothes.
4. **There is exactly one way to end a session** — `endAllForPerson`. This task adds a caller, never
   a second path.
5. **No screen may leave an organisation with no way in** (§5.4).
6. **Revocation stays a timestamp, never a delete** — `revoked_at`/`revoked_by`, per the column's own
   comment: a credential that once existed is part of the audit trail for everything it authorised.

### 10. Out of scope, and why

- **One uid across two organisations** (§2.3) — needs the sign-in path to resolve an org first.
- **`checkRevoked` and any change to `BROWSER_SESSION_TTL_MS`** (§6).
- **Resolving an email to a uid** (§5.3) — declined for the service-account dependency.
- **A `revoke_reason` column on `person_credentials`.** `attendance_credentials` requires one
  (`schema/attendance-credentials.ts:144`, a triple check constraint) and this table has none, so an
  unlink records *who* and *when* but not *why*. ⚠️ It is a genuine audit gap and I am leaving it
  out because it is a column, a check constraint and a backfill decision on a table this task is
  already changing the indexes of — two schema changes in one migration for two different reasons is
  how a migration becomes hard to reason about. **Recommend it as its own small task; say so on
  approval and I will fold it in instead.**

### 11. Done when

typecheck clean · unit green · cases 1-10 green on `shareat_test_t216b` · **the migration applied to
a lane DB and the two indexes confirmed present as partial** (`\d person_credentials` shows the
predicate — a migration Drizzle skipped reports success and changes nothing) · `/admin/users/<person>`
exercised in a browser: link a uid, see it listed, unlink it, see the session count reported and the
person signed out · self-reviewed line by line · **FOR IAN block in the READY**.

⚠️ **What I cannot verify and will say so:** anything needing a real Firebase account. Linking takes
a uid string, so every case above runs without Firebase; that the uid *belongs* to a real account is
the administrator's knowledge and the console's business.

### FOR IAN

- **Today, if someone leaves or an account is compromised, there is nothing you can do from the
  app.** Disabling them in Firebase stops their next sign-in but not the session they already have,
  which can last a week. This task gives you an **Unlink** button that signs them out everywhere,
  immediately.
- **And once unlinked, they can be linked again** — which the database currently refuses outright,
  so the "ask an administrator to link it" sentence on the sign-in screen has, until now, been
  advice nobody could follow.
- **You will paste a uid from the Firebase console, not an email address.** Looking an email up
  would make this screen depend on the service-account key; the uid costs you one copy-paste and
  keeps the sign-in path credential-free.
- **One refusal you may meet:** the app will not let you unlink the last way into your own
  organisation. Give someone else an admin role, or issue that person a PIN, first.
- **Found while reading, and it affects you more than the defect above** (§3): re-issuing a
  staff PIN **does not stop the old one working** — the previous PIN keeps signing that person in.
  And re-typing the same six digits fails with a raw database error. I have asked to fix both in this
  task because the index change is the same one line; it is your call whether that waits.

### Model

**The build is Sonnet-able.** The judgment is in this spec — the index predicate, the blast radius of
§4, the one guard in §5.4, and what §3 does and does not include. Executing it is a migration file
written to a stated shape, one new gated module that mirrors
`packages/domain/src/attendance/credentials.ts`, a screen section that mirrors
`staff/[employmentId]/credentials/`, and ten integration cases whose failure modes are named above.
⚠️ One exception if it comes up: if applying `0137` to a lane DB reveals that either index is being
relied on somewhere this sweep did not see, that is a re-plan and not a Sonnet edit — the lane should
stop and report rather than adjust the predicate.

---

## 12. As built (lane D, 2026-09-08)

### 12.1 ⛔ The one deviation from §2.2: the index NAMES did not change

The spec said the indexes would be renamed `_live_unique`, matching `attendance_credentials`.
**They kept their names**, because a name-based reader turned up in the sweep:

`apps/erp/src/app/staff/actions.ts:58` matches `/person_credentials_lookup_hash_unique/` as a
literal, in a regex over the raw driver error, to turn DEF-177's unique violation into a sentence an
owner can act on. `person_credentials_lookup_hash_live_unique` does not match that regex, so the
rename would have dropped the sentence back to a raw `23505` — **with a green build, green
typecheck and green tests**, because nothing else in the repo knows that string. Renaming a thing
other code matches by name is not a tidy-up. `0120_def128_partial_reversal_unique.sql` had already
kept its index name through the same kind of change; this follows it.

⭐ The sweep found it because index names were grepped **as names**, not only as schema references —
the same discipline as *grep raw SQL before dropping a column*, applied to an identifier that lives
in a regex rather than in SQL.

### 12.2 A third defect, found by the same sweep: DEF-177 was the visible half of DEF-228

`staff/actions.ts:55-58`' own comment says it: *"`setPin`'s own pre-check only refuses a PIN already
taken by a DIFFERENT person — re-entering the SAME person's own current PIN reaches the DB's unique
index instead... Mapped here, at the presentation edge, without touching `setPin` itself."* So §3.2
was already registered as **DEF-177** and papered over; nobody had recorded §3.1, the half where the
**old PIN goes on working**. Slice C closes the cause of both.

⚠️ **A follow-up for whoever owns `staff/actions.ts`** (not lane D's, and not touched): after slice C
that mapping is nearly dead — re-entering the same PIN now succeeds — and its sentence, *"That's
already this person's current PIN — nothing changed"*, has become **wrong** for the only case that
can still reach it (a genuine race between two administrators issuing the same digits to two
people). Recommend re-wording rather than deleting: the race is real, if rare.

### 12.3 What each slice actually touched

| Slice | Files |
|---|---|
| A | `packages/db/schema/sessions.ts` · `packages/db/migrations/0137_def224_def228_credential_live_unique.sql` (new) · `meta/_journal.json` (idx 137, when 1797910307084) · `packages/domain/src/organizations/index.ts` (one comment) |
| B | `packages/db/src/repo/access.ts` (`hasOtherActiveAdminOrSuperAdmin` + a shared private helper) · `packages/auth/src/credentials-admin.ts` (new) · `packages/auth/src/index.ts` · `apps/erp/src/app/admin/users/{lib,actions}.ts` · `apps/erp/src/app/admin/users/[personId]/page.tsx` · `docs/ops/access-revocation.md` (new) |
| C | `packages/db/src/repo/sessions.ts` (`revokedBy: string \| null`) · `packages/auth/src/sessions.ts` (`setPin` retires the PIN it replaces) |
| tests | `packages/auth/tests/integration/credentials-admin.test.ts` (new, 12 cases) |

⚠️ No snapshot file was written for `0137`: `meta/` holds snapshots only to `0019` — every migration
since is hand-written per DEF-073/DEF-121, and `drizzle-kit generate` must not be run here. (§7's
"as generated" was wrong about this; the journal entry is the only metadata the runner reads.)

### 12.4 The evidence, and how each claim was actually established

| Claim | How it was proven |
|---|---|
| `0137` really landed, and both indexes are partial | Read back from `pg_indexes` on the lane DB after applying — *not* from the migrator's exit code, which reports success for a migration Drizzle skipped |
| DEF-224 was real, and `0137` is what fixes it | A throwaway script re-created the OLD plain index inside **one rolled-back transaction**, ran the link → revoke → re-link sequence, and got `23505 duplicate key value violates unique constraint "person_credentials_external_id_unique"`; the same sequence under the migrated index succeeded. 0 rows left behind, asserted |
| DEF-228 was real | The revoke loop in `setPin` was temporarily disabled and the suite re-run: case 8 failed with *"promise resolved instead of rejecting"* — the old PIN signing in — and case 9 with the `23505`. Both green again with the loop restored |
| The lockout guard counts a super_admin | Its own case, because every other admin-counting helper in `accessRepo` filters the literal `'admin'` |

### 12.5 Not verified, and stated as such

No screen was opened in a browser: `/admin/users/<person>`'s new **Sign-in accounts** section is
typechecked and its actions are covered through the domain functions they call, but nobody has
clicked Link or Unlink. Lane C's pass on `shareat_test_qa` and the orchestrator's browser check are
where that happens. Nothing here needs a real Firebase account — linking takes a uid string — so the
only thing a browser adds is the screen itself.

### 12.6 ⛔ SPEC DEFECT — §5.4's condition counted admin ROLES, not admins who can sign in

**Found by the Opus second read, and it is a defect in this spec rather than in the code that
implemented it** (RULES §3.4a — report it, do not quietly re-word it). §5.4 said: refuse when the
target holds no other live credential **and** *"is the organisation's only active admin"*. That
second clause is satisfied by a **role row**, and a role is an authority nobody can exercise if that
person cannot sign in.

⚠️ **The first implementation's own test demonstrated the hole while passing**: it granted `admin`
to a credential-less person, and the unlink was then allowed — leaving an organisation with **zero
live credentials**, which is precisely the droplet-shell recovery the guard exists to prevent.

**The condition is now:** *another active `admin` or `super_admin` who holds at least one LIVE
credential* — `accessRepo.hasOtherActiveAdminWhoCanSignIn`, an `exists (…)` over
`person_credentials` inside the same query rather than a second read. ⚠️ That makes it the one
function in `repo/access.ts` that reads outside the access axis, which its comment says out loud.

⭐ **Red-first, and it caught a second instance of the same assumption.** With the guard reverted to
role-only, the new case fails with *"promise resolved instead of rejecting"*. Restoring it then broke
**case 7** — whose fixture had also assumed a bare role made someone "another way in". Both fixtures
now grant a PIN, which is the honest shape.

### 12.7 The other four fixes from the same read

| # | Was | Now |
|---|---|---|
| 2 | The guard read roles and credentials with no lock, so two administrators unlinking each other's last credential under READ COMMITTED could both see *"someone else can still get in"* and both commit | `accessRepo.lockOrgAccess(tx, orgId)` — `pg_advisory_xact_lock(hashtext(orgId))`, taken before the guard reads, the same shape `lockFirstRun` uses because there is no single row to lock. A test asserts the lock is really HELD (`pg_locks`), not merely that the statement ran |
| 3 | `linkFirebaseCredential` left a cross-org `personId` to RLS alone; the policy's `42501 new row violates row-level security policy` reached the screen verbatim | `requirePersonInOrg` on **both** link and unlink, with `assignRoleAsActor`'s wording, which `/admin/users` already maps to *"That person is not part of this organisation."* Two cases assert the refusal is the domain's sentence and **not** a 42501 — bible §15.11 / DEF-210: no layer may be the only layer |
| 4 | The uid was checked only for emptiness; past ~2.7 KB the btree raised *"index row size exceeds maximum"* on the screen | ≤ 128 characters, no internal whitespace, and **no `@`** — §5.3's *"this is not an email address"* enforced rather than printed. One sentence per refusal, one case each, plus a control that a real-shaped uid is accepted and trimmed |
| 5 | Case 2 linked one uid to two persons in the same ORG; §2.3's boundary is two ORGANISATIONS | Both, now. The cross-org case is the one `/admin/users`' *"already linked to somebody"* sentence exists for, and it is refused by the global index rather than by a tenancy check |

**Nit, taken:** unlinking your own credential now clears the `shareat_session` cookie
(`clearSessionCookie`, two lines). The session was already ended server-side; the cookie was a dead
token that cost one confusing round-trip.

⚠️ **`assignRoleAsActor` has the same unlocked read-then-write race** (`roles.ts`' lockout guard
reads `hasOtherActiveAdmin` and then writes). Not touched — it is another task's file and the
orchestrator is filing it.
