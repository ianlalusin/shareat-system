# T-302 — PINs become globally unique: one PIN identifies one person, everywhere

> ### ✅ **Status: APPROVED 2026-09-14 by system32-85. BUILT, GATES GREEN, NOT YET DEPLOYED.**
>
> **Spec written 2026-09-13 by lane C (webapps-f7); approved and built 2026-09-14 by the same lane.**
> The sequencing gate this document set for itself has **opened**: it said *"built SECOND, after
> T-304 + T-303 are in and sign-in is confirmed working on Ian's counter"*, and all three happened
> on 2026-09-13 — T-303 and T-304 shipped in `58f198a` with migration `0147`, T-304's eight-step
> cutover ran in full on a real device (SharEat Lipa provisioned), and PIN sign-in is live in
> production.
>
> ⛔⛔ **NOT DEPLOYED, AND THE DEPLOY IS NOT ROUTINE. Every existing PIN stops working the moment
> it lands** — migration `0148` revokes them all, deliberately. **Re-issuing them from Staff is a
> required step in the same sitting**, and admin email + password sign-in is the way back in and is
> unaffected. T-304's cutover was designed to touch zero credentials; this is the task that spends
> that, and the blast radius grows with every store provisioned after today. See §The re-issue.
>
> ⚠️ **The status line this replaces still said *"awaiting APPROVED"* and *"RECOMMENDED FOR
> DEFERRAL"*** — both true when written, both false by the time anybody read them again. DEF-348.
>
> ### ⛔ What changed between the spec and the build — read this before trusting anything below
>
> This document was written **before T-304 shipped**, and re-reading it as a stranger at build time
> found **six defects in it, one blocking**. Each is corrected in place below, and each correction
> is marked `⭐ CORRECTED AT BUILD TIME`. In summary:
>
> | # | What the spec said | What is true |
> |---|---|---|
> | **1** ⛔ | Sign-in gates on `personHasStoreScope` | **Blocking defect.** Nothing in the hire flow writes a scope row — `createEmployment` writes an employment and stops, and the fan-out in `roles.ts` fires for `admin` only. A scope-only gate refuses a normally-hired cashier **with the flat `BAD_PIN` sentence**. Ruled 2026-09-14: **open employment at this store OR a scope row** |
> | **2** ⛔ | Fix #2 is `listLiveForPerson`'s third argument | It is **two** arguments. `endAllForPerson(…, input.storeId)` nine lines below has the identical shape and the spec missed it — a re-issued PIN would leave a live session at the person's other branch |
> | **3** ⚠️ | Five load-bearing sites | **Seven.** `livePinFor` (`staff/lib.ts`) reports "no PIN issued" on every other branch's employment page, and the issue-PIN screen invites the admin to act on that — silently changing the person's PIN elsewhere |
> | **4** ✅ | T-302 rewrites the sign-in page, shrinks `PRE_AUTH_PATHS`, and adds `identifyByPin` | **All already done by T-304.** `PRE_AUTH_PATHS` is already at one entry. **T-302 touches no sign-in file at all** — a third of the spec's own file list is struck |
> | **5** ⚠️ | "No migration. No schema change." | **`0148` is required.** Not for schema — for the live-but-unmatchable credential rows the key change leaves behind, which two surfaces report as working PINs |
> | **6** ⚠️ | The credential lookup must stay on the auth door | T-304 made that false and its own §Q4 claims it already moved. It had not. Moved here, because org-scoping makes the HMAC the *only* tenancy layer otherwise — bible §15.11 |
>
> ⛔⛔ **SUPERSEDED IN ITS JUSTIFICATION — 2026-09-13, and the deferral it recommended is SPENT.**
> [T-304](./304-two-layer-terminal-sign-in.md) changes the sign-in model: the terminal
> authenticates first, so the store **and** the org are known before any PIN is typed.
>
> **Three things follow, and they change this document rather than decorate it:**
>
> 1. ⛔ **The security justification is GONE.** This task was justified by *"a PIN must identify one
>    person because the PIN is what gets you in"*. After T-304 the PIN gets you nothing on its own —
>    a stranger cannot reach the PIN box without the store's email and password. **Ian's ruling
>    stands, but it is now a CONVENIENCE decision: one person, one PIN, across branches.**
> 2. ⭐ **The lookup key becomes `orgId:pin`, not a tenant-blind `pin`** — see T-304 §Q-org, where
>    the claim is checked on four legs. **This dissolves the cross-organisation oracle** that the
>    first draft of this spec had to accept and diarise.
> 3. ✅ **SEQUENCED, NOT DROPPED — ruled 2026-09-13; the sequence RAN on 2026-09-14.** Ian was asked
>    the one number that decides it, *how many staff work at more than one branch*, and answered
>    **"several, regularly."** So this task is built **SECOND**, after T-304 + T-303 — which is
>    exactly what happened. ⭐ The operational half is what he chose on: with this deferred, the
>    T-304 cutover touched **zero credentials** and there was no window in which a working PIN
>    stopped working. ⛔ **That protection is now spent, by design** — this deploy is the one where
>    working PINs stop working, which is why it was worth deferring until sign-in was healthy.
>
> ⚠️ **Everything below was revised for org-scoping before the build, and the build then corrected
> it again** — see the defect table above. The analysis holds where it is not marked
> `⭐ CORRECTED AT BUILD TIME`; where it is, the correction wins and the original is kept beside it
> so the reasoning that produced the mistake stays visible.
>
> ⛔⛔ **IF YOU ARE PICKING THIS UP LATER, READ THIS FIRST: org-scoping is what makes this task
> SAFE, and it is not optional.** The lookup key is **`orgId:pin`**. A **tenant-blind** key —
> `HMAC(pin)` with no scope — turns the unique index into a cross-organisation oracle: an admin in
> one organisation learns that six digits are in use in another, and repeated, enumerates the space.
> Bible invariant 7 forbids it. ⚠️ **That variant is tempting and was proposed in this document's
> own first draft**, because it is the only thing that works when the org is unknown at lookup time.
> **It is unnecessary here: T-304's layer 1 hands us the org before the PIN is typed.** If you find
> yourself needing a tenant-blind key, the thing to fix is the sign-in order, not the key.
> **Do not re-derive this. It has already been ruled out** — T-304 §Q-org.

## Ian's ruling

> *"it must, pin must be unique to every users block new pins that are already existing used by a
> user"* — Ian, 2026-09-13.

The orchestrator put the security cost to him first and offered a store-scoped variant. **He
reaffirmed.** This spec builds what he asked for. ⛔ **The cost is recorded below because a decision
whose cost is not written down cannot be revisited when the facts change — not to re-open it.**

---

# Q1 — the index. ⭐ YOUR CLAIM IS CORRECT, AND IT IS BETTER THAN YOU PUT IT

**Verified against the migration, not the schema file:**

```sql
-- packages/db/migrations/0137_def224_def228_credential_live_unique.sql
CREATE UNIQUE INDEX "person_credentials_lookup_hash_unique"
	ON "person_credentials" ("lookup_hash")
	WHERE "person_credentials"."revoked_at" IS NULL AND "person_credentials"."lookup_hash" IS NOT NULL;
```

**`lookup_hash` alone. Partial on live rows. No `store_id` in the index.** So the moment
`pinLookupHash` stops mixing the store in, **the database enforces global PIN uniqueness with no
new migration and no new constraint.** ⛔ **No migration slot is needed. `0147` is not required.**

> ⭐ **CORRECTED AT BUILD TIME — true about the SCHEMA, wrong about the MIGRATION.** No constraint
> has to change, and none did. But the key change strands every existing `pin` row on a hash the
> new code can never compute: **live credentials that cannot authenticate**, which `livePinFor`
> renders as *"Issued &lt;date&gt;"* and `countActiveCredentials` counts toward a BLOCKING readiness
> gate. A deploy on this reasoning alone would have stopped every cashier's PIN working while every
> screen that could have said so said the opposite. **`0148` revokes them**, which turns that into
> *"No sign-in PIN issued yet"* — a state the system already renders and already offers a remedy
> for. ⛔ **"No schema change" and "no migration" are not the same claim**, and this document
> treated them as one.

⭐ **And it is stronger than "no migration needed" — the uniqueness is not optional, it is
structurally forced, which closes the design space.** `findActiveCredentialByLookupHash`
(`packages/db/src/repo/sessions.ts:38-57`) ends `const [row] = … .limit(1)` with **no `ORDER BY`**.
If two live rows ever shared a lookup hash, the PIN would sign in an **arbitrary one of two people**,
differently on different days, silently. Migration `0137`'s own comment says exactly this about the
sibling index:

> *"two live rows would sign a franchise owner into an arbitrary org on different days, silently"*

**So a global lookup REQUIRES global uniqueness. They are one requirement, not two**, and Ian's
*"block new pins already used"* is therefore satisfied by a database constraint rather than by
service-layer code — which is what RULES §6 item 3 demands anyway.

---

# Q2 — migrating existing PINs. ⚠️ YOUR CONCLUSION IS RIGHT. YOUR REASON IS NOT

**Re-issue the live credentials as part of this change: CONFIRMED, and it must ship in the same
deploy.** But the stated reason — *"both hashes are one-way, so no code can recompute
`HMAC(pin)` from `HMAC(storeId:pin)`"* — **is false, and the spec must not rest on it.**

## The correction, and it matters beyond this task

`pinLookupHash` is `HMAC-SHA256(derivedKey('pin-lookup'), "${storeId}:${pin}")`
(`packages/auth/src/credentials.ts:69`). A PIN is **exactly six digits**, enforced by
`isValidPinFormat`. That is a keyspace of **10⁶**.

> ⛔ **Anyone holding `SESSION_SECRET` and the credential row can recover the plaintext PIN by
> exhausting that keyspace — about a million HMAC-SHA256 operations, well under a second per
> credential on any machine that runs this app.** The store id is known (it is a column on the same
> row). There is nothing to invert; there is a list to walk.

**So a mechanical migration IS technically available**: recover each live PIN, recompute the
global hash, `UPDATE` in place, nobody re-types anything.

## ⛔ Re-issue anyway, and here is the real reason

**Because the alternative is committing a PIN-extraction tool to this repository and running it
against the production database.** That artifact — a script that turns `person_credentials` plus
the session secret into a list of staff PINs in plaintext — is a worse thing to own than two people
choosing a new six digits. It would be correct, it would work, and it would sit in `scripts/`
forever.

⭐ **MEASURED, 2026-09-13, correcting my own claim.** I wrote *"well under a second per credential"*.
Timed on this machine — a full 10⁶ sweep recovering the plaintext PIN took **2,333 ms**
single-threaded in JavaScript, so **~1.2 s average, ~2.3 s worst case**. Still trivial, still makes
the point, but **the corrected number is the one to quote.**

⚠️ **Two consequences that outlive T-302, stated because they are true today and not caused by it:**

1. **The lookup hash is not, and never was, a protection of the PIN.** The scrypt `secret_hash` is.
   `credentials.ts:64` already says *"an attacker with the secret could compute it"* — this is the
   full statement of what that means: **database + secret ⇒ every plaintext PIN, in seconds.**
2. **`SESSION_SECRET` is therefore PIN-equivalent material.** It is already `requiredSecret(32)`
   with no fallback (DEF-062's fix), which is right. What is not written anywhere is that leaking it
   does not merely allow forgery — it discloses every live PIN. ⭐ **Recommend a register row; I
   have not written one.**

## The re-issue, in Ian's language

**Production holds 2 live `pin` credentials and 1 `firebase`** (orchestrator's measurement).

> **What you have to do, and when.** The moment this change is deployed, **both existing PINs stop
> working.** Not "might" — they will fail, immediately, for both people who hold one. The six digits
> they type are hashed a different way afterwards, and the old rows no longer match anything.
>
> **So the deploy and the re-issue are one job, not two.** Sign in with your **email and password**
> — that path is unaffected — go to **Staff**, and issue each person a new PIN. Two people, two
> minutes. ⚠️ **Do it in the same sitting as the deploy**, because between the deploy and the
> re-issue nobody can sign in at a terminal.
>
> ⛔ **Do not deploy this on a trading day without doing the re-issue immediately after.** If
> something goes wrong and you cannot issue the new PINs, the email sign-in still works and is the
> way back in.

⚠️ **And a PIN is now unique across the whole business**, so when you issue one you may be told
*"that PIN is already in use"* — it means another person somewhere has those six digits, not that
you typed something wrong. Pick different ones.

---

# Q3 — the compensating control. ⛔ YOU ARE RIGHT: THERE IS NONE. ANYWHERE

**Verified by grep across `apps/` and `packages/` for throttle, rate-limit, lockout, backoff and
attempt-counting: the PIN sign-in path has no control of any kind.**

- **One production call site**: `apps/erp/src/app/sign-in/actions.ts:43` → `signInWithPin`.
- The only `lockout` matches in the codebase are `packages/auth/src/roles.ts` and
  `credentials-admin.ts` — the **last-admin** lockout guard (T-238/DEF-232). A different concept
  entirely; it protects role removal, not authentication.
- The only throttle a user can hit is **Firebase's own**, on the email path
  (`EmailSignInForm.tsx:92`). The PIN path never reaches Firebase.
- `credentials.ts:26` says *"rate limiting belongs at the sign-in route."* **It was never built
  there.** The sentence assigns the responsibility and nothing discharges it — the same shape as
  DEF-186's family: a control documented at the point it is delegated away from.

## ⛔ What this change does to that gap, stated plainly

`credentials.ts:22-27` names **three** things that make a 6-digit secret acceptable:

| # | The comment's claim | After T-302 |
|---|---|---|
| 1 | *"the lookup is **store-scoped** so a PIN only means anything inside one store"* | ⛔ **Deliberately removed by this task** |
| 2 | *"the hash is **unique** so a check touches exactly one row"* | ✅ Unchanged — and now global |
| 3 | *"**rate limiting** belongs at the sign-in route"* | ⛔ **Never existed** |

**Two of the three named compensating factors will be absent.** Concretely: today a wrong guess is
tested against one store's staff; afterwards every guess is tested against the entire staff
population of the business at once, with no throttle, no lockout and no backoff. With *n* staff, a
random guess succeeds with probability *n*/10⁶ per attempt, and nothing limits attempts.

⚠️ **This does not block T-302 and T-302 must not depend on it** — per your instruction. It is
stated here so the decision is on the record with its cost.

## The minimum viable control, named so it can be allocated

**Not to be built in T-302.** Recommended shape, cheapest first:

1. ⭐ **Per-IP-plus-global failure counter on `signInAction`, fixed-window, in Postgres.** A
   `pin_signin_attempts` row keyed by a coarse bucket; refuse past N failures in the window with the
   *same* `BAD_PIN` sentence, so the refusal leaks nothing new. **No new dependency, no Redis, and
   it fails closed.**
2. **Exponential backoff per credential** once a PIN is identified but the scrypt compare fails —
   cheap, but only helps after the lookup already matched, so it is the weaker half.
3. ⛔ **Not account lockout.** Locking a cashier out of a till mid-shift because someone else
   guessed at their PIN turns an availability problem into an operational one, and this business
   runs tills.

**Ask Ian for a task number.** I have not written a register row.

---

# Q4 — everything that assumes per-store PINs

Method: the T-300 test — **does removing the assumption change behaviour, or only wording?**

## ⛔ LOAD-BEARING — these break, and one of them breaks silently-wrong

| # | Site | What happens | Fix |
|---|---|---|---|
| 1 | **`packages/auth/src/sessions.ts:93-97`** — `if (credential.storeId !== input.storeId) throw BAD_PIN` | ⛔⛔ **THE BIG ONE. Every sign-in at any store other than the one the PIN was issued at is refused.** The guard's own comment says it is *"unreachable — which is exactly why it is checked. A credential resolving to the wrong store means the hashing changed underneath us."* **The hashing is changing underneath it.** It fires exactly as designed, on the main path | Replace the store-**equality** check with a store-**scope** check: `accessRepo.personHasStoreScope(tx, credential.personId, input.storeId)`. ⭐ Same failure direction, correct question |
| 2 | **`packages/auth/src/sessions.ts:311-316`** — `listLiveForPerson(trx, personId, input.storeId)` | ⛔ **Silent-wrong, then a misleading error.** Retiring the person's previous PIN is scoped to `(person, store)`. Give a person their *existing* PIN at a second store and the old row is not retired, the insert hits the unique index, and `staff/actions.ts:65` maps 23505 to *"That PIN was just taken at this store"* — **which is false: it is their own PIN** | Drop the third argument. `listLiveForPerson(tx, personId, storeId?)` already makes it optional (`repo/sessions.ts:94-100`) — **a one-argument change**, and it is the correct semantics once a person has one PIN |
| 3 | **`packages/auth/src/sessions.ts:291-294`** — `setPin`'s `taken` pre-check | Becomes **globally** correct automatically (the hash is global), but its sentence — *"That PIN is already in use **at this store**"* — is then wrong | Reword; see §Messages |
| 4 | **`packages/db/src/repo/stores.ts:265-270`** — `countActiveCredentials(tx, storeId)` counts `person_credentials WHERE store_id = …` | ⛔ **Load-bearing and it becomes actively wrong, not stale.** A PIN row still carries one `store_id` (forced — see below), so a brand-new store still counts **0** — while every person with a global PIN and store scope can now sign in there | The readiness input must become *"does anyone have store scope here AND a live PIN"*, not *"are there credential rows stamped with this store id"* |
| 5 | **`packages/domain/src/stores/service.ts:485-500`** — the `signIn` readiness gate, `blocking: true` | ⛔ Consumes #4. **It will block a store as *"No one can sign in here yet"* when everyone can**, and its remedy tells an admin to issue a PIN that is not needed. A blocking gate that is wrong in the permissive direction is worse than one that is merely stale | Follows #4 |

## Decorative — reasoning that becomes stale, behaviour unaffected (**4**)

`credentials.ts:1` (file header), `:22-27` (the three-factors comment — ⚠️ rewrite honestly per Q3,
do not quietly drop factor 1), `:57-66` (`pinLookupHash`'s "store scoping is v1's own good idea"),
`sessions.ts:60` and `:300-307` (`setPin`'s "per store, and only `pin`" paragraph), plus
`packages/domain/src/organizations/index.ts:9`.

## ⭐ Two structural facts the enumeration turned up

**(a) `store_id` stays NOT NULL on a PIN row — enforced by a CHECK, not by convention.**
`packages/db/schema/sessions.ts:148`: `kind = 'pin' and store_id is not null and secret_hash is not
null`. **So the storage shape stays `(person, store)` while the lookup becomes global**, and that
split is the source of #4 and #5. ⛔ **Do not "fix" it by relaxing the CHECK** — that is a migration,
it is out of scope, and the store on the row is still meaningful as *where this PIN was issued*.
⚠️ **But it must be written down**, or the next reader will take `store_id` to mean *where this PIN
works*, which is exactly what it will no longer mean.

**(b) `attendance_credentials` is a different table and is NOT touched.** Biometrics keep their own
store-scoped lifecycle (T-185). `setPin`'s existing *"a new PIN does not retire a fingerprint"*
remains true and must stay true.

---

# ⭐ THE DEF-333 QUESTION — CONFIRMED. T-302 FIXES THE SIGN-IN HALF BY DELETION

**Ian's flow removes the broken read entirely rather than finding a new way to perform it.**

## The mechanism, verified

`apps/erp/src/app/sign-in/page.tsx:46` reads `schema.stores` through a plain `transaction()` — the
app role, **no principal**. `stores` carries one policy, `stores_org_isolation … USING (org_id =
app_current_org())`, and `app_current_org()` is NULL with no principal, so under `shareat_app_prod`
it returns **zero rows** and `:71` renders *"No stores exist in this database yet"*, hiding the PIN
form. That is DEF-333.

## Why PIN-first removes it, without a fifth door

| Step | Runs as | Is it a pre-auth cross-org read? |
|---|---|---|
| 1. Person types a PIN. `pinLookupHash(pin)` → `findActiveCredentialByLookupHash` | the **auth door** — already **lookup #1 of the four** sanctioned by bible §13 row 194 | **No.** Already sanctioned, already there, unchanged in kind |
| 2. `verifyPin` against that row's scrypt hash | same transaction | No — a compare, not a read |
| 3. **The person is now authenticated.** List the stores they may use | ⭐ `withOrgPrincipal(theirOrgId, …)` + `personHasStoreScope` | **No — this is POST-authentication.** A real principal exists |
| 4. They pick a store → `issue(...)` | as today | No |

> ⛔ **The store list stops being a pre-authentication read at all.** It moves from *"anonymous
> visitor reads every store in the database"* to *"an authenticated person reads the stores they
> personally have scope for, under their own org's principal."* **That is strictly better than any
> of DEF-333's three options** — (a) adds a fifth door, (c) makes `stores` world-readable. This is
> option (b), and it costs no new door and no device binding.

**So `apps/erp/src/app/sign-in/page.tsx` leaves `PRE_AUTH_PATHS`** (`tests/unit/no-direct-transaction-in-erp.test.ts:64-68`),
taking that list from three entries to two. ⚠️ **Nothing forces that deletion** — the guard asserts
each exemption names a tracked file, and the file will still exist. **A stale exemption would sit
there silently**, which is the same blind spot DEF-333's own general finding names. Deleting it is
part of this task's definition of done.

## ✅ The ruling this section used to ask for is MOOT — T-304

> ⭐ **Dropped 2026-09-13, and dropping it is a win.** Under T-304 the org comes from the terminal
> session, not from a widened credential query. **Lookup #1 is not extended, nothing is added to
> bible row 194's door, and no question goes to Ian.** Better still, the PIN lookup **leaves** the
> door entirely — a removal, which row 194 says is free. See T-304 §Q4.
>
> The original question is kept below because the reasoning about row 194's asymmetry is what made
> the alternative visible.

## ~~The one thing I need a ruling on~~ — superseded, kept for the reasoning

Step 3 needs the person's **`orgId`**, and the credential row does not carry one
(`findActiveCredentialByLookupHash` selects id, personId, kind, storeId, secretHash, lookupHash,
externalId, revokedAt). Two ways to get it, and they are not equivalent under row 194:

- **(i) Add `orgId` to that existing lookup** — a join to `persons` inside **lookup #1**, which is
  already on the door. More columns on a sanctioned query; **no new caller, no new lookup.**
- **(ii) A second read to resolve person → org** — that *is* a fifth lookup and needs Ian's ruling.

**I recommend (i) and I have not built it.** ⚠️ **But row 194's asymmetry is explicit — removing is
free, adding needs a recorded decision — and "widening an existing lookup" is not obviously
"removing".** ⛔ **Put (i) to Ian as a named decision rather than letting it arrive as an
implementation detail.** If he declines, T-302's sign-in half stops here and DEF-333 needs its own
fix.

---

# ⛔ THE COST, RECORDED — including one the briefing did not raise

**1. Guessing is against the whole business.** Q3. Two of three named compensating factors absent.

**2. *"That PIN is taken"* becomes a real annoyance.** As raised with Ian; accepted. At 10⁶ and
seven stores' staff it is rare today, and it grows linearly with headcount.

**3. ✅ RESOLVED, NOT ACCEPTED — the cross-organisation leak this section used to describe no longer
exists.** The first draft of this spec concluded that a tenant-blind key was unavoidable and that
the resulting cross-org oracle had to be accepted, recorded and diarised to the January cutover.
**That conclusion was correct about PIN-first sign-in and does not survive T-304.**

> **What it said:** *"it cannot be fixed by scoping the hash to the organisation… hashing
> `${orgId}:${pin}` would require knowing the org BEFORE the lookup, which is precisely the
> pre-authentication org/store selection that DEF-333 is about. The two goals are structurally
> incompatible."*

⭐ **Layer 1 hands us the org.** With the terminal authenticated first, `orgId` is in the session
before the PIN is typed, the key is `orgId:pin`, and two organisations may both hold `123456`
without colliding. **Bible invariant 7 is preserved and there is nothing to accept, record or
diarise.** See T-304 §Q-org for the four-leg check, and §Design for the ruled-out tenant-blind
variant kept as a warning.

⚠️ **The incompatibility was real; it was a property of the sign-in ORDER, not of the hash.** That
is the reusable lesson: **when a key cannot be scoped because a value is unknown too early, move the
authentication earlier rather than widening the key.**

---

# Design

## `pinLookupHash` — ⭐ ORG-scoped, not tenant-blind

```ts
export function pinLookupHash(orgId: string, pin: string): string {
  return createHmac('sha256', derivedKey('pin-lookup')).update(`${orgId}:${pin}`).digest('hex');
}
```

⛔ **Not `HMAC(pin)` with no scope at all**, which is what the first draft of this spec proposed.
A tenant-blind key makes the unique index a cross-organisation oracle: an admin in one organisation
learns that six digits are in use in another, and repeated, enumerates the space — bible invariant 7.
**It is only tempting when the org is unknown at lookup time, which is a symptom of PIN-first
sign-in.** T-304 makes the org known, so the key is scoped and the hazard never arises.
**Full reasoning and the four-leg check: T-304 §Q-org.**

⚠️ **The signature still changes** (`storeId` → `orgId`), so the compiler still finds every call
site, which is what keeps this cheap.

⚠️ **Keep the `'pin-lookup'` label.** Domain separation is unrelated to store scoping and is what
stops a lookup hash being usable as a session token.

⛔ **Do NOT keep a `storeId` parameter "for compatibility".** An ignored argument at five call sites
is how a caller keeps passing a store and a reader keeps believing it matters. **Change the
signature; let the compiler find every site.** That is the whole reason this is cheap.

## Sign-in, two steps

1. `identifyByPin(pin)` → `{ personId, personName, orgId, stores: [...] }` or the flat `BAD_PIN`
   refusal. Steps 1-3 above.
2. `signInWithPin({ personId, storeId, ... })` after the person picks, gated by
   `personHasStoreScope`.

⚠️ **Carrying state between the two steps is a real design question and the spec must not hand-wave
it.** The PIN must not sit in a hidden form field, and it must not be re-sent. **Recommend the
`/setup` precedent** (T-232): a short-lived, single-purpose signed token bound to `personId`, minutes
not hours, exchanged in step 2. ⛔ **If a single-step form is preferred instead** — PIN plus a store
picker populated by step 1 — say so, because it changes the shape and I will spec it that way.

## ⛔ One addition the store-scope check forces: a constant-cost failure path

Replacing the store-**equality** guard with a store-**scope** check makes a new case reachable — a
PIN that matches a real person who has no scope at the chosen store. That case does the lookup
**and** the scrypt, then returns the same `BAD_PIN` as a PIN matching nobody, which does the lookup
only. Same sentence, **10-100× the cost**.

**That is a timing oracle for *"these six digits belong to someone in this organisation"*, and
T-302 is what creates it** — full analysis and numbers in [T-304](./304-two-layer-terminal-sign-in.md) §Q5.

⭐ **MEASURED, 2026-09-13** — and I had understated it: **one HMAC 2.4 µs, one scrypt 35.0 ms.**
⚠️ **Quote the absolute, not the raw ratio:** the real no-row path also pays an indexed query, so
the honest figure is **a flat +35 ms on the matched path** — far above network jitter and trivially
measurable. (The pure-crypto ratio is 14,529×, which overstates the case if quoted alone.)

**Fix, in this task, because this task causes it:** on the no-row path run one scrypt against a
fixed dummy hash and discard the result, so both paths cost the same.
⛔ **And if T-302 is deferred, this fix is not needed at all** — the same-message-different-cost
case is only reachable because the store-**scope** check replaces the store-**equality** check.

## Messages

| Where | Today | Becomes |
|---|---|---|
| `sessions.ts:72` `BAD_PIN` | *"that PIN is not valid for this store."* | *"Sign-in failed: that PIN is not valid."* — ⭐ it must stay **one flat sentence for every failure** (unknown PIN, wrong PIN, no store scope), which is the existing design and the reason it is good |
| `sessions.ts:293` | *"already in use at this store"* | *"That PIN is already in use. Please choose another."* |
| `staff/actions.ts:54` | regex `/already in use at this store/` | ⛔ **must change with the sentence or the mapping silently stops matching** |
| `staff/actions.ts:65` | *"That PIN was just taken at this store"* | *"That PIN was just taken — try another."* |

---

# Scope — ⭐ CORRECTED AT BUILD TIME

**What was actually touched, 2026-09-14.** ⛔ The spec's own list is struck where it was wrong; the
corrections are defects 4, 5 and 6 in the banner table.

| File | Why |
|---|---|
| `packages/auth/src/credentials.ts` | `pinLookupHash(orgId, pin)`; the three-factors comment rewritten honestly |
| `packages/auth/src/sessions.ts` | the org-scoped lookup, the new gate, the dummy KDF, `setPin`'s two store-scoped arguments, the lookup's move off the auth door |
| `packages/auth/src/index.ts` | exports `DUMMY_SCRYPT_HASH` so a test can prove it reaches the KDF |
| `packages/db/src/repo/access.ts` | **new** `personMaySignInAtStore` — the gate |
| `packages/db/src/repo/employment.ts` | **new** `listOtherOpenBranches` — feeds the issue-PIN warning |
| `packages/db/src/repo/stores.ts` | `countActiveCredentials` asks the gate's question |
| `packages/db/src/repo/sessions.ts` | *(unchanged — both optional arguments already existed)* |
| `packages/db/schema/sessions.ts` | comment only: the superseded sentence lost "for this store" |
| `packages/db/src/client.ts` | comment only: the auth door is THREE lookups, not four |
| `packages/domain/src/stores/service.ts` | the `signIn` readiness gate's label, detail and remedy |
| `packages/domain/src/organizations/index.ts` | `setPin` call; the stale chicken-and-egg table at `:9` |
| `apps/erp/src/app/staff/actions.ts` | `setPin` call; two error-message regexes that would have silently stopped matching |
| `apps/erp/src/app/staff/lib.ts` | `livePinFor` global; **new** `otherOpenBranchesFor` |
| `apps/erp/src/app/staff/[employmentId]/page.tsx` | the cross-branch warning, **before** the form |
| `scripts/dev-seed.ts` | one PIN per person, not one per (person, store) |
| `packages/db/migrations/0148_t302_retire_store_scoped_pins.sql` + `meta/_journal.json` | idx 148, `when` 1798860707084 |
| `tests/unit/{auth-transaction-callers,no-direct-transaction-in-erp}.test.ts` | comment only, no logic |
| `packages/auth/tests/integration/global-pin.test.ts` | **new**, 18 tests |
| six existing integration test files | `setPin` gained `orgId` |

⛔ **NOT touched, contrary to the spec's own list: `apps/erp/src/app/sign-in/{page.tsx,actions.ts}`.**
T-304 already built the two-step sign-in this document describes designing, and already deleted the
pre-auth store read. `signInWithPin` already receives `orgId`. **A third of the original file list
was work already done.**

⛔ **Not mine:** `docs/tasks/301-*` and `311-*` (lane A) · nineteen task banners (lane B) · the
register · the bible · `.github/`.

# Invariants — ⭐ CORRECTED AT BUILD TIME

| # | Invariant | Citation | Proven by |
|---|---|---|---|
| 1 | One live PIN ⇒ exactly one person, **within an organisation** | `0137`'s partial unique index on `lookup_hash` | *refuses a second person in the SAME org…* |
| 2 | A lookup touches exactly **one** row; exactly **one** KDF compare runs **on every path** | T-138 invariant 5 | *a lookup hash resolves to exactly one live credential*; *an unknown PIN pays for a KDF…* |
| 3 | `store_id` stays NOT NULL on a PIN row, and now means **where it was issued** — never where it works | CHECK, `schema/sessions.ts` | *leaves ONE live PIN…* asserts the surviving row's stamp |
| 4 | Every sign-in failure returns **one** sentence | `sessions.ts` `BAD_PIN` | *neither row at this branch is refused — with the SAME flat sentence* |
| 5 | ⭐ **CORRECTED.** A person signs in at a store **iff** they hold an **open employment there OR a `person_store_scope` row there** — not scope alone | `repo/access.ts` `personMaySignInAtStore` | four tests, both legs separately |
| 6 | ✅ **ALREADY TRUE — T-304 did it.** `PRE_AUTH_PATHS` is at one entry and nothing here adds to it | DEF-333 | `no-direct-transaction-in-erp.test.ts`, unchanged |
| 7 | Biometric credentials keep their store-scoped lifecycle | T-185 | `setPin`'s `kind === 'pin'` filter, unchanged |
| 8 | ⭐ **NEW.** Tenancy has **two** layers on the PIN path: the `orgId` inside the HMAC **and** RLS under `withOrgPrincipal` | bible §15.11 | *a PIN live in org A does not authenticate at a terminal in org B* |

# Tests — each shown red first, by reverting the change and re-running

⭐ **Every one of the eighteen was proven by putting the OLD code back and watching the right test
fail**, not by reasoning about it. Seven planted reverts; the results are in the READY report.

⛔ **Two of these tests were WRONG when first written, and the reverts are what caught it** —
RULES §3.2, *a test that only ever passed proves nothing*:

1. **The two gate-leg tests** issued the PIN and signed in at the **same** store, so
   `credential.storeId === input.storeId` was trivially true and they passed against the old
   equality guard unchanged. Rewritten to issue at store A and sign in at store B, which is the
   only arrangement where the gate is the thing deciding.
2. **The constant-cost test** asserted the no-row path takes more than 10 ms, on the reasoning that
   one scrypt is ~35 ms. **It passed with the dummy KDF deleted** — `signInWithPin`'s no-row path
   makes three round trips and those alone clear 10 ms. Measured: 275–305 ms with the KDF, 26–29 ms
   without. Rewritten to calibrate against a KDF timed in the same process.

# Out of scope

Rate limiting (⭐ **now built — T-303's throttle, shipped 2026-09-13**) · relaxing the `store_id`
CHECK · biometrics · `attendance_credentials` · register rows (system32-85 files them) ·
⭐ **making the hire flow grant a store-scope row** — the honest fix for the gap defect 1 exposed,
raised as a QUESTION for its own task number rather than built here.

# Done when

⭐ **Build complete 2026-09-14.** All eight invariants hold · eighteen tests pass, each shown red
first by reverting the implementation · typecheck clean · unit 1642 passed · lane integration green
· `0148` applied to `shareat_test_lanef7` only.

⛔ **NOT done, and deliberately not this lane's to do:** smoketest on 9008 (the orchestrator owns
the port and the build) · the deploy · **the re-issue of every live PIN in the same sitting as the
deploy**, which is an operational step system32-85 is carrying to Ian.

# ⚠️ What I did not verify

- **The app was never run.** No `npm run build`, no dev server, no browser — the orchestrator owns
  the port and the build, so every claim here rests on typecheck, unit and integration only.
- **The production credential counts (2 pin, 1 firebase)** are still the orchestrator's
  measurement, not mine. The re-issue plan's size rests on them.
- **`0148` against production data.** It was applied to `shareat_test_lanef7`, where the rows it
  revokes are ones the tests created. Its behaviour against the two real production PINs is
  inferred from the statement, not observed.
- **Whether any POS or CUSTOMER surface signs in with a PIN.** I grepped this repository only; the
  reference repos are a separate question and `apps/{pos,customer}` here are reserved and empty.
- **The timing numbers are from this machine**, which measured one scrypt at 115–201 ms — not the
  35 ms this document quotes elsewhere from the 2026-09-13 measurement. The ratio is what the test
  asserts, precisely so the absolute number does not have to travel.
