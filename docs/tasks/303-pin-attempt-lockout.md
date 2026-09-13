# T-303 — ten wrong PINs in a minute, then that store waits two

> ✅ **Status: SHIPPED AND DEPLOYED 2026-09-13**, in `58f198a` alongside
> [T-304](./304-two-layer-terminal-sign-in.md), and live in production with migration `0147`
> (`pin_attempt_throttle`). ⚠️ **The throttle itself was not exercised during the cutover** — a
> correct PIN was entered first time, so the 10-miss / 60-second / 2-minute cooldown path has run
> only in tests. **It is deployed, not field-proven; say it that way.**
> ⭐⭐ **REVISED 2026-09-13 — [T-304](./304-two-layer-terminal-sign-in.md) DISSOLVES THIS TASK'S
> STOP CONDITION.** The PIN is now typed **inside an authenticated terminal session**, so the org
> and store are known when a miss is recorded. **The counter is an ordinary `org_column` table on
> migration `0147`: no `system_only`, no fifth pre-auth door, no new `RlsScope`, no ADR, no
> in-memory Map, no cookie, no IP backstop.**
>
> ⛔ **Ships with T-304, not with T-302.** T-302 is recommended for deferral (T-304 §Assessment);
> **this task does not depend on it** and is needed either way — an insider at a terminal can
> otherwise enumerate the PIN space for free.
>
> ⚠️ **§Q1 and §Q2 below are kept as REJECTED ALTERNATIVES**, not as the design. Their reasoning is
> why the server-side per-store counter is worth more than what they proposed.
>
> ⛔ **AND THAT IS EXACTLY WHY THIS DOCUMENT SHIPPED CONTRADICTING ITSELF — repaired 2026-09-13
> after lane A stopped rather than guessing, which was the right call.** Three statements still
> described the rejected draft as though it were the plan: the recommendation block gave the cookie
> mechanism *and* the superseded 5/5-minute numbers; a test asserted an IP backstop the adopted
> design has no IP for; Out of scope excluded persisting the counter, which the design does on
> migration `0147`. **All three sat ABOVE the section that supersedes them, so a reader met the
> stale half first.**
>
> ⭐ **This is the same failure mode this lane has found three times today in other people's
> artefacts** — bible §13 row 194 versus `PRE_AUTH_PATHS`; nine timer files versus eight armed
> timers; `PROJECT_BIBLE.md:1503` versus `docs/ops/README.md`'s `count(*) → 0`. **Two statements
> about one subject, both written in good faith, never reconciled, and the stale one reached first.**
> A spec that carries its own rejected draft is the same shape as a register row that carries its own
> superseded diagnosis — and I reported this file as updated *"throughout"* when it was not, which is
> how the shape survives review. **Superseded prose must be struck at the point of supersession, not
> left standing because a newer section exists further down.**

## Ian's ruling

> *"limit pin wrong pin to 5 and add device login cooldown 5 minutes on failed attempts display a
> message if you forget your pin ask an admin to reissue"* — Ian, 2026-09-13.

**Ian's instinct was 5 wrong PINs → 5 minutes; he ruled 10 / 60 s / 2 minutes after seeing v1's
tuning — see §Tuning.** Plus standing text saying a forgotten PIN is
**re-issued**, never recovered.

## ⭐ Per DEVICE, not per person — and it is the only coherent choice

Worth stating because it looks like a simplification and is not:

**A failed PIN identifies nobody.** The attempt carries six digits and nothing else. There is no
account to lock, because the whole point of a failure is that no credential matched. Locking "the
account it would have matched" is not available — that account is precisely what we failed to find.

⭐ **And the property that falls out of it is worth keeping deliberately:** because the counter
attaches to the device and not to an identity, **this control can never be used to lock a real
person out of their own account by guessing at them.** A per-person lockout would hand any
passer-by a way to take a cashier off a till. This one cannot, by construction.

---

# ⛔ Q1 and Q2 BELOW ARE THE REJECTED DRAFT. THE DESIGN IS FURTHER DOWN

> **Everything from here to §"THE DESIGN" answers a question that no longer exists** — *what is a
> device before anyone has signed in?* Under T-304 the PIN is typed inside an authenticated
> terminal session, so there is no such moment. **Nothing in these two sections is an instruction.**
> They are kept because the reasoning about bypassability is what earns the server-side counter its
> place, and because the registry analysis in Q2 is why the table is `org_column` rather than
> `system_only`.
>
> ⚠️ **Any threshold, cooldown or mechanism named below is SUPERSEDED.** The constants are
> **10 misses / 60 s / 2 minutes** and they are stated once, in §Tuning.

# ~~Q1 — what is a "device" before anyone has signed in?~~ (rejected draft)

## ⛔ There is no device identity on this path today. None at all

**Verified.** `signInWithPin` accepts `deviceId?` (`packages/auth/src/sessions.ts:65`), and the one
production caller — `apps/erp/src/app/sign-in/actions.ts:43` — **does not pass one**. It calls
`signInWithPin(null, { storeId, pin })`. The field exists and is always `null` on this path.

⭐ **A real, server-attested device identity does exist in this system, and it does not help here.**
`clock_terminals` (T-159) gives a provisioned tablet a Firebase identity of its own —
`terminalFirebaseUid(id)` = `terminal:{id}`, and *"this id IS the `deviceId` claim"*
(`packages/db/schema/clock-terminals.ts:35`). That is genuinely unforgeable: the device signs in to
Firebase as itself and the server minted the claim. ⛔ **But it exists only on provisioned clock
terminals**, and the PIN sign-in page is an ordinary browser page with no such token. Requiring one
would mean provisioning every device that can reach `/sign-in`, which is a far larger change than
Ian asked for.

## The options, honestly costed

| | Mechanism | Bypass | Collateral | Verdict |
|---|---|---|---|---|
| **A** | **Server-issued `httpOnly` cookie**, random id, set on first visit to `/sign-in` | ⚠️ **One click.** Clear site data, or a private window | None — it is per-browser-profile | ⭐ **Ship this** |
| **B** | **Source IP** | A phone's hotspot; any VPN | ⛔ **Bad.** A branch NATs to one address, so one attacker takes the whole store offline for 5 minutes | Not alone |
| **C** | **Both**, different thresholds | Needs a new IP *and* a cleared cookie | Bounded if the IP threshold is set well above normal use | ⭐ **Ship as the backstop** |
| **D** | Reuse the `clock_terminals` device claim | Not bypassable | ⛔ Does not exist on this page | Not available |

## ~~Recommendation: A + C~~ — ⛔ REJECTED. NOT THE DESIGN. DO NOT BUILD THIS

> ⛔ **This paragraph described a cookie-plus-IP counter at 5 misses / 5 minutes. Both halves are
> dead:** the mechanism was replaced by the server-side per-store counter (§THE DESIGN) and the
> numbers were superseded by Ian's ruling of 10 / 60 s / 2 minutes (§Tuning). It is struck through
> rather than deleted **only** so the argument below still has a subject.

⭐ **What survives from it, and the only thing that does:** an honest account of *why a client-held
counter is worth less than a server-held one* — which is the argument for the adopted design.

⚠️ **Stated plainly, as instructed: the cookie is bypassable in one click, and this is still worth
shipping.** The reasoning, against the actual threat rather than an imagined one:

- ⭐ **The real attacker is a person tapping guesses at a tablet on a counter, in a shop, in front of
  staff.** For that person, "clear browser data every fifth guess" converts a silent, idle,
  deniable activity into a repetitive, visible, obviously-wrong one. **That is most of the value of
  the control**, and no cryptographic device identity would add much to it.
- **Against a remote scripted attacker the cookie is worth nothing**, and the IP backstop is worth
  something but not much. ⛔ **So do not describe this as protection against remote brute force. It
  is not.** What actually bounds that threat is the size of the keyspace and the absence of a
  public terminal endpoint — and, after T-302, one fewer factor than before.
- **A control that is honest about its limit is reviewable.** One that is described as stronger than
  it is stops anyone asking the next question.

---

# Q2 — where the counter lives. ⛔ STOP CONDITION: THE TABLE VERSION NEEDS A RULING

**You asked me to confirm rather than assume, and to stop if it needs a door. It does. Here is
exactly why, and a way to ship without one.**

## The trap, precisely

Bible §2 rule 4 points at a table. A table here is **written before authentication**, which is
DEF-333's exact shape. Worse, the blocker is not RLS in general — it is the **registry**:

`packages/db/src/rls/registry.ts:17-24` defines **four** scopes and no others, and an unlisted table
**fails the build**:

| Scope | Fits a PIN-attempt counter? |
|---|---|
| `org_column` | ⛔ No. A failed attempt belongs to **no organisation** — not knowing the org is the definition of the moment |
| `derived` | ⛔ No parent to derive from |
| `self` | ⛔ No |
| `system_only` | ⚠️ The only one that fits — **and it is defined as** *"RLS enabled with NO staff or customer policy. Only the system principal can read it."* |

⛔ **So classifying it `system_only` forces every read and write through `systemTransaction` — which
is a FIFTH pre-authentication cross-org caller, exactly what bible §13 row 194 closes and exactly
what DEF-333 is about.** `packages/db/src/client.ts:130-140` confirms the shape: the `system_only`
tables carry FORCE RLS with **zero policies**, so *"no principal can ever satisfy them."*

**Building a rate limiter for a security gap in a way that recreates the outage it sits next to
would be a bad day, and that is where the obvious design lands.**

## Three ways out. I am not choosing between 2 and 3

**Option 1 — ⭐ IN-MEMORY, and I recommend it for the first ship.**
A `Map` in the Next.js server process, keyed by cookie id and by IP, with timestamps.
- ✅ **No table, no migration, no RLS classification, no door, no pre-auth write.** It cannot
  recreate DEF-333 because it touches no database at all.
- ✅ **Operationally sufficient today, verified:** `docs/ops/shareat-erp.service` is `Type=simple`
  running a single `npm run start`, one process, `Restart=always`. There is one process to hold the
  Map, and there is no horizontal scaling to break it.
- ⚠️ **Cost, stated:** the counter resets on restart or deploy. An attacker cannot cause a restart,
  so the practical exposure is "a deploy forgives in-flight attackers", which is negligible.
- ⚠️ **Rule 4:** bible §2 rule 4 is *"no entity's authoritative state lives in Firestore"* — it is
  about Postgres versus Firestore for **entities**. A five-minute rate-limit counter is not an
  entity and has no authoritative state to lose. ⛔ **That is my reading and it is a judgement, not
  a quotation. If you read rule 4 as covering this, option 1 is off the table and we are at a
  ruling.**

**Option 2 — a table classified `system_only`.** Correct-by-the-registry, durable, and **requires a
fifth pre-auth door** → Ian's ruling under row 194.

**Option 3 — ⭐ a fifth `RlsScope`, e.g. `tenant_neutral`, for a table with no org dimension.**
Arguably the cleaner architectural answer: it does **not** widen row 194's door and adds no cross-org
read. The table would hold a device id, a counter and a timestamp — **tenant-neutral by
construction, with no column that could carry tenant data.** ⚠️ It is still an architectural change
(a registry kind plus an ADR), and the risk is that a later table gets classified that way lazily.
Mitigation: require an explicit prose reason, as the registry already does, and keep the kind to a
short allow-list.

> ⛔ **I have not chosen between 2 and 3, and I am not going to. Both need a ruling and they are
> different rulings.** Option 1 ships Ian's control now with zero architectural risk; 2 or 3 can
> follow if a second process ever exists. **Recommend approving option 1 for T-303 and raising 3 as
> a separate question when it is actually needed.**

## Putting it to Ian, if it comes to that (bible row 200)

> **The question:** where should the "five wrong PINs" counter be remembered?
>
> **The simple way** remembers it in the app's memory. It works, it costs nothing, and it forgets
> everyone when we deploy an update — so someone who was locked out at that moment gets another try.
> That is the whole downside.
>
> **The thorough way** writes it to the database so it survives restarts. But the sign-in screen is
> the one place where nobody has proved who they are yet, and the database has just been locked down
> so that unidentified visitors can read almost nothing — **that lockdown is what broke PIN sign-in
> this week.** Writing there before sign-in means opening a small, named exception, and you are the
> only person who can approve one of those.
>
> **Recommend the simple way now**, and the thorough way only if we ever run the app on more than
> one machine.

---

# Q3 — the two messages

Two distinct moments and they are not the same sentence.

## A · Standing text — always visible under the PIN box

> **Forgot your PIN?** Ask an admin to issue you a new one. PINs cannot be looked up — a new one is
> the only way back in.

⭐ **The second sentence is doing real work.** *"Cannot be looked up"* sets the expectation before
the person asks, and it is **true** (`hashPin` is scrypt with a random salt). ⚠️ It is true *for the
people reading it*; T-302 §Q2 records that a holder of `SESSION_SECRET` plus the database can
recover a PIN by exhausting a six-digit keyspace. **That is a fact about our own key material, not
about what an admin can do from a screen** — no screen offers it, no code does it, and the sentence
is honest to its audience.

## B · The cooldown — replaces the form

> **Too many wrong PINs.** This terminal is paused until **3:47 PM**. A manager can still sign in
> with their own email and password.

- **Name the clock time, not "5 minutes".** A person who reads it two minutes in should not have to
  do arithmetic.
- ⭐ **Point at the way out.** Admin email sign-in is a separate path and is unaffected, so a branch
  is never fully locked out. That sentence is the difference between a control and an outage.
- **"This terminal"** — ⚠️ **accurate under the revised design and it must say terminal, not
  device**: the counter is per **store**, so every tablet at that branch is paused together. Saying
  "this device" would send someone to fetch another tablet, which will not help and wastes a
  minute at exactly the wrong time.

## ⛔ What neither message may say

**Nothing may distinguish a wrong PIN from an unknown one.** `BAD_PIN` is already one flat sentence
for every failure (`sessions.ts:72`), deliberately. ⭐ **T-302 raises the stakes on that:** once PINs
are global, a message that separated *"that PIN does not exist"* from *"that PIN is not yours"*
would confirm to a guesser that a valid PIN had been found. **The flat sentence is load-bearing and
must stay flat** — including on the lockout path, which must not reveal whether any of the five
attempts was close.

⚠️ **And the counter must advance identically for both outcomes**, or the lockout arriving sooner
becomes the oracle the message refuses to be.

---

# Q4 — why this ships with T-302, and the timing question

## The justification, stated rather than implied

`packages/auth/src/credentials.ts:22-27` names **three** things that make a six-digit secret
acceptable: store scoping, a unique hash, and *"rate limiting belongs at the sign-in route."*

- **T-302 deliberately removes the first.** Every guess goes from testing one store's staff to
  testing the entire business.
- **The third was never built.** Verified across `apps/` and `packages/`: no throttle, no lockout, no
  backoff on the PIN path. The only `lockout` in the codebase is the **last-admin** guard
  (`packages/auth/src/roles.ts`), an unrelated concept.

> ⛔ **So without T-303, T-302 would ship a system where two of the three named compensating factors
> are absent, one of them removed on purpose the same day.** That is the justification, and it is
> why these are one change in two documents rather than a feature and a nice-to-have.

## ⚠️ The timing oracle: REAL, MEASURABLE, and CREATED BY T-302 — not pre-existing

**Mechanism.** `runPinSignIn` does an indexed lookup first; `verifyPin` runs scrypt **only if a row
matched** (`sessions.ts:86-99`). Node's `scrypt` at the default cost is on the order of **tens of
milliseconds**; the lookup is **sub-millisecond**. That is a 10-100× difference — not a
nanosecond-scale side channel, but something measurable over an ordinary network.

**Why it is not an oracle today.** The lookup hash is a deterministic function of the PIN, so a
matching lookup implies a matching scrypt. Today, a matching lookup also means *signed in* — and the
response says so. **Timing reveals nothing the outcome does not.**

**⛔ Why T-302 creates one.** T-302 replaces the unreachable store-**equality** guard with a store-
**scope** check. That makes a new case reachable:

| Case | Work done | Reply |
|---|---|---|
| PIN matches nobody | lookup only — **fast** | `BAD_PIN` |
| PIN matches a real person, **no scope at this store** | lookup **+ scrypt** — **slow** | `BAD_PIN` |

**Same sentence, different cost.** An attacker learns *"these six digits belong to someone in this
business, just not someone who works here"* — which is exactly what the flat sentence exists to
withhold, and exactly the disclosure global PINs make worth having.

**Fix, and it is cheap:** on the no-row path, run one scrypt against a **fixed dummy hash** and
discard the result, so both paths pay the same. ⭐ This belongs to **whichever task introduces the
scope check — i.e. T-302** — and is listed in T-302's scope, not here. **If T-302 is deferred, the
case is unreachable and the fix is not needed.**

⭐ **MEASURED 2026-09-13, and I had understated it by two orders of magnitude.** On this machine:
**one HMAC-SHA256 = 2.4 µs; one `scrypt` at the repository's parameters = 35.0 ms.**
⚠️ **Quote the absolute, not the raw ratio:** the real no-row path also pays an indexed query, so
the honest figure is **a flat +35 ms on the matched path** — far above network jitter, trivially
measurable, and nothing like the *"10-100×"* I first claimed. (Pure crypto is 14,529×, which
overstates the case on its own.)

---

# ⭐ THE DESIGN — per store, in Postgres, ported from v1

⛔ **Everything in §Q1 and §Q2 above is a rejected alternative.** This is the design.

## Why per STORE, and why that is now available

The counter is written after layer 1, so it carries the terminal's `org_id` and `store_id`. **The
key is the store** — which is what v1 chose, with its reasoning written out
(`ERP-rebuild/src/lib/actions/attendance-clock.actions.ts:440-450`):

> *"A miss on `resolveLocalUserByPasscode` is otherwise free, so the 10⁶ passcode space is
> enumerable against the terminal. We throttle PER STORE: once misses exceed a generous threshold
> within a short window, the terminal is locked for a brief cooldown. Threshold/cooldown are tuned
> so ordinary fat-finger misses never lock a store, while rapid enumeration is throttled to a
> trickle (and the DoS blast radius is only the cooldown window)."*

⭐ **Not bypassable by clearing anything** — it is server-side and keyed on a store the client does
not choose. That is the whole reason the cookie design below was rejected.
⚠️ **And the Caddy `X-Forwarded-For` caveat is moot**: no IP is involved, so there is nothing for a
proxy to misreport.

## The table — migration `0147`

`pin_attempt_throttle`, one row per store: `org_id`, `store_id` (unique), `fail_count`,
`window_started_at`, `locked_until`, `updated_at`.
**RLS registry: `org_column`** — *"a throttle belongs to a store, and a store to one org"*, the same
shape as a dozen existing entries. ⛔ `0147`'s journal `when` must exceed `1798687907084`.

## ⛔ Inherit v1's concurrency fix. Do not rediscover it

```
Already locked → leave the active cooldown intact; recording more misses
must NOT reset it (that was the concurrency lock-clobber bug).
```

**v1 has already paid for this one.** In `recordMiss`, if `locked_until` is in the future, **return
without writing**. Otherwise roll the window, increment, and set `locked_until` only on crossing the
threshold. ⭐ **One statement inside the caller's transaction** so concurrent misses count — v1 uses
a Firestore transaction for exactly this, and Postgres gives it to us with `INSERT … ON CONFLICT DO
UPDATE` plus a `WHERE` guard on `locked_until`.

⭐ **Check before the work, not after** — v1's C-7 note: *"the check must run BEFORE those reads, not
after."* A locked store costs one indexed read and no scrypt.
⭐ **Clear on success**, and v1's `hadMisses` trick is worth porting: skip the clear-write when the
counter is already empty, so the hot path writes nothing.

## ⚠️ The tuning divergence — recorded, not slipped in

| | Threshold | Window | Cooldown |
|---|---|---|---|
| **v1, tuned in production** | 10 misses | 60 s | 60 s |
| **Ian's first instinct, 2026-09-13** | 5 misses | — | 5 minutes |
| ✅ **RULED 2026-09-13 — BUILD THIS** | **10 misses** | **60 s** | **2 minutes** |

⭐ **Ian took the middle**: v1's proven threshold and window, with a cooldown longer than v1's 60 s
because he wants a wrong-PIN run to visibly stop, but well short of five minutes. **The argument
that landed was the availability one** — a longer cooldown is *strictly worse for availability and
only marginally better against enumeration*, because at 10 misses/60 s a guesser already gets only
~14,400 attempts a day against a space of 10⁶.

⚠️ **The reasoning that produced the recommendation is kept below**, because the constants will be
questioned again the first time a branch is locked out and the file should answer rather than
restate:

- ⛔ **5 misses is reachable by ordinary fumbling at a shift change.** Three or four cashiers
  handing one tablet round at 6 a.m., one of them new, one mistyping twice — that is five misses
  with no attacker present, and the branch then waits five minutes, which at a shift change is
  exactly when it hurts most. **v1's threshold of 10 exists because 5-ish was not enough headroom.**
- **A 5-minute cooldown is 5× v1's.** v1's reasoning is that the DoS blast radius *is* the cooldown
  window — so a longer cooldown is strictly worse for availability and only marginally better
  against enumeration: at 10 misses/60 s a guesser gets ~14,400 attempts a day against 10⁶, which is
  already a trickle.

⭐ **This is also why the numbers belong in one named constant block and not scattered** — they are
the part of this task most likely to be re-tuned from operational experience, exactly as v1's were.

# ~~Design~~ — rejected alternatives, kept for their reasoning

## Shape

A small module, `apps/erp/src/lib/pin-attempts.ts`:

```ts
recordFailure(key: AttemptKey): void
checkCooldown(key: AttemptKey): { blocked: true; until: Date } | { blocked: false }
clearOn Success(key: AttemptKey): void
```

`AttemptKey` = `{ deviceId: string; ip: string }`. Two independent windows, evaluated together:
**device 5 / 5 min** (Ian's numbers) and **ip 50 / 5 min** (the backstop).

⚠️ **The cooldown is checked BEFORE the credential lookup**, so a locked-out device costs no scrypt
and no query — the control also sheds load, which is the point of doing it at the route.

⭐ **A success clears the device counter, not the IP counter.** One person signing in correctly at a
shared branch tablet should not wipe the evidence of fifty failures from that address.

## The device cookie

`httpOnly`, `Secure`, `SameSite=Lax`, a random 128-bit id, long-lived, set on first `GET /sign-in`.
⛔ **It is an opaque identifier and carries no claims** — the same rule `newSessionToken` follows
(`credentials.ts:105-107`). It must never be treated as authentication, only as a counter key.

# Scope

**Create only, this slice:** `docs/tasks/303-pin-attempt-lockout.md`. No code.

**On approval, the build touches:** `packages/db/schema/` (the new table) ·
`packages/db/migrations/0147_*.sql` (**hand-authored** — ADR-012 §5; `db:generate` is retired) ·
`packages/db/src/rls/registry.ts` + `packages/db/src/cutover/classification.ts` (both refuse an
unlisted table at build time) · `packages/db/src/repo/` (the check/record/clear statements) ·
`packages/auth/src/sessions.ts` · the layer-2 route · tests.

# Invariants

| # | Invariant | Why |
|---|---|---|
| 1 | Every sign-in failure returns **one** sentence, whatever the cause | `sessions.ts:72` |
| 2 | The counter advances identically for unknown and wrong PINs | or the lockout is the oracle |
| 3 | The cooldown is evaluated **before** any credential lookup or KDF | cost, and v1's C-7 note |
| 4 | A cooldown never blocks **admin email** sign-in | the way back in |
| 5 | Every counter read and write runs **under a principal** — never pre-authentication | ⛔ DEF-333 |
| 6 | ⛔ **Once locked, further misses never extend or reset the cooldown** | v1's concurrency lock-clobber bug |
| 7 | Concurrent misses all count — the increment is transactional | v1 |
| 8 | The counter is keyed on the **store from the session**, never on a client-supplied value | |

# Tests — failing first, for the right reason

1. Ten misses inside 60 s at one store → the eleventh is refused with the cooldown message, **and no
   credential lookup or scrypt runs** (assert via a spy, not by timing).
2. After the cooldown, the same store gets another attempt.
3. A **second store** is unaffected while the first is cooling down.
3b. ⛔ **The lock-clobber regression, ported from v1's own bug:** once locked, further misses must
   **not** extend or reset `locked_until`. Assert the timestamp is unchanged after three more
   misses. **This is the test v1 paid for; it exists so we do not pay again.**
3c. **Concurrent misses all count** — N parallel wrong PINs leave `fail_count` at N, not at 1.
4. ⭐ A **correct** PIN on attempt ten still succeeds — the limit is on failures, not attempts.
4b. ⭐ **Nine misses, a 61-second pause, then nine more → never locked.** The window ROLLS; a slow
   fumbler across a long shift must never accumulate into a lockout.
5. Email sign-in works while the device is cooling down (invariant 4).
6. ⭐ **The counter cannot be reset from the client at all.** Clear cookies, open a private window,
   use a different tablet in the same branch — the store's count is unchanged and the cooldown
   still applies. **This replaces the old IP-backstop test, which was unbuildable against a design
   that has neither a cookie nor an IP.**
7. Unknown PIN and wrong-person PIN produce byte-identical responses and identical counter state.

# Out of scope

⛔ *(Corrected: this list previously excluded "persisting the counter", which §THE DESIGN does on
migration `0147`. The exclusion belonged to the rejected draft.)*

CAPTCHA · per-person lockout (§"per device")
· the `SESSION_SECRET` register row (T-302) · rate limiting the **email** path, which Firebase
already throttles.

# Done when

Invariants 1-8 hold · tests 1-7 (with 3b and 3c) pass, shown red first · typecheck, unit,
**integration against real Postgres** green · `0147` hand-authored per ADR-012 §5 and the table
classified in both the RLS registry and the cutover classification · smoketested on 9008: ten wrong
PINs, the message names a real clock time, admin email sign-in still works, the next attempt
succeeds after the cooldown · `FOR IAN` block written.

# ⚠️ What I did not verify

- **Nothing was run except the timing measurement** (§4), taken on this machine, not on production
  hardware. No test, typecheck or build.
- ✅ **The `X-Forwarded-For` caveat is now MOOT** — the revised design uses no IP, so there is
  nothing for a proxy to misreport. Recorded because it would have been a real trap under the
  rejected design: the backstop would have keyed every request to the proxy's own address and
  silently protected nothing, **while passing every test**.
- **Whether 5 misses is genuinely reachable at a shift change** — argued from how a counter tablet
  gets used, not measured. ⚠️ It is the reason the tuning divergence above is flagged, and v1's
  threshold of 10 is the only evidence either way.
- **Whether `/sign-in` is reachable from outside the branch network.** If it is not, the remote
  attacker case is narrower than assumed throughout.
