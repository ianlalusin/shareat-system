# T-304 — two-layer terminal sign-in: the terminal authenticates, the PIN identifies

> ✅⭐ **Status: SHIPPED, DEPLOYED AND CUT OVER — 2026-09-13.** Built in `58f198a`, deployed to
> production, and **the §Cutover ran in full with all eight steps passing on a real device.**
> SharEat Lipa (`LIPA`) is provisioned: terminal person `01a09b5f-14b5-767e-a683-64e7c15d5ae7`,
> credential `01a09b5f-14bc-7b68-9d0c-d5c565c4771b`. **DEF-333 is closed end to end.**
>
> ⛔ **Invariant 8 was proven by ELIMINATING PATHS, not by reading the screen, and the next person
> to verify it must do the same.** `packages/auth/src/sessions.ts` throws its single `NOT_LINKED`
> sentence from `:202` (credential absent or not firebase-kind) **and** `:213`
> (`personKind === 'terminal'`); the identical wording is deliberate (`:205-212`). Step 6 succeeding
> is what rules out `:202`.
>
> ⚠️ **What was NOT proven:** the full integration suite has never run against this code — OOM
> locally (DEF-245) and CI was disabled (DEF-336). Ian was told plainly and chose to deploy.
>
> ⚠️ **The status line this replaces still said *"SPEC ONLY, no code — awaiting APPROVED"*** long
> after the code shipped and reached production. **It is today's own pattern on this very file:
> a status disconnected from the thing it describes.**
>
> Leads [T-303](./303-pin-attempt-lockout.md) and [T-302](./302-global-pin-uniqueness.md).
> ⛔ **T-302 remains DEFERRED — see §Assessment.** ⭐ **Its deferral is now spent: it was deferred
> so PIN re-issuance would happen on a system where PIN login works. It does.**

## Ian's ruling

> *"can we dodge the pin on the sign in screen and just use email pw for security so i can dedicate
> a single shared email pw for all staff then once in they can put their pin so the app knows who
> they are like the set up of v1 coz i dont want a random people luckily guess a cashier pin and
> mess up with our financial records"* — Ian, 2026-09-13.

**Layer 1 authenticates the TERMINAL** (email + password, one shared credential **per store**).
**Layer 2 identifies the PERSON** (PIN), inside an already-authenticated session.
Follow-ups he ruled: **one credential per store**, not per business; **PINs stay globally unique**
— ⚠️ **now a convenience decision, not a security one.**

## ⭐ v1 has already built this, and it is proven practice — RULES §1.2b

`ERP-rebuild/src/app/local-user-login/page.tsx`: `useFirebase()` means **the session already
exists**; `getEffectiveStoreIdClient()` means **the store is already known**; then
`listLocalUsersAction` + `verifyLocalUserPinAction`. Read as a **requirement**, not as a design —
the need is proven, the shape is ours to improve. ⭐ **We improve it in one place: PIN-only, no
staff list** (§Q2).

---

# Why this is the change that pays for itself

| What it fixes | How |
|---|---|
| ⭐ **DEF-333 dies** | There is no pre-authentication store list because there is **no pre-authentication read at all**. You sign in; the store comes from the credential you used |
| ⭐ **The auth door gets NARROWER** | The PIN lookup stops being a pre-auth door lookup — after layer 1 it runs under a real principal. Row 194 says removal is free. **Record it as a removal** |
| ⭐ **T-303's registry blocker dissolves** | A failed attempt now belongs to a known org and store, so the counter is an ordinary `org_column` table. No `system_only`, no fifth door, no new `RlsScope` |
| ⭐ **T-302's cross-tenant oracle dissolves** | The org is known before the PIN, so the lookup key can be `orgId:pin` — see §Q-org |
| ⭐ **The guessing threat Ian named** | *"a random people luckily guess a cashier pin"* — a stranger cannot reach the PIN box at all without the store's email and password |

---

# ⭐ Q-org — I CHECKED YOUR ORG-SCOPING CLAIM. IT HOLDS, AND HERE IS THE PROOF OBLIGATION DISCHARGED

**Claim:** hash `orgId:pin` instead of `storeId:pin`; one PIN per person across the business;
two tenants may both hold `123456`, so the unique index stops being a cross-tenant oracle.

**Verified on all four legs:**

1. **No pre-auth read is reintroduced.** Layer 1 yields `orgId` **and** `storeId` from the terminal
   credential. Layer 2 computes `pinLookupHash(orgId, pin)` from a value already in the session and
   reads under `withOrgPrincipal(orgId, …)`. ✅ **A real principal exists at the moment of the
   lookup** — which is exactly what was impossible under PIN-first sign-in, and why I called it
   structurally impossible then. **That objection was correct about PIN-first and does not survive
   layer 1.**
2. **It delivers Ian's ruling exactly.** Shareat is **one organisation with many stores**
   (bible §1.1), so org-scoping means one person = one PIN at every branch. ✅
3. **The index still enforces it with no migration.** `person_credentials_lookup_hash_unique` is on
   `lookup_hash` alone (`0137`). Two people in one org with the same PIN produce the **same** hash →
   refused. Two people in **different** orgs produce **different** hashes → both live, no collision,
   **no oracle.** ✅ Bible invariant 7 preserved.
4. **The "arbitrary row" hazard does not return.** Two live rows sharing a hash would still mean two
   people in the *same* org with the same PIN, which the index refuses. `findActiveCredentialByLookupHash`'s
   `limit(1)` with no `ORDER BY` stays safe. ✅

⛔ **Ruled-out hazard, recorded here so the next person finds the reason rather than the rule:**
**a tenant-blind PIN key (`HMAC(pin)` with no org) must never be adopted.** It makes the unique
index a cross-tenant oracle — an admin in one organisation learns that six digits are in use in
another, and repeated, enumerates the space. It is only tempting when the org is unknown at lookup
time, which is a symptom of a **PIN-first** sign-in. **If you find yourself needing a tenant-blind
key, the thing to fix is the sign-in order, not the key.**

---

# Q1 — what is a per-store terminal credential in this schema?

## The constraint that shapes everything

`sessions.person_id` is **NOT NULL** and FKs to `persons`; `credential_id` is **NOT NULL**;
`credential_kind` is a CHECK-constrained enum `('pin','firebase','biometric')`
(`packages/db/schema/sessions.ts:202-210`, `:237`).

⭐ **So layer 1 must NOT create a `sessions` row, and that is correct rather than a workaround.**
A terminal has not identified anybody yet; a `sessions` row asserts *this person is working*. The
terminal's Firebase sign-in is held the way the admin email path already holds one **before**
`signInWithFirebase` mints anything. **Layer 2 mints the `sessions` row**, with the real person.

## ⭐ Attribution — the thing most likely to go quietly wrong, and it needs no schema change

| Column | Carries | Already exists? |
|---|---|---|
| `sessions.person_id` | ⭐ **the REAL person the PIN identified** | ✅ unchanged |
| `sessions.credential_id` / `credential_kind` | that person's **PIN** credential, `'pin'` | ✅ unchanged |
| `sessions.store_id` | the store, from the terminal credential | ✅ unchanged |
| `sessions.device_id` | ⭐ **the terminal** | ✅ exists, **is always `null` on this path today** |

`device_id`'s own comment already describes exactly this use: *"The terminal it was issued to.
Opaque, server-issued, and NOT the browser's own storage key."* **It was built for this and has
never been populated.** So: **no migration to `sessions`, and every audit path keeps attributing to
the person** — `resolveActor` reads `person_id` and is untouched.

> ⛔ **The invariant to guard, because it is the whole point of layer 2:** no capability check, no
> ledger posting and no audit row may ever name the terminal. The terminal's only appearance in the
> system is `sessions.device_id`, which is a *where*, never a *who*.

## Where the terminal's own identity lives — ⚠️ THE DECISION I MOST WANT CHECKED

| | Shape | Door cost | Honest verdict |
|---|---|---|---|
| **(a)** | A `persons` row representing the terminal + a `kind='firebase'` credential carrying the store | ⭐ **None.** `findActiveCredentialByExternalId` is **already lookup #2** on row 194's door and resolves it **with no code change to the door at all** | Ugly. A row in `persons` that is not a person, and it can drift into staff lists, headcount reports, role grants |
| **(b)** | Reuse `clock_terminals` (`firebase_uid`, `org_id`, `store_id`, revocation, all present) | ⛔ **One new pre-auth lookup → Ian's ruling** | Semantically closest — *"a device that authenticates as ITSELF"* — ⚠️ **but its flow does not match.** T-159 provisions a *device* that signs in with a **minted `terminal:{id}` claim**; Ian wants a **human-typed shared password**. Reusing the table without the flow is half a fit |
| **(c)** | A purpose-built `store_terminal_credentials` table | ⛔ **One new pre-auth lookup → ruling** | Cleanest long-term model, honest about what it is |

## ✅ DECIDED 2026-09-13 — option (a), with the guard as a hard requirement of this task

**Orchestrator's ruling, and the reasoning is worth keeping:** (c) is the cleaner model and would be
preferred in isolation, but it needs a **new pre-authentication lookup** — a fifth door, a named
ruling under row 194, and **permanent**, because row 194's asymmetry makes doors cheap to add and
expensive to remove. ⛔ **This cycle is the first time the authentication boundary has ever got
smaller. That win is not spent to avoid a fake person.**

⭐ **(c) is recorded here as the preferred model if a second use for a terminal identity ever
appears** — a POS till, a kitchen display, anything that authenticates as itself and is not a
person. **The only reason it was refused is the door cost.** If a future change is already opening
a door for other reasons, (c) becomes free and should be revisited then.

⛔ **MY OWN CAVEAT IS NOW BINDING: "if (a)'s guard is not built, (a) is the worse option."** The
guard ships in **this task**, not as a follow-up:

| Requirement | Why |
|---|---|
| `persons.kind` (or `is_terminal`) — a column, therefore a **hand-authored migration** (ADR-012 §5) | The discriminator must be explicit. ⚠️ **Do not infer "terminal" from `credential.storeId is not null`** — that is an implicit rule two conventions away from being wrong |
| ⛔ **Build-enforced guard**: a terminal-kind person holds **no role**, appears in **no staff listing**, and is **excluded from headcount** | An unflagged fake person turns up in a year-end report |
| ⛔⛔ **`signInWithFirebase` REFUSES a terminal-kind person** | ⭐ **See the hazard below — this is the one that silently defeats the whole design** |
| ⛔ **The refusal reads `persons.kind` — the SAME signal the listing and headcount guards read** | ⚠️ **Not a second signal.** A guard that keeps terminals out of reports while the refusal tests something else is two rules that can drift, and every list-disagreement found this week has that shape (row 194 vs `PRE_AUTH_PATHS`; nine timers vs eight armed; the bible vs the ops README). **One predicate, one place, four call sites** |

> ⛔ **AND THE PRICE OF (a) WAS NOT KNOWN WHEN (a) WAS CHOSEN. Recorded deliberately.**
> The option table above was written, and the decision taken on door cost, **before** the bypass
> below was found. The hazard is a property of (a) that (c) does not have: **(c)'s terminal
> identity lives outside `persons`, so there is no fake person for the email form to sign in as, and
> no refusal to remember to write.**
>
> **The decision still stands** — a permanent fifth door is worse than a guarded fake person, and
> this cycle is the first time the authentication boundary has got smaller. **But a future reader
> weighing (a) against (c) must see (a)'s true price**, which is: a migration, a three-part guard,
> a refusal in the authentication path, and **a standing invariant that is load-bearing every day**
> (see §Terminal session lifetime). That is more than "ugly, but everything downstream works."

### ⛔⛔ The hazard that would defeat layer 2 entirely, found while specifying the cutover

A terminal credential is a `kind='firebase'` credential. **The existing admin email form already
accepts any Firebase credential.** So unless `signInWithFirebase` refuses a terminal-kind person,
**anyone who knows the store's shared email and password can type it into the ordinary email form
and receive a full session as the terminal person — no PIN, no layer 2, and every action attributed
to a fake person.**

That is not a degraded outcome, it is **the exact failure layer 2 exists to prevent**, reached by
the path of least resistance, and it would pass every test that does not think to try it.
**`signInWithFirebase` must refuse, with the same flat sentence, and test 7 asserts it.**

---

# Q2 — how layer 2 resolves the person: PIN-ONLY

**Specifying PIN-only. No list of staff names.** v1 lists; we do not, and the divergence is
deliberate (v1 is authoritative about WHAT, never about HOW):

- ⭐ **A list of everyone who works at a branch, on a tablet on a counter, readable by any
  customer leaning over it, is a disclosure with no compensating benefit.**
- One fewer tap on the hot path, dozens of times a shift.
- ⚠️ **A list is also an enumeration aid**: it turns "guess a PIN" into "guess *this named
  person's* PIN".

⛔ **And the honest consequence, which is the point the orchestrator made and I am confirming:
PIN-only is what makes uniqueness matter at all.** With a list, the person is already chosen and a
PIN need only be unique *within that person* — per-store PINs would do, and T-302 would be
pointless. **With PIN-only, the PIN must resolve to exactly one person within the org.** Under
org-scoped hashing (§Q-org) that is what the existing unique index already gives us — **which is
why T-304 needs no part of T-302.** See §Assessment.

---

# Q3 — the throttle: post-auth, and NOT DEF-333's shape. Confirmed

**Confirmed rather than assumed.** The write happens **after** layer 1 and **before** the PIN
succeeds. At that moment `orgId` and `storeId` are both known from the terminal credential, so the
counter row carries both and every read and write runs under `withOrgPrincipal(orgId, …)`.

- ✅ A principal exists → **RLS is satisfied, not bypassed.** Not DEF-333's shape.
- ✅ The table classifies as an ordinary **`org_column`** entry in
  `packages/db/src/rls/registry.ts` — the only one of the four scopes that fits, and it fits
  properly rather than by exception.
- ✅ **No fifth door. No new `RlsScope`. No ADR. No in-memory Map.**

**No existing table fits** — checked: `sessions` rows exist only post-identification; `audit_log`
and the ETL tables are `system_only`. **Migration `0147` it is.** Full design in T-303.

---

# Q4 — what happens to row 194's four door lookups

| Lookup | Today | After T-304 |
|---|---|---|
| `findActiveCredentialByLookupHash` (PIN) | pre-auth, on the door | ⭐ **LEAVES THE DOOR.** Runs under `withOrgPrincipal` after layer 1 |
| `findActiveCredentialByExternalId` (uid → person) | pre-auth, on the door | **Unchanged** — and under option (a) it resolves the terminal too, with no code change |
| `findLiveByTokenHash` | pre-auth | Unchanged |
| `endSession`'s write | pre-auth | Unchanged |
| *`sign-in/page.tsx`'s store list* | ⛔ pre-auth, **not on any list**, and broken | ⭐ **DELETED.** `PRE_AUTH_PATHS` goes from three entries to two |

> ⭐ **SAY IT LOUDLY, AS ASKED: the pre-authentication surface gets STRICTLY SMALLER — one door
> lookup removed and one unlisted pre-auth read deleted, with nothing added (under option (a)).**
> Row 194 says removal is free and needs no ruling. **This is the first change in this cycle that
> makes the authentication boundary smaller rather than arguing about widening it**, and it is
> worth recording in the bible as the shape to prefer: *when a pre-auth read is structurally
> awkward, the fix is usually to move the authentication earlier, not to widen the door.*

⚠️ **`PRE_AUTH_PATHS`' entry must be deleted by hand.** The guard asserts each exemption names a
tracked file; the file still exists, so a stale exemption sits there silently. Same blind spot
DEF-333's own general finding names.

---

# Q5 — the timing oracle: MEASURED, and it is far bigger than I estimated

⛔ **I previously told you 10-100×. That was wrong. Measured on this machine, Node's `scrypt` at the
repository's parameters (`keylen 64`, defaults) against one HMAC-SHA256:**

```
no-row path  (1 HMAC)     : 2.4 us
matched path (1 scrypt)   : 35.0 ms
RATIO                     : 14529x
10^6 keyspace sweep       : 2333 ms  -> recovered PIN: 918273
```

**Two corrections to my own earlier claims, both in the direction of "I understated it":**

1. **The oracle is real and large.** ⚠️ **State it as an absolute, not as the raw ratio** — the
   real no-row path also pays an indexed query, so the honest figure is **a flat +35 ms on the
   matched path**, which is far above network jitter and trivially measurable. The 14,529× is the
   pure-crypto figure and would overstate the case if quoted alone.
2. ⛔ **My T-302 keyspace claim was wrong.** I said *"well under a second per credential"*. It is
   **2.33 s** for a full sweep, single-threaded, in JavaScript — call it **~1.2 s average**. Still
   trivial, still makes the point, but I overstated the speed and the corrected number is the one
   that goes in the register row.

**Fix:** one dummy `scrypt` against a fixed hash on the no-row path. ⭐ **It belongs to whichever
task introduces a reachable same-message-different-cost case** — under T-304 with **org-scoped**
hashing that is *still* T-302, because the store-scope check is what creates the case. **If T-302
is deferred, this fix is not needed either** (§Assessment).

⚠️ **Inside a trusted terminal session the oracle is smaller but not gone**: it tells an *insider*
that six digits belong to a real colleague. With layer 1 in place and T-303 throttling, the
practical exposure is small.

---

# ⭐ ASSESSMENT — RULES §4 row 163. Effort, and what I recommend against

**Say the number, not the adjective.**

| Task | Effort | Verdict |
|---|---|---|
| **T-304** | **~2 days.** Terminal credential + guard, two-step sign-in, session issuance with `device_id`, delete the pre-auth read, `PRE_AUTH_PATHS`, tests | ⭐ **BUILD.** It is the only thing that fixes DEF-333, and it delivers what Ian asked for |
| **T-303** | **~0.5 day.** One table on `0147`, check/record/clear, two messages, tests. v1 has already designed and debugged it | ⭐ **BUILD.** Now genuinely necessary: an insider at a terminal can otherwise enumerate PINs for free |
| **T-302** | **~0.5 day of code, plus an operational step with real risk** | ⛔ **DEFER — recommendation below** |

## ⛔ Recommend deferring T-302, and I was invited to say so

**Under layer 1, the store is known when the PIN is typed. So `pinLookupHash(storeId, pin)` — what
the code does today, unchanged — already identifies exactly one person.** T-302 is not required for
PIN-only identification, not required for DEF-333, and not required by T-303.

**What T-302 buys:** a person who works at **more than one branch** types the same six digits at
both instead of two different ones. **That is the entire benefit.**

**What it costs, and all of it is self-inflicted:**

- ⭐ **All five load-bearing sites exist only because of T-302.** Keep store-scoped hashing and the
  inverted guard at `sessions.ts:93-97` never fires, the retire-loop bug never appears,
  `countActiveCredentials` stays correct, and the **blocking** readiness gate stays correct.
  **Defer T-302 and four of the five defects cease to exist rather than being fixed.**
- The dummy-scrypt constant-cost fix is likewise only needed because T-302 makes the case reachable.
- ⚠️ **Both production PINs must be re-issued in the same sitting as the deploy** — on a system where
  PIN sign-in is *currently broken* (DEF-333) and **every deploy has been failing since 2026-09-12**
  (DEF-327). **Doing a credential re-issue in the same window as repairing a broken sign-in path is
  the riskiest step in the whole plan, and it is the one buying the least.**

> ⭐ **The number that decides it, and nobody has stated it: how many staff work at more than one
> branch?** Bible §1.1 names seven stores and one live franchise with a separate owner. **If the
> answer is zero or near-zero, T-302 buys nothing at all.** If several people rotate between
> branches, it is a genuine daily convenience and worth the half-day — *after* T-304 and T-303 are
> in and sign-in works again.

**Recommendation, said once:** ship **T-304 + T-303** now; hold T-302 until sign-in is healthy and
Ian has seen that number. ⛔ **If Ian still wants it, build it** — it is his call, the work is
specified and ready, and org-scoped hashing makes it safe. **I am not asking for the ruling to be
re-opened; I am asking for it to be sequenced.**

---

# ⛔ RULING — how `{orgId, storeId}` travels from layer 1 to layer 2

**RE-RESOLVE SERVER-SIDE FROM THE FIREBASE ID TOKEN. Do not carry a signed cookie.**

Layer 2 presents the ID token the tablet already holds; the server verifies it and re-resolves
`{orgId, storeId}` through `findActiveCredentialByExternalId` — the same lookup layer 1 used,
already lookup #2 on row 194's door, **nothing added**. The tenancy id is derived server-side on
every request and **never leaves the server**.

## Why not the signed cookie, on four grounds — and the first is the one that decides it

1. ⛔⛔ **A signed cookie BREAKS THE LOST-TABLET RUNBOOK I JUST WROTE.** Step 2 is *"unlink the
   terminal credential → no future layer-1 sign-in resolves."* **That is only true if layer 2
   re-checks the credential.** A cookie already minted keeps asserting *"I am the terminal at store
   X"* until it expires, so a thief holding a live cookie retains a working layer-1 context after
   the credential is revoked. **Re-resolving makes revocation take effect on the next keystroke.**
   A capability that outlives its own revocation is not a shortcut, it is a hole.
2. ⛔ **The guard cannot see a cookie, so the tenancy id would be an UNGUARDED input.** T-231's
   guard matches `formData.get('orgId')`, `str(formData, …)` and body/query shapes
   (`tests/unit/no-client-supplied-actor.test.ts:86,100`) — **FormData patterns only.** An `orgId`
   in a cookie satisfies the guard by being invisible to it. ⭐ **That is precisely the shape of
   three defects found this week** — DEF-321, DEF-329 and DEF-333, each *"a guard whose blind spot
   is the input nobody classified as an input."* Adding a fourth, deliberately, the week we named
   the pattern, would be indefensible.
3. **T-231's rule is not narrower than its title, and its own words close this.** The guard shipped
   with **no exemption list**, on the stated ground that *"no screen ever needs to be told its own
   org."* A signed cookie is the server telling a screen its own org and being told it back.
   ⚠️ **The `signSetupIdentity` precedent is real but does not reach:** it carries a *verified uid*
   across a 10-minute first-run window **when no organisation exists yet** — there is no tenancy to
   leak because there is no tenant. Using it to justify carrying an `orgId` *once an org exists*
   extends it past its own justification.
4. ⭐ **The cost objection does not survive checking.** `verifyIdToken` validates the RS256
   signature **against cached Google public keys — local crypto, not a network call**
   (`apps/erp/src/lib/firebase-auth-admin.ts:20-23`; `:103` calls it without `checkRevoked`, which
   is the option that *would* hit the Auth API). `getIdToken()` is cached client-side and refreshed
   about hourly. **So re-resolving costs one local signature check plus one indexed read — the read
   layer 1 already does.**

## ⭐ It composes with the throttle ordering, and that is not a coincidence

**resolve the terminal → the store is now known → throttle-check that store → only then the PIN
lookup and the KDF.** The carrier question and the ordering question have the same answer because
they are the same question: *what does the server know for itself, and when?* ⛔ With a cookie the
throttle key would come from the client's assertion of which store it is; with re-resolve it comes
from the server's own resolution. **A locked store then costs two indexed reads and no scrypt**,
which is v1's C-7 rule — *the check must run BEFORE the expensive reads*.

## ⚠️ What this costs, stated rather than waved at

The auth door is now touched **on every PIN submission** rather than once per sign-in. That is
acceptable — it is what the door is for, and `findActiveCredentialByExternalId` is one indexed read
— but it is a real change in how hot that path runs and it should be said out loud rather than
discovered in a profile.

⭐ **And this is what reorders the lost-tablet runbook.** Because `verifyIdToken` runs **without
`checkRevoked`** — and ⛔ **cannot run with it: that flag needs a service account this deployment
deliberately does not have** (`firebase-auth-admin.ts:18-27`) — disabling the shared account in the
Firebase console does **not** invalidate a live ID token. **Our own `person_credentials` revocation
is the immediate step, and under re-resolve it bites on the very next PIN submission.**

> ⭐ **So the ruling and the runbook reinforce each other:** re-resolving is what makes credential
> revocation fast, and credential revocation is the only fast lever we have, because the Firebase
> half cannot be accelerated at all. **Had the signed cookie been chosen, the one lever that works
> would have been slow too** — see §"The lost or stolen tablet" for the reordered steps.

# ⭐ Terminal session lifetime — and the two lifetimes are NOT the same thing

**Ian ruled the terminal password is remembered on the tablet; staff only ever type a PIN.**

⛔ **The question "what is the terminal session's lifetime?" has no answer in `sessions.expires_at`,
and noticing that is the design.** Invariant 2 says **layer 1 creates no `sessions` row at all**, so
`expires_at` does not govern the terminal. There are two independent lifetimes:

| | What persists it | Lifetime | Why that is right |
|---|---|---|---|
| **Terminal (layer 1)** | the **Firebase** session on the device — a refresh token in browser storage, **not a row in our database** | ⭐ **Indefinite**, until Firebase revokes it, an admin disables the account, or the browser profile is cleared | The tablet is a fixture. Making staff retype a shared password each morning is how it ends up on a sticky note beside the till |
| **Person (layer 2)** | `sessions` row, `PIN_SESSION_TTL_MS` | ⭐ **12 hours — a shift. Unchanged, and deliberately short** | The tablet stays signed in; **the identity does not.** A cashier's session must not still be live when the next person picks the tablet up |

> ⭐ **That split is exactly what Ian asked for, and it is worth naming because inheriting one
> lifetime for both is the easy mistake.** A long terminal session is a convenience; a long *person*
> session is someone else's postings under your name. **Nothing in T-304 changes
> `PIN_SESSION_TTL_MS`, and it should not be quietly raised to match the tablet.**

⚠️ **And a permanently-signed-in tablet makes invariant 8 load-bearing every day, not only at
cutover.** A terminal whose Firebase session never expires is a standing, typed-in-able credential
sitting in a shop. **The refusal is what stops it being a skeleton key**, and it protects an
attacker's easiest path — the ordinary email form — for the whole life of the deployment.

## ⛔ The lost or stolen tablet — and `unlinkCredential` alone does NOT answer it

**`unlinkCredential` (`packages/auth/src/credentials-admin.ts:175`) does what it says**: it revokes
the credential **and** ends that person's live sessions, in one transaction, reusing
`endAllForPerson`. Verified, including its own note that *"the blast radius is the PERSON, not the
credential"* and that it is kind-agnostic on purpose.

⛔⛔ **But under invariant 2 it ends ZERO sessions for a terminal, and that is the whole problem.**
The chain, checked rather than assumed:

1. `endAllForPerson(tx, personId, reason, storeId?)` filters on **`person_id`** and optionally
   `store_id` (`packages/db/src/repo/sessions.ts:273-287`). **There is no device filter anywhere in
   the sessions repo** — `device_id` is written and selected, never used as a predicate.
2. The terminal person owns **no sessions** — layer 1 creates none.
3. The live session on the lost tablet belongs to the **real person** who last entered a PIN, with
   `device_id` = the terminal.

> **So revoking the terminal credential stops FUTURE layer-1 authentication on that tablet and
> leaves the session that is live on it right now untouched.** Under Ian's "remembered password"
> ruling, that live session is precisely the thing that matters.

⭐ **The gap is small and the fix is one repo function**, and it is new work this task must carry:

- **`endAllForDevice(tx, deviceId, reason)`** — the same shape as `endAllForPerson`, filtering on
  `device_id`. `'revoked'` is already a valid `SessionEndReason`.
- The lost-tablet response becomes **both**: revoke the terminal credential *and* end every live
  session on that device.

### The runbook — a tablet goes missing

> ⛔ **STANDING FORMAT FOR EVERY STEP IN EVERY RUNBOOK THIS PROJECT WRITES.** Each step states two
> things separately: **what it does to access that is ALREADY LIVE**, and **what it does to the NEXT
> attempt.** ⚠️ **Twice in one day a mitigation believed to be decisive turned out to be
> future-tense** — `unlinkCredential` against a terminal, and the Firebase console disable. Both
> *looked* like they stopped the thief and both act on the next attempt. **An incident runbook whose
> steps do not distinguish the two tells an operator they are safe while somebody is still inside.**

**Fastest-acting first. The order is the point, not the list.**

| # | Step | Effect on access ALREADY LIVE | Effect on the NEXT attempt |
|---|---|---|---|
| **1** | ⭐ **Revoke the terminal's `person_credentials` row** (`unlinkCredential`) | — | ⛔ **Immediate.** Under the re-resolve ruling, layer 2 re-checks the credential **on every PIN submission**, so the very next PIN typed on that tablet is refused |
| **2** | ⭐ **`endAllForDevice`** | ⛔ **Immediate.** The cashier's live session on that tablet ends at once, rather than up to 12 hours later | — |
| **3** | **Disable the shared account in the Firebase console** (Ian's, and only his) | ⚠️ **NOT immediate — the slowest of the three.** An already-minted ID token stays valid until it expires; we cannot shorten that (see below) | Stops a new ID token being minted once the current one expires |
| **4** | Re-provision a replacement tablet with a **new** shared account | — | — |

⛔ **Steps 1 and 2 are what actually stop the thief, and both are ours.** Step 3 is necessary
belt-and-braces, not the decisive act — ⚠️ **and it is the one most likely to be mistaken for the
decisive act**, because "disable the account" sounds final.

### ⛔ `checkRevoked: true` is NOT AVAILABLE and must not be proposed

**Not a latency trade-off — a credential this deployment does not have and refused on purpose.**
`apps/erp/src/lib/firebase-auth-admin.ts:18-27`: `verifyIdToken` is public-key work needing only a
project id, and *"a service account would buy exactly one extra thing — `checkRevoked: true`."*
**This app initialises its admin app with a project id and no credential**, deliberately, and
identity and storage are separate projects on purpose so it cannot borrow the storage service
account either. ⭐ **Somebody already thought this through and wrote the note** — *"because 'we could
not verify revocation' is a real limitation and a silent one."*

⛔ **Recorded as unavailable rather than as an option**, because a future reader who finds it listed
as a trade-off will try to turn it on and discover it needs infrastructure that was refused by
design. ⚠️ **I previously flagged it as "an Auth API call per verification" — that understated it
and the correction is the orchestrator's.**

### ⚠️ The window is ONE HOUR for us. The "5 minutes" in that comment is not our number

**Our exposure today: an already-minted ID token is valid until it expires — up to ONE HOUR — and
it cannot be shortened.** That is the number the runbook uses and the number to quote.

⛔ **The repo comment's *"a 5-minute window on a 1-hour token"* describes a configuration we do not
run.** The full clause is about what a service account *would* buy:

> *"A service account would buy exactly one extra thing — `checkRevoked: true`… **That is a 5-minute
> window on a 1-hour token** and it is not what stands between Ian and his own books today."*

**"That" is the counterfactual, not our state.** ⚠️ **Do not quote the five minutes as our exposure**
— it is a sentence about the option that was refused, and reading it as a description of what we run
is exactly the failure this project spent 2026-09-13 removing from nine other documents: a true
statement, read as applying to a state it does not describe.

⚠️ **And the clause admits two readings of *what* the five minutes measures**, which I could not
settle from the sentence and am recording rather than papering over:

| Reading | The five minutes is… | If someone later prices a service account |
|---|---|---|
| **(a)** | the exposure **with** `checkRevoked` — 60 min → ~5 min | a large improvement |
| **(b)** | the **marginal** gap `checkRevoked` closes — small on a 1-hour token | a small improvement, which fits the author's dismissive *"not what stands between Ian and his own books"* |

⭐ **It does not matter for the runbook — both readings agree our number is up to one hour** — but it
matters the day anyone asks *"should we buy the service account?"*, because the two readings give
opposite answers. **Establish which before pricing that decision; do not inherit either.**

**Tests:** unlinking a terminal credential ends that tablet's session and **no other person's PIN
session at the same store**; and a PIN session on a *different* device survives both.

# ⛔ WHAT MUST BE TRUE BEFORE THIS IS SAFE TO DEPLOY

**Not the done-when. The PRE-conditions.** Ian will be doing this on a production system where PIN
sign-in is **already dead**, so *"the way back in is email sign-in"* has to be true at **every
intermediate step**, not merely at the end.

## ⭐ The reassuring fact, stated first because it changes how much risk this carries

**PIN sign-in in production is at zero today** (DEF-333: the store list returns no rows, the PIN
form is hidden). **T-304 cannot make it worse.** Every failure mode below is *"still broken"*,
never *"newly broken"* — with one exception, which is the `signInWithFirebase` hazard above, and
that is why it is a refusal with a test rather than a note.

⭐ **And with T-302 deferred, this cutover touches ZERO credentials.** The lookup key stays
`storeId:pin`, so **both live PINs keep working across the deploy** and the one Firebase credential
is untouched. **Nothing is re-issued, nothing is invalidated, and there is no window in which a
working credential stops working.** That is the deferral paying for itself.

## Preconditions, in order. None may be skipped

| # | Must be true | How it is known |
|---|---|---|
| **P0** | ⛔ **A deploy actually lands.** DEF-327 (migrate refused, `permission denied for database defaultdb`) and DEF-325 (CI red ⇒ Deploy skipped) are both cleared | A Deploy run reporting migrations applied **and** the service restarting. ⛔ **Prove the pipeline on something that does not matter before using it for this** — nothing has deployed since 2026-09-12 07:13 UTC |
| **P1** | ⛔ **Ian can sign in by email, verified in the minutes before starting** — not remembered from yesterday | Sign in, see the app. This is the way back in; if it is not true, **stop** |
| **P2** | **A terminal credential can be created at all** | See the gap below — ⚠️ **this is a scope correction** |
| **P3** | The `signInWithFirebase` refusal and the terminal-person guard are in the shipped build | Their tests, green |
| **P4** | `0147` is additive-only | A new table. Old code ignores it, so a rollback leaves the schema harmlessly ahead (bible §15.5, expand/contract) |

## ⛔ SCOPE CORRECTION — I put terminal provisioning out of scope, and that was wrong

My first draft listed *"the terminal-credential provisioning UI"* under Out of scope. **If it is out
of scope, then after this deploys there is no way to create a terminal credential and PIN sign-in
stays dead — shipped, green, and unusable.** That is the exact shape this project has hit six times
this week, and the orchestrator's instruction was not to make it seven. **Correcting my own scope:
a provisioning path ships with T-304.**

**Minimum viable, and it follows an established pattern rather than inventing one:** a
`scripts/provision-terminal.ts` one-shot, shaped like `scripts/bootstrap-org.ts` — *"a one-shot that
writes to the live database, run by a person, not by an agent"*. Ian creates the email/password
account in the Firebase console (that part is not ours and cannot be), then runs the script with the
uid and the store code. An admin screen can follow later; the script is what makes the deploy usable.

## The cutover, in order

1. **P0 and P1.** Prove the deploy pipeline; prove email sign-in works, right now.
2. **Deploy T-304 + T-303 together.** `0147` is additive and inert until layer 2 calls it.
3. ⛔ **Sign in by email again, immediately.** If this fails, stop and roll back — nothing else has
   been touched yet and no credential has changed.
4. Ian creates the store's shared Firebase account in the console.
5. Ian runs `provision-terminal` for that store.
6. **Test layer 1** on a device: the shared credential signs in and the PIN box appears **with no
   store chosen anywhere**.
7. **Test layer 2**: type one of the two existing PINs → identified, session issued, and
   `sessions.device_id` carries the terminal.
8. ⭐ **Test the refusal**: type the store's shared email and password into the **admin** email form.
   It must be refused. **If it signs in, stop and roll back** — layer 2 is bypassable.

## If layer 1 works and layer 2 does not

| Symptom | Way back in | Notes |
|---|---|---|
| PIN box appears, no PIN identifies anyone | ⭐ **Admin email sign-in, unaffected** → `/staff` → re-issue a PIN | The 2 existing PINs are unchanged by this deploy, so a failure here means a code fault, not a credential fault |
| The throttle locks a store wrongly | Admin email sign-in; the lock expires on its own within the cooldown | ⚠️ **Worst case is one branch waiting out a cooldown**, which is v1's *"the DoS blast radius is only the cooldown window"* |
| Layer 1 itself fails | Admin email sign-in | PIN sign-in returns to the state it is in today: dead. **No regression** |
| ⛔ The admin email form is broken by the rewrite | ⛔⛔ **Nothing. This is the only unrecoverable case** | **Therefore it is invariant 7 and test 6, and step 3 exists to catch it before anything else is done** |

**Rollback** is repointing `/srv/shareat` at the previous timestamped release and restarting —
the symlink swap the deploy already uses, in reverse. `0147`'s table is additive and is left in
place; old code does not know about it.

> ⛔ **The sentence this section exists to make true:** *at every step above, an admin signing in
> with email and password reaches the app.* It is true at step 1, 3, 6, 7 and 8, and after a
> rollback. **The single step that could make it false is the sign-in page rewrite — which is why
> step 3 is a full stop and not a glance.**

# Scope

**Create only, this slice:** this document, plus the revisions to `302-*.md` and `303-*.md`.
**No code.** ⛔ Not mine: `docs/tasks/301-*` (lane A) · the register · the bible · `.github/`.

**On approval, T-304 touches:** `packages/db/schema/persons.ts` + migration (option (a)'s terminal
flag) · `packages/auth/src/sessions.ts` · `apps/erp/src/app/sign-in/{page.tsx,actions.ts}` ·
`apps/erp/src/lib/session.ts` · `tests/unit/no-direct-transaction-in-erp.test.ts` · a new guard
test · integration tests.

# Invariants

| # | Invariant |
|---|---|
| 1 | ⛔ **No capability check, ledger posting or audit row ever names the terminal.** `sessions.person_id` is always the real person |
| 2 | Layer 1 creates **no** `sessions` row |
| 3 | The PIN lookup runs under a principal — it is no longer a pre-auth door lookup |
| 4 | `PRE_AUTH_PATHS` **shrinks** by one and gains nothing |
| 5 | A terminal credential is scoped to exactly one store; its org and store come from the credential, never from the client |
| 6 | Every sign-in failure at either layer returns one flat sentence |
| 7 | ⛔⛔ **The admin email form is present and working on the sign-in page at all times** — whether or not a terminal credential exists, whether or not one is signed in, and whether or not layer 2 errors. **This is the only unrecoverable failure in the cutover** |
| 8 | ⛔ **`signInWithFirebase` refuses a terminal-kind person.** A shared store credential typed into the admin form must never yield a session |
| 9 | ⛔ **`orgId` and `storeId` are never carried by the client in any form** — not a field, not a cookie, not a query string. Layer 2 re-resolves them server-side from the ID token on every submission. See §Ruling |

# Tests — failing first, for the right reason

1. A terminal credential signs in and reaches the PIN step **without any store being chosen**.
2. ⭐ After a PIN identifies a person, `sessions.person_id` is **that person** and `device_id` is the
   terminal. **Fails today** — `device_id` is always null on this path.
3. ⛔ A terminal person (option (a)) can hold **no** role and appears in **no** staff listing.
4. `PRE_AUTH_PATHS` no longer contains `sign-in/page.tsx`, guard still green with its positive control.
5. A PIN valid in org A does **not** identify anyone from a terminal in org B.
6. ⛔ **Admin email sign-in works with NO terminal credential in the database, and again with one
   signed in.** Invariant 7 — the unrecoverable case, so it is tested from both states.
7. ⛔⛔ **The store's shared email and password, typed into the ADMIN email form, are REFUSED** with
   the same flat sentence. **Fails today by construction** — there is no such refusal — and it is
   the test that stops layer 2 being bypassable.
8. A terminal-kind person can hold no role, appears in no staff listing, and is excluded from
   headcount (the build-enforced guard).
9. `provision-terminal` creates a usable terminal credential, and refuses to create a second one for
   a store that already has a live one.
10. ⛔ **`endAllForDevice` ends the lost tablet's live session and nothing else** — a PIN session
    held by another person at the same store, and one held by the same person on a different device,
    both survive. **Fails today by construction**: no device-scoped session query exists.
11. ⭐ **A terminal session is not a `sessions` row at all** — after layer 1 and before any PIN,
    `select count(*) from sessions` is unchanged. This is invariant 2 stated as a test, and it is
    what makes the lifetime split real rather than intended.
12. ⛔ **Revocation takes effect on the NEXT PIN submission, not on the next expiry.** Unlink the
    terminal credential while a tablet sits on the PIN screen; the next PIN entered is refused.
    **This is the test that proves the carrier ruling** — it passes with server-side re-resolve and
    fails with a signed cookie, which is the whole reason the cookie was refused.
13. ⭐ **No tenancy id reaches the client.** Assert that the layer-2 request carries neither `orgId`
    nor `storeId` in any field, cookie or query parameter. ⚠️ **The existing T-231 guard cannot
    catch this** — it scans FormData patterns only — so this test is what extends that rule to the
    shape the guard is blind to.

# Out of scope

T-302 (deferred — §Assessment) · biometrics · `attendance_credentials` · rotating `SESSION_SECRET`
(DEF-335) · an admin **screen** for terminal provisioning — ⚠️ **but not provisioning itself**: a
`scripts/provision-terminal.ts` one-shot ships with this task, because without it the deploy is
unusable. See §Preconditions.

# ⚠️ What I did not verify

- **Nothing was run except the timing measurement**, which is in §Q5 and was run on this machine,
  not on production hardware. No test, typecheck or build.
- **How many staff work at more than one branch** — the number T-302's whole value turns on.
- **Whether Ian wants the shared credential typed by staff or stored in the browser.** If staff type
  it every shift it will be written on a sticky note by week two; if it is stored, the browser
  profile becomes the credential. **Both are normal for terminal apps and the choice is his** —
  flagging, not deciding.
- **Option (a) versus (c)** — I recommend (a) on door cost alone and would choose (c) if the ruling
  were free.
