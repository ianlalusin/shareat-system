# T-138 — Identity and sessions: the bridge everything else has been built on top of

> **Status:** spec 2026-08-25. **v1 read first** — and it corrected the picture materially (§2).
> **Governed by:** `PROJECT_BIBLE.md` §7.1, which is binding and already states the v2 rule.
> **Blocks:** the 30 September checkpoint. **Wave 1 cannot be "in staff hands" — there is no login.**
> **Unblocks:** every capability check T-121, T-122 and T-123 already perform.

## 1. Why this, now

**I shipped two modules whose central control cannot currently be enforced.**

T-123 separates `submit_sales_day` from `verify_sales_day` because *"the person who submits should
not be the one who verifies."* T-122 separates create from approve. **Both gate on an identity the
user picks from a dropdown.**

> ⛔ **That segregation is theatre until there is a login** — the same shape as DEF-052, a control
> that looks real and is not. I added one, knowingly, with `lib.ts` documenting it as temporary.
> This is the task that makes it real.

**And it compounds.** DEF-053's lesson was that a skipped foundation makes everything after it a
retrofit. Two modules are already on top of this gap; every further screen widens it.

---

## 2. ⭐ What v1 ACTUALLY has — and half of it is already fixed

`docs/discovery/04-auth-and-permissions.md` and bible §7.1 describe *"acting identity passed as a
client-asserted parameter to ~24 server actions."* **Reading the code today, that is now true of
only one of v1's two identity systems.**

### 2.1 The browser session — FIXED in v1, and worth porting

`src/lib/policies/server-context.ts` resolves identity from a **verified `__session` cookie**, not
from the caller:

> *"Identity comes from the verified `__session` cookie — NOT from the client-supplied `actorUid`,
> which is spoofable… session present + actorUid mismatch → hard Unauthorized (spoof attempt or
> stale tab acting as the wrong user)."*

⭐ **Three details worth taking as-is:**

1. **A mismatch is a hard failure, not a preference for the cookie.** A stale tab acting as the
   wrong user is refused rather than silently corrected — which is what makes it detectable.
2. **The cookie is re-minted on sign-in, on page load, and on the hourly token refresh**, so a
   signed-in user always has one. *"A missing cookie now means re-authenticate, not 'trust me'."*
3. **A named escape hatch for cookieless callers** (`runWithVerifiedPrincipal`) — a mobile Bearer
   ID token or an ingest secret, verified by the route **before** the scope opens. **Not a
   bypass: a different verified credential**, and it is one function rather than a scatter of
   special cases.

⚠️ It still carries a legacy `actorUid` fallback with a server log, marked *"remove once cookie
coverage is confirmed."* **v2 has no legacy tabs, so it starts without one.**

### 2.2 The local-user PIN session — STILL the gap §7.1 names

The shared-terminal half is unchanged: a PIN check, then a "session" living in client-side
`localStorage`/Zustand with **no server-issued token**.

**So §7.1's binding rule is really about this half**, and v2's work is narrower and clearer than
the bible's framing implies. *Recorded rather than left as a discrepancy for the next reader.*

### 2.3 ⛔ The landmine: a security control whose failure mode is a PUBLIC secret

`src/lib/auth/local-credential-core.ts` keys a deterministic passcode lookup with an HMAC:

```
const SECRET = process.env.LOCAL_PASSCODE_HMAC_SECRET || 'erp-local-passcode-fallback-secret-v1';
```

The code's own comment is the finding: *"if it's unset the fallback below is publicly known (it's
in the source), so anyone could forge a `passcodeLookupHash`."*

**It deliberately does NOT fail closed** — that would break the clock terminal — so it logs loudly
instead. ⚠️ **A loud log is not a control.** And rotating the secret invalidates every stored hash,
so the safe fix is also the disruptive one, which is why it stays unset.

⭐ **The one part to keep: the hash is scoped to the store**, *"so the same passcode in different
stores never correlates."* That is good thinking and it survives.

Also present: `matchLegacyPasscode` iterates **bcrypt over every candidate** for accounts with no
lookup hash — O(n) hashing per attempt, and a timing surface.

---

## 3. What v2 builds

Bible §7.1's rule, unchanged, restated as work:

| | |
|---|---|
| **One `person` spine** | Already true — `persons`, `person_roles`, `person_store_scope` exist (T-121) |
| **Credentials are rows referencing a person** | A person with no login is a person with no credential row |
| **A PIN check issues a real, signed, server-side session** — short TTL, bound to device and store | The half v1 never built |
| **Acting identity is read from the session, server-side** | **No server action ever accepts an actor as a parameter** |

### 3.1 Two credential kinds, one session

- **Browser sign-in** (admin, manager, office) — Firebase Auth, exchanged for a server session.
- **Terminal PIN** (cashier, shared device) — a 6-digit PIN scoped to a store, exchanged for a
  short-TTL session bound to that device and store.

**Both mint the same session shape**, so `authorize()` never learns how someone signed in. ⭐ *A
capability check that has to know the credential kind is a check that will one day get it wrong.*

### 3.2 ⛔ Non-negotiables, each from a specific v1 failure

1. **No fallback secret, ever.** A missing signing secret **fails closed at startup**, not at use.
   *A control whose degraded mode is a publicly-known key is not degraded, it is off.* (§2.3)
2. **No `actorUid` parameter.** Not even a logged legacy path — v2 has no old tabs to support.
3. **A mismatch is a hard failure**, ported from v1 §2.1.
4. **PIN comparison is constant-time and O(1) in candidates** — never a bcrypt loop. (§2.3)
5. **The device identity is not plaintext in `localStorage`** (bible §5.3's biometric rule, same
   reasoning).

## 4. Scope

**In:** the `person_credentials` table · session issue / verify / revoke · the two sign-in paths ·
`Actor` resolved server-side · replacing the "acting as" picker in T-122 and T-123 · the denial
tests.

**Out:** biometrics (Phase 4) · offline sessions for the clock terminal (Phase 4 — this is the
ERP's browser and terminal, not the punch device) · password reset flows · SSO.

## 5. Invariants

1. **No server action accepts an actor identity as a parameter** — provable by a repo-wide test,
   the same shape as the trap-names guard.
2. A request with no session **cannot act**, and the failure names re-authentication.
3. A session names its **person, store scope and TTL**, and expiry is enforced server-side.
4. **A missing or default signing secret fails at startup.** With a test.
5. A PIN check is constant-time and does not iterate candidates.
6. Every existing capability denial test still passes **through the real session**, not a
   hand-built `Actor`.

## 6. Open — for Ian

1. ⭐ **How should a cashier sign in?** v1 uses a **6-digit PIN on a shared terminal**, which is
   right for a till and wrong for an office. **Suggest porting exactly that** — an email and
   password at a busy counter is a worse control, not a better one, because it gets shared.
2. **Does a terminal session end at shift end, on a timer, or both?** Suggest both: a TTL, plus an
   explicit end-of-shift sign-out that the handover already implies.
3. **Is Firebase Auth still the browser mechanism in v2**, or does the ERP own its own passwords?
   Suggest keeping Firebase — it already works, and replacing an auth provider is a project, not a
   task.
