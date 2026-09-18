# T-323 — sign-in works on a development machine, and the outage screen stops blaming the operator

> ### **Status: SPEC v3 — written 2026-09-18 by `system32-4f` (Opus planner). Reserves T-323. Closes DEF-371 and DEF-368.**
>
> ⭐ **v1 → v2 after an independent Opus review found seven defects; v2 → v3 after the AUDITOR found
> nine, four of them new, and one of the builder's own questions turned out to be the same defect
> from another angle.** The traps are recorded below rather than quietly corrected, because a lane
> that does not know why a rule is there will reinvent the mistake.
>
> ⛔⛔ **Left alone, v1 would have shipped GREEN and BROKEN in three separate ways:** a dead emulator
> URL that the SDK accepts silently, a notice test passing in CI against a fully working login form,
> and a negative leg that exercises no code at all. **None of the three was caught by reading. Each
> was caught by a different reader.**
>
> ⭐ **The auditor measured the installed SDK rather than reasoning about it** (`connectAuthEmulator`
> in firebase 11.10.0) and that measurement changed two contracts. *"Check, do not assume"* produced
> a different answer from the one three sessions had assumed.
>
> ⚠️ **Scope grew by one source file during the review, deliberately, and Ian is being told rather
> than asked** (RULES §0.3). See *Contract 5* — a fix for *"the screen lies to a locked-out
> operator"* that leaves the loudest lie in place is not a fix.

## Why this exists

### Half one — DEF-371: there is no emulator path, so no environment variable can create one

`apps/erp/src/app/sign-in/firebase-client.ts:28-45` builds its Firebase app from `publicEnv()` and
calls `getAuth(app)`. **There is no `connectAuthEmulator` in it.** The only
`connectAuthEmulator`/`connectFirestoreEmulator` calls in the repository are
`apps/erp/src/lib/terminal/firebase.ts:104-109`, the clock terminal's separate client, and
`NEXT_PUBLIC_FIREBASE_EMULATOR_HOST` is read at `terminal/firebase.ts:71` and nowhere else.

⛔ **The PIN route is blocked by the same gap**, because T-304's layer 1 authenticates the tablet
through `signInFirebase()` (`TerminalSignInForm.tsx:63`) before any PIN is checked.

⭐ **Found the expensive way, 2026-09-17.** A throwaway identity was created in the auth emulator and
linked to a person; `accounts:signInWithPassword` returned `registered: true` **tested straight
against the emulator** — and the form still refused it. **The credentials were never wrong. The form
cannot see that emulator.** It cost Ian a wasted action at the keyboard.

### Half two — DEF-368: the outage screen points at a shut door, and then blames the operator

`apps/erp/src/app/sign-in/EmailSignInForm.tsx:84-97` catches a `publicEnv()` throw and renders
*"Email sign-in is not configured on this server… **PIN sign-in is unaffected.**"* (the claim is on
**line 97**).

⛔ **It is not unaffected.** `TerminalSignInForm.tsx:63` → `signInFirebase()` →
`firebase-client.ts:31` → **the same `publicEnv()`**, reading the same three variables at lines
37-39 whose absence produced the message.

⛔⛔ **And the review found a second, louder lie on the same screen that v1 of this spec would have
left standing.** `publicEnv()` throws a **plain `Error` with no `code` property**
(`packages/core/src/env.ts:330-334`), so `firebaseSignInMessage` (`TerminalSignInForm.tsx:26-36`)
matches no branch and falls through to its default: **`return 'Wrong email or password.'`**
(`:35`). `page.tsx:61` renders that form **first, above** the notice. So a locked-out operator sees a
normal-looking terminal form, types a correct PIN, and is told their password is wrong — when the
password was never involved.

⭐ **Found 2026-09-17 by Ian, by following the instruction:** he hit the notice, believed it, and
pasted it back verbatim. **Nothing failed; a fact quietly stopped being true** when T-303/T-304's
two-layer sign-in gave the PIN path a Firebase dependency and nobody re-read the sentence.

## Scope — the exact files, and they are disjoint by role

| Role | May edit | Must not touch |
|---|---|---|
| **BUILDER** | `apps/erp/src/app/sign-in/firebase-client.ts` · `apps/erp/src/app/sign-in/EmailSignInForm.tsx` · `apps/erp/src/app/sign-in/TerminalSignInForm.tsx` *(new in v2 — Contract 5)* | every test path below · `apps/erp/src/lib/terminal/**` *(read it, never edit it)* · `packages/core/src/env*` · `apps/erp/src/app/sign-in/page.tsx` |
| **TESTER** | `apps/erp/tests/sign-in-emulator-wiring.test.ts` (new) · `apps/erp/tests/sign-in-config-notice.test.ts` (new) · `apps/erp/tests/terminal-form-config-message.test.ts` (new) | both/all source paths above · anything under `apps/erp/src/**` |

⛔ **No migration. No database change. No new package. No new dependency** — in particular **no
jsdom, happy-dom or testing-library**: the review confirmed none is installed and Test 2 below does
not need one. If the work appears to need any of these, that is a spec defect: report it and stop
(RULES §3.4a).

## Contract

1. ⛔⛔ **`signInFirebase()` connects to the auth emulator when, and only when,
   `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST` is NON-EMPTY — AND THE VARIABLE IS A `host:port` PAIR, NOT A
   HOSTNAME.** ⚠️ **"Non-empty", not "set", and the word is load-bearing:** the worked example gates
   on truthiness (`if (host)`, `terminal/firebase.ts:102`). A builder writing `!== undefined` instead
   turns an empty string into `http://:9198` — and empty strings are this repo's habit, which is the
   same reason the port fallback below is `||`. Dev-only noise rather than a production risk
   (Invariant 2 keeps the variable out of a deployed build), but one word prevents it. Its documented value is **`localhost:8182`**, where `8182` is the **Firestore** port
   (`firebase/firebase.json`). The auth port is separate.
   **The required shape, which is what the worked example already does** (`terminal/firebase.ts:103`):
   `const [name] = host.split(':');` then `http://${name}:${AUTH_PORT}`, and pass
   **`{ disableWarnings: true }`** as the third argument, matching `terminal/firebase.ts:106-108`.
   ⛔⛔ **THE TRAP v1 SET, AND IT IS WORSE THAN v1 SAID — THE AUDITOR MEASURED IT IN THE INSTALLED
   SDK RATHER THAN REASONING ABOUT IT.** Using the raw variable produces `http://localhost:8182:9198`,
   and firebase 11.10.0's `connectAuthEmulator` → `extractHostAndPort` **splits on `:` and takes the
   FIRST pair. It does not throw.** Host `localhost`, port **8182** — sign-in silently points at the
   **Firestore** emulator port, every request fails opaquely, and the symptom is indistinguishable
   from DEF-371's *"the form still refused it"*: the exact experience this task exists to end.
   ⛔ With a fixture of `EMULATOR_HOST=localhost` (no port) **both the correct and the naive
   implementation pass**, and the §9.4 screen test is where it surfaces — after the builder is done.
   That is the DEF-369 shape, *a test certifying a still-broken screen*, which is why Test 1
   **mandates a fixture containing a port. A value with no colon cannot discriminate and is
   forbidden.**
   ⚠️ **`AUTH_PORT` is `process.env.NEXT_PUBLIC_FIREBASE_AUTH_PORT || 9198` — `||`, NOT `??`, and the
   divergence from the worked example is deliberate.** `??` only replaces `null`/`undefined`, so an
   empty string flows straight through and yields `http://localhost:` — and **this repo's habit is
   empty strings** (all five identity values sit empty in `.env.local` today; DEF-369 is that exact
   bug). `terminal/firebase.ts:58-65` already makes this ruling in a comment for `storageBucket` and
   `appId`. **Carry a one-line comment saying why**, or the next reader will "fix" it back to `??`.
2. ⛔ **Auth only — no `connectFirestoreEmulator`, no `initializeFirestore`, no `firebase/firestore`
   import.** The file's own header states this app is auth-only and that `TERMINAL_APP_NAME` owns the
   Firestore store. Adding a Firestore line creates the second divergent copy the file was extracted
   to prevent.
3. **The unconfigured notice stops naming only email.** ⭐ **The builder's own proposal, raised as a
   QUESTION before building and adopted here:** make the corrected sentence the **heading**, and drop
   the now-redundant *"missing its Firebase identity values"* clause from the span beneath it, since
   that fact moves into the heading. Leaving the old heading (*"Email sign-in is not configured on
   this server."*) above a sentence saying both are down would **recreate DEF-368's exact shape**.
   The heading becomes:
   *"No sign-in method is available: both email and terminal PIN sign-in need this server's Firebase
   identity values."*
4. **The production-only suppression of the variable list stays exactly as it is**
   (`process.env.NODE_ENV !== 'production'`), and so does the comment explaining why, and so does the
   administrator note. Not in scope, and correct.
5. ⭐ **NEW IN v2 — the terminal PIN form must not blame the operator's password for a missing build
   value.** When the three identity values are absent, `TerminalSignInForm` must not present a
   normal, submittable PIN form whose failure message is *"Wrong email or password."*
   **The required shape:** the same **render-time `publicEnv()` try/catch its sibling already uses**
   (`EmailSignInForm.tsx:83-89`) — when it throws, render a short unavailable line and **no submit
   control**. The full explanation lives once, in the Contract 3 heading below it; **do not render a
   second full notice** — two stacked notices is how this screen got noisy in the first place.
   ⛔ **The error-code branches in `firebaseSignInMessage` (`:28-34`) are correct and stay.** A real
   `auth/…` failure must still say what it says today. This contract adds a path that never reaches
   that function, it does not rewrite it.

## Invariants — the ones worth a test rather than a reading

1. ⛔⛔ **WITH `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST` UNSET, BEHAVIOUR IS BYTE-FOR-BYTE WHAT IT IS
   TODAY.** A sign-in client that silently pointed production at a local emulator would take
   authentication down for every store. **Test the negative leg** — DEF-363's lesson in this repo's
   own words: *"the positive leg passed and proved nothing."*
2. ⛔ **HOW THAT INVARIANT IS ACTUALLY HELD IN PRODUCTION, MEASURED BY THE REVIEW — IT IS A
   CONVENTION, NOT A GUARD, AND THE SPEC SAYS SO RATHER THAN IMPLYING A SAFETY THAT IS NOT THERE.**
   `.github/workflows/deploy.yml` builds on the runner with an **explicit five-variable `env:`
   allowlist**, and `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST` is not in it and is not a GitHub Secret.
   `scripts/deploy-preflight.ts` checks only that **required** keys are present — **there is no
   denylist**, so nothing fails if someone later adds the emulator host to `deploy.yml`.
3. ⛔⛔ **THE EMULATOR HOST IS NEVER WRITTEN INTO `.env.local`, AND THIS IS A CORRECTNESS RULE, NOT
   TIDINESS.** `apps/erp/next.config.js:9` does `require('dotenv').config({ path: <root>/.env.local })`
   **before Next reads its config — so that file is loaded at BUILD time, not only in dev.** Put the
   emulator host there and every local `npm run build` bakes `localhost` into `.next`; because
   `NEXT_PUBLIC_*` is inlined, **a build that captured it cannot be corrected at runtime on the
   droplet** — only a rebuild fixes it. ⭐ **The orchestrator therefore passes the dev-only values to
   the dev server process as environment variables and edits no shared file.**
4. **`inMemoryPersistence` and the memoisation survive.** v2's authority is the `shareat_session`
   cookie, and `initializeApp` throws on a second call with the same name, which React's development
   double-render makes a certainty.
5. ⚠️ **THE MEMO DOES *NOT* GUARANTEE ONE `connectAuthEmulator` CALL PER AUTH INSTANCE — v1 CLAIMED
   IT DID AND THE REVIEW DISPROVED IT.** `cached` (`firebase-client.ts:21`) is per **module
   instance**. On a module re-evaluation `cached` is null, but `getApps().find(...)`
   (`:32`) recovers the existing app and `getAuth(app)` returns the **same** Auth object — so the
   call can be reached again on an Auth that has already issued requests. ⭐ **This branch is
   precisely Fast Refresh, which is the development mode this whole task exists for.**
   ⭐ **Measured by the auditor in firebase 11.10.0, so nobody need guess:** a second call with a
   **byte-identical** URL and options is a silent no-op; **anything different throws
   `auth/emulator-config-failed`.** Practical severity is therefore LOW in a browser bundle, where the
   URL cannot change between evaluations.
   **State the invariant this way, and not as "the memo provides it":** *the call sits inside the
   memoised path and below the `existing ??` resolution; a second call on a reused Auth is a no-op
   only while the URL and options are byte-identical.* Bible §13 row 206 is why this is written out —
   **a plausible wrong reason is worse than none**, and v1's "the module memo already provides this"
   was a plausible wrong reason that the next person to move that call would have relied on.
6. ⛔ **BIBLE ROW 214 — A REWRITE IS A DELETION TOO, AND ONE FIND IS NOT A PASS.** This slice replaces
   a user-facing string and touches doc comments. **Enumerate every removed line.** Load-bearing and
   must survive in substance: `firebase-client.ts`'s auth-only / never-`TERMINAL_APP_NAME` rule and
   its `inMemoryPersistence` rationale; `EmailSignInForm.tsx`'s comment on why config is read in the
   **client** component and its comment on hiding the variable list outside production;
   `TerminalSignInForm.tsx`'s header on why layer 1 re-authenticates per attempt.

## Tests — the tester writes these, and the shapes below are mandatory, not suggestions

⭐ **All three are unit tests in `apps/erp/tests/` as `.ts` files.** ⛔ **Never `.test.tsx`** — the
unit project's glob is `apps/**/*.test.ts` (`vitest.config.mts:61-66`), so a `.tsx` file **matches
nothing and passes silently**. `filter-row.test.ts:4-7` records this trap in its own header.
**No integration database is needed for this task.**

⛔ **STANDING RULE FOR EVERY TEST BELOW THAT RENDERS A SIGN-IN COMPONENT — hoisted above all three so
nobody meets it only once.** `EmailSignInForm.tsx:37` **and** `TerminalSignInForm.tsx:24` both import
`./actions`, a `'use server'` module reaching `@shareat/auth` → `sign-in/lib.ts` → `@shareat/db` →
`next/headers`. `sign-in-safe-next.test.ts:20-23` measured that tree at **~4.6 s cold**, which alone
blows the unit project's 5 s default timeout — and is how T-232's first test failed for a reason that
had nothing to do with the code under test. **`vi.mock('./actions')` or raise the timeout, and say
which you did, in Test 2 AND Test 3.**
⚠️ **Caught by the auditor:** v3 gave this instruction under Test 2 only. A tester working top-down
would apply it there, hit the identical wall on Test 3 with no instruction in front of them — **and
the cheapest way out of a timeout is always to weaken something.**

**1. `sign-in-emulator-wiring.test.ts`** — ⛔ **its own file, and that is not a style preference.**
`apps/erp/tests/firebase-auth-admin.test.ts:27-30` already paid for this lesson: a memoised
Firebase app means *"whichever test ran first would decide the answer for every test after it — the
assertion would be about ordering, not about the code. It needs its own file."*
  - Required mechanism: `vi.mock('firebase/app')` **and** `vi.mock('firebase/auth')` (spies for
    `getAuth`, `setPersistence`, `inMemoryPersistence`, `connectAuthEmulator`), plus
    `vi.resetModules()` + `await import(...)` per case. ⚠️ `vi.resetModules()` **alone is not
    enough** — vitest externalises `node_modules`, so `firebase/app`'s registry survives and
    `getApps()` still holds `shareat-sign-in` from the previous case.
  - **positive:** with `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST=localhost:8182` (⛔ **this exact realistic
    value, per Contract 1**), `connectAuthEmulator` is called with **`http://localhost:9198`** — port
    **9198**, not 8182, and no doubled port.
  - **options:** the third argument is `{ disableWarnings: true }`. ⚠️ **Assert it.** If the tester
    asserts `toHaveBeenCalledWith(auth, url)` and the builder passes options, the test fails for
    nothing; the reverse leaves the SDK's fixed-position red *"Running in emulator mode"* banner
    painted across the sign-in screen in dev. Two lanes that cannot talk to each other would decide
    this independently — so the spec decides it. **Asserting the argument list is the deleted half of
    the enumeration, which is bible row 214's own subject.**
  - **port override:** with `NEXT_PUBLIC_FIREBASE_AUTH_PORT` also set, that port is used.
  - ⛔ **negative, and it is the one that matters:** with the variable **unset**,
    `connectAuthEmulator` is **never called**.
    ⛔⛔ **AND IT PASSES VACUOUSLY IF YOU GET THE ISOLATION WRONG — THIS IS THE SINGLE EASIEST WAY TO
    SHIP A GREEN LIE IN THIS TASK.** If the positive leg ran first and populated `cached`, the
    negative leg calls `signInFirebase()`, hits `if (cached) return cached` at `:29`, and **touches no
    code at all.** `connectAuthEmulator` is not called — and it would equally not be called if the
    builder had never written the guard. **That is DEF-363 with the legs swapped.** The isolation
    mechanism above is what makes this leg mean anything; it is not boilerplate.
  - ⛔ **THE ISOLATION IS THE TESTER'S, NOT THE BUILDER'S. Do not ask for, and do not accept, an
    exported `__resetForTests()`** — that is a new export with no production caller, which is exactly
    what `callers.mjs` and the auditor's zero-caller check exist to fail (DEF-129/135/136/137/147).
  - ⚠️ **Report the measured wall-clock time of this file** in your RED. `vi.resetModules()` over a
    module tree is what blew the 5 s default timeout in T-232, and nobody has measured it for *this*
    module. ⛔ **If it times out, the answer is a raised timeout or tighter mocks — NEVER dropping
    `resetModules()`**, which silently restores the vacuous pass above.
**2. `sign-in-config-notice.test.ts`**
  - Required mechanism: `renderToStaticMarkup(createElement(EmailSignInForm, { next: '/' }))` from
    `react-dom/server` — the house shape (`filter-row.test.ts:9-10`). ⚠️ `EmailSignInForm.tsx:37`
    imports `./actions`, a `'use server'` module reaching `@shareat/auth` → `@shareat/db` →
    `next/headers`; `sign-in-safe-next.test.ts:20-23` measured that tree at **~4.6 s cold**, which
    alone blows the unit project's 5 s default timeout. **`vi.mock('./actions')` or raise the
    timeout**, and say which you did.
  - ⛔⛔ **THE TEST MUST EXPLICITLY UNSET THE THREE `NEXT_PUBLIC_FIREBASE_*` VALUES, AND MUST
    POSITIVELY ANCHOR THAT THE NOTICE BRANCH RENDERED.** `.github/workflows/ci.yml` sets all five to
    `ci` as **job-level env for the whole verify job, including `npm run test`** — so `publicEnv()`
    does not throw in CI, the notice never renders, and a bare
    `expect(html).not.toContain('PIN sign-in is unaffected')` **passes against a rendered login
    form.** Green in CI, proving nothing: the DEF-363 shape, inside the test meant to prevent it.
  - ⭐ **RENDERING IS RULED IN, AND THE OBJECTION TO IT IS ANSWERED RATHER THAN IGNORED.**
    `sign-out-control.test.ts:7-13` says this project has *"no React-rendering test contract"* and
    reads components as text — but read its **reason**: `TopBar.tsx`/`Sidebar.tsx` *"mix Server and
    Client Components in one tree, which a plain `node`-environment unit test cannot render anyway."*
    **`EmailSignInForm` is pure `'use client'`**, and `renderToStaticMarkup` needs no DOM, which is
    why `filter-row.test.ts:16-17` already renders a real component in this very project. The
    objection is about mixed trees and about `@testing-library` + `jsdom` — neither applies here.
  - ⛔⛔ **ASSERTING THE ABSENCE OF ONE LITERAL SENTENCE IS NOT ENOUGH, AND THIS IS THE AUDITOR'S
    SHARPEST FINDING.** `not.toContain('PIN sign-in is unaffected')` passes the moment that exact
    sentence dies **and keeps passing if a different false reassurance replaces it** — a test that
    asserts only what it is named for. **Required instead, all three:**
    **(a)** a positive anchor that the notice branch actually rendered;
    **(b)** an **exact, whitespace-normalised** match on the full corrected heading — ⚠️ the current
    sentence is wrapped across `EmailSignInForm.tsx:96-97` by the formatter and the replacement is
    longer and will wrap too, so **normalise or the test fails for formatting and gets weakened until
    it passes**;
    **(c)** a **deny-list** of phrasings that would restrict the outage to email or promise another
    route still works — at minimum: `unaffected`, `still works`, `is not affected`, and ⛔ **the old
    heading's own restriction, `Email sign-in is not configured`**.
  - ⭐ **(c) covers the heading deliberately, and that is the auditor's row-214 catch inside a review
    of a task about row 214.** Contract 3 replaces the heading as well as the body. Had the deny-list
    covered only the body sentence, a freshly-written heading still naming only email would have gone
    **green** — the defect surviving its own fix.
  - **regression guard, labelled as one:** with `NODE_ENV` set to `production`, the rendered markup
    does **not** contain the variable list. ⚠️ This is a guard on unchanged, correct code — it cannot
    be part of the red.
**3. `terminal-form-config-message.test.ts`** *(Contract 5)*
  - ⭐ **the red, and it is the WHOLE red:** with the three values **unset**, the rendered terminal
    form offers **no submit control**. Verified red today — submit controls exist at
    `TerminalSignInForm.tsx:163` and `:197` and render with the values unset.
  - ⛔⛔ **"THE MARKUP DOES NOT CONTAIN *Wrong email or password.*" WAS IN v3 AND IS NOW REMOVED FROM
    THE RED — IT IS VACUOUSLY TRUE TODAY, BEFORE THE BUILDER STARTS.** Verified 2026-09-18: that
    string occurs **once**, at `:35`, as the return of the local `firebaseSignInMessage`. It reaches
    the markup only via `setError(…)` in the submit `catch` (`:68`, `:104`) and renders at `{error &&
    …}` (`:127`, `:175`). **On a static render `error` is `null`, so the string is absent from
    today's unmodified, fully-submittable form** — the exact screen Contract 5 exists to abolish.
    ⭐ **Caught by the auditor, and the lesson is aimed at this spec, not at a lane:** v3 labelled two
    assertions as regression guards precisely so that no tester could present them as red — and then
    left a third of identical shape **un-labelled, inside a bullet next to a real red, where it reads
    as part of it.** That is *"one find is not a pass"* (row 214) applied to v3's own guard-labelling
    pass. **The enumeration must be exhaustive over its own output too.**
  - ⭐ **the regression half, which is the point:** a genuine `auth/…` failure still maps to today's
    message. Exercise `firebaseSignInMessage`'s existing branches and assert they are unchanged —
    **including** that the default branch still returns *"Wrong email or password."* for a real
    credential failure. ⚠️ **Guard, not red.**

⛔ **A test failing because a module does not exist is not the red this task needs.** All three source
modules exist today. The red must be the assertion.
⚠️ **Two assertions v1 asked for are REGRESSION GUARDS, not red-first tests, and are labelled as
such** — the review caught that they can never go red because they test unchanged, correct code: the
`NODE_ENV !== 'production'` suppression, and *"`connectFirestoreEmulator` is never called"* (there is
no `firebase/firestore` import in `firebase-client.ts` at all, so it cannot be). **Keep both as
guards; do not present either as this task's red.**

## §9.4 — the screen test, and the credential line is drawn in advance

⭐ **Payoff:** after this ships, `/sign-in` should be drivable locally for the first time.

**Two server runs, both started by the orchestrator, who owns the one server on 9008:**
- **Run A — config blank, exactly as `.env.local` sits today** (all five values are empty; measured
  2026-09-18). The notice renders with no environment change at all. The tester confirms the
  corrected heading, the absence of the PIN claim, and that the terminal form above offers no
  submittable PIN box.
- **Run B — placeholders + `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST=localhost:8182`, emulators up**
  (auth **9198**, firestore **8182**, per `firebase/firebase.json`). ⛔ Passed to the dev server
  **process**, never written to `.env.local` — Invariant 3. ⛔ Empty strings defeat both the projectId
  guard and the `??` fallbacks (DEF-369), so placeholders must be non-empty.
  The tester loads `/sign-in`, submits, and **reads the network request destination**. The proof is
  that the request goes to **`localhost:9198`** rather than `identitytoolkit.googleapis.com`.

⛔⛔ **A TOKEN AND A PASSWORD ARE BOTH OFF-LIMITS TO AN AGENT — IAN MUST PASTE THEM, AND *"it is a
throwaway emulator credential"* IS NOT AN EXEMPTION.** A previous tester refused this correctly,
including when the orchestrator wrongly told it otherwise. **The orchestrator was wrong.**
⭐ **Run B is designed to need no credential:** the destination of the request is what is under test,
not whether it succeeds. If the form will not submit far enough to produce a request without a
password, **stop and say so** — that is a `FOR IAN` item, not a reason to type one.

## Out of scope — named, so nobody widens into them

- ⛔ **DEF-371 fix (i)** — putting the production project's public values in `.env.local`. A local
  environment action for Ian, not code, and see Invariant 3 before doing it at all.
- ⛔ **Making the PIN path independent of Firebase.** That is T-304's whole design — layer 1
  authenticates the *tablet*, not the person.
- ⛔ **`apps/erp/src/lib/terminal/firebase.ts`** — the worked example. Read it; do not touch it.
- ⛔ **`packages/core/src/env.ts`** — `publicEnv()` throwing a plain `Error` is *observed* by this
  task, not changed by it.
- ⛔ **Adding a denylist to `scripts/deploy-preflight.ts`.** Invariant 2 records the gap; closing it
  is its own task with its own risk. **Report it, do not build it.**
- **DEF-366, DEF-367, T-320, T-322.** Separate work, separate passes.

## Done when

Every §9 gate: typecheck clean · unit green · integration green on the lane database (this task adds
none, but the suite must still pass) · **§9.4 smoketested on 9008, both runs** · `npm run build` with
the dev server stopped · the auditor's `/code-review` returned and triaged ·
`node ~/.claude/skills/orchestrator/tools/callers.mjs` clean *(it lives in the orchestrator skill,
**not** in this repo — a review of v1 reported it missing after searching the repo only)* · committed
with a message saying *why* · **DEF-371 and DEF-368 marked closed and the roadmap made true** — by the
orchestrator, not by a lane.

⚠️ **Two follow-ups this task deliberately does not do, to be filed by the orchestrator:**
`NEXT_PUBLIC_FIREBASE_EMULATOR_HOST` is documented **nowhere** in `.env.example` (grep for
"emulator" → zero hits), and `deploy-preflight.ts` has no denylist (Invariant 2).

⚠️ **If §9.4 cannot be met, it is reported as UNMET in those words** and goes to Ian under bible row
203. *"The screen renders"* is not *"sign-in works"* — that exact substitution is the transferable
half of DEF-371.
