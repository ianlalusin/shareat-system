# T-217 — Shell hardening (404, error boundaries) and sign-in PIN issuance

> **Status:** ✅ **Built and smoketested, 2026-09-05.** `not-found.tsx`, `error.tsx`,
> `global-error.tsx` all live; the "Sign-in PIN" section and `issuePinAction` ship on
> `/staff/[employmentId]`. Gates: typecheck clean · unit 1012/1 skip/1 known-red (unchanged,
> DEF-170) · integration 91/91 files, 2312/2312 tests (includes this task's own +3 for
> `listLiveForPerson`) · `npm run build` exit 0. **Live-smoketested on 9008**: an unknown route
> renders the custom 404 with a real `404` HTTP status; a staff role hitting `/reports/trial-balance`
> (which needs `view_trial_balance`) throws `AuthorizationError` and renders the custom error page
> (HTTP 500, a digest reference, "Try again"/"Back to the dashboard") instead of Next's default
> chrome; a fresh hire's employment page correctly shows "No sign-in PIN issued yet"; issuing a PIN
> persists across a hard reload; signing in with it from a cookie-free browser context lands
> signed-in on `/sales-days`; re-submitting a duplicate PIN already held by someone else at the same
> store shows the existing friendly refusal; re-submitting a PIN already held by the SAME person
> surfaced a raw Postgres error — found, filed as **DEF-177**, and mapped to a friendly message in
> this task (see that row — the underlying `setPin` behaviour is untouched, out of Scope). DEF-174
> closed. Not committed — commit is this session's own next step alongside T-211.
> **Depends on:** nothing — three independent, small, no-schema-change
> fixes, grouped because `docs/plans/v2-completion-blueprint-2026-09-05.md` §2/§6 names them as one
> parallel lane. Numbered 217 rather than 214-216 because those numbers are already reserved in
> `docs/plans/phase-6-reporting-and-dashboards.md` for T-214/215/216 (scorecard/budgets/recurring-
> expense) — this task is not that work and should not collide with whoever specs it.

## Why this exists

Three confirmed gaps, verified live this session:

1. **No `not-found.tsx` or `error.tsx` anywhere in `apps/erp/src/app`.** An unknown route renders
   Next's generic fallback; an unhandled throw (including `AuthorizationError` from `authorize()`,
   which every capability-gated page can throw) renders Next's default error screen instead of
   anything this app controls.
2. **`setPin` (`packages/auth/src/sessions.ts`) has zero callers outside its own tests.** Staff are
   hired via `/staff/hire` (T-202) and can be given clock-in credentials via
   `/staff/[employmentId]/credentials` (T-203) — but nothing anywhere issues the 6-digit PIN
   `/sign-in` itself requires. A hired staff member has no path to ever sign in. Logged as
   **DEF-174** (this task's own finding, closed same session — see that row; numbered 174 not 173
   because ianla-25 claimed 173 first, same afternoon, for an unrelated bible-amendment finding).
3. **No friendly state for "hired but no PIN issued yet."** The blueprint's own §2 named this
   directly: v1's `/pending` and `/welcome` don't apply (no self-registration model here — DEF-hire
   confirmed final), but the underlying real gap — a hired person nobody can sign in yet — has no
   UI anywhere.

## Goal

A broken or unknown URL, and an unhandled error (including an authorization refusal), each render a
page that looks like the rest of this app, not Next's default chrome. From an employment's detail
page, whoever has hire authority can issue and re-issue a 6-digit sign-in PIN, and the page says
plainly whether one is live yet.

## Scope — files this task may create or modify

**New:**
- `apps/erp/src/app/not-found.tsx`
- `apps/erp/src/app/error.tsx`
- `apps/erp/src/app/global-error.tsx`
- `packages/db/src/repo/sessions.ts` — add `listLiveForPerson(tx, personId, storeId?)` (read-only,
  mirrors `attendance-credentials.ts`'s `listLiveForEmployment` shape: filters `revokedAt is null`,
  optionally by store, `kind` included so the caller can tell a PIN from a firebase/biometric row)

**Modify:**
- `apps/erp/src/app/staff/[employmentId]/page.tsx` — add a "Sign-in PIN" section beside the existing
  "Clock-in credentials" one: live/not-issued state, an issue/re-issue form
- `apps/erp/src/app/staff/actions.ts` (or a new co-located `actions.ts` beside the page — match
  whichever convention the file already uses once read) — a server action calling `setPin`

**Do not touch:** `packages/auth/src/sessions.ts` (`setPin` is complete as specified by T-138 — this
task is its first caller, not its author), `packages/db/src/repo/attendance-credentials.ts` (a
different credential family — card/fingerprint for clock terminals, never a PIN, per T-185's own
comment — do not conflate the two), any migration, `/staff/[employmentId]/credentials` (T-203's
screen; the PIN section is new content on the *employment* page, not that one).

## Contract

### 1. `not-found.tsx`

Server Component (no `'use client'` needed — see the file convention doc). Rendered inside the root
layout, so `Nav` still shows for a signed-in visitor who mistypes a route. Plain message + a link to
`/`.

### 2. `error.tsx` and `global-error.tsx`

Both **must** be Client Components (`'use client'`) per Next 16's file convention — this repo is on
**Next 16.3.2**, where the recovery callback is named **`retry`**, not the older `reset` (stable as
of v16.3.0; confirmed against `node_modules/next/dist/docs/01-app/03-api-reference/03-file-
conventions/error.md`'s own version table before writing this). Use `retry`. Log `error` (and
`error.digest` if present) with `console.error` in a `useEffect`; do not attempt to detect
`AuthorizationError` by class or message — Next replaces a Server Component error's message with a
generic one plus a digest in production specifically to avoid leaking exactly that kind of detail
across the boundary, so a special-cased "you're not authorized" UI here would be unreliable by
design. A single honest "Something went wrong" with a retry button and a link home is correct for
both cases; it is not this file's job to distinguish an authorization refusal from any other error.

### 3. Sign-in PIN section (`/staff/[employmentId]`)

Read: `listLiveForPerson(tx, employment.personId, employment.storeId)` (new repo function, filtered
to `kind === 'pin'` by the caller — `sessions.ts` already has no `kind`-only filter variant, and
adding one generic function is enough; don't add a `kind`-specific one just for this).

- **No live PIN** → state it plainly ("No sign-in PIN issued yet — this person cannot sign in.")
  with an "Issue PIN" form: a 6-digit input, calling `setPin(tx, { personId, storeId, pin })`.
  Consider whether the PIN should be operator-chosen (typed) or generated — v1 precedent and this
  repo's own `isValidPinFormat` say "exactly 6 digits," nothing about who picks it; typed-by-the-
  admin matches how a real handover works (told to the new hire on paper) and needs no "reveal once"
  UI ceremony this task would otherwise have to build. State this choice plainly in the report if a
  different one is taken.
- **Live PIN exists** → state that plainly too ("Sign-in PIN issued \<date if available\>") with a
  **re-issue** form (same `setPin` call — it already supersedes the old credential per its own
  doc comment, ending live sessions at that store). Do not build a separate "revoke PIN" action;
  `setPin`'s own superseding behaviour already is the only revoke this needs, and a bare revoke with
  no replacement would just re-create gap #2 for that person.

⚠️ **Never render the PIN back after submission** — same discipline `/staff/[employmentId]/
credentials` already applies to cards (`CredentialSummary` never carries a secret): the admin typed
it, it hashes, it's gone from this process. If the flow is "generate and hand over," the generated
value may be shown exactly once on the confirmation view and never again — mirror T-203's one-time-
token pattern if this route is taken instead of typed-by-admin.

### 4. Capability gate

`setPin` itself does not call `authorize()` — unlike `enrolCard`/`enrolFingerprint`, which DO call
`authorize(tx, actor, 'manage_attendance', …)` internally (`packages/domain/src/attendance/
credentials.ts:91` etc.). `setPin` lives one layer lower, in `packages/auth`, alongside
`signInWithPin`/`signInWithFirebase` which correctly have no actor yet to check. **The server
ACTION this task adds is not equally bare**: issuing or re-issuing a person's sign-in credential is
squarely a "granting system access" action, the same shape as hiring, so the new
`issuePinAction` calls `authorize(tx, actor, 'enrol_staff', { storeId: employment.storeId })` before
calling `setPin` — reusing the existing hire capability rather than shipping this ungated (which
`bible §2.6`/RULES rule 7 forbid: no client-side-only authorization, no server action without a
server-side gate) or inventing a new one unilaterally. The read (does a live PIN exist) stays
ungated, matching the page's existing pattern for every other roster read. Flagged for Ian/Opus to
confirm `enrol_staff` is the right capability long-term, or to split out a dedicated one — see Open
questions.

## Invariants

1. A PIN is never echoed back to the screen after being set (§3's warning).
2. `setPin`'s existing behaviour (ends live sessions at that store on reissue) is not worked around
   or duplicated here.
3. `error.tsx`/`global-error.tsx` never attempt to branch on the specific error type crossing the
   server/client boundary (§2).

## Tests

New: a thin integration test for `listLiveForPerson` (mirrors `attendance-credentials.ts`'s existing
test shape: seed a live + a revoked credential, assert only the live one returns). No test exists
for Next's file-convention pages (`not-found.tsx`/`error.tsx`) elsewhere in this repo — none added
here either; verify by live smoketest instead (visit an unknown route, and trigger a thrown error
from a page gated on a capability the signed-in test actor lacks, e.g. `view_trial_balance` as a
manager). `ListAgents` first; do not run `test:integration` beside a busy peer.

## Out of scope — with reasons

**A capability specifically for "who may issue a PIN"** — today's page has no capability gate at
all for staff management reads; adding one asymmetrically for this one action is a
`CAPABILITY-MATRIX.md` decision, flagged for Ian, not decided here. **Bulk PIN issuance** — no
evidence 126 staff need it faster than one-at-a-time; the real blocker named in the blueprint's
punch list (item 06) is *collecting* SSS/PhilHealth/TIN, not this UI. **A PIN-strength/rate-limit
policy** — DEF-063 (PIN sign-in has no rate limiting) is a separate, already-logged defect; not
this task's to fix.

## Open questions

- Should issuing a PIN require a capability distinct from viewing the roster? Flagging for Ian /
  the Opus planner, per `CAPABILITY-MATRIX.md`'s own process.

## Done when

- [x] `typecheck` clean.
- [x] `npm test` clean, new `listLiveForPerson` tests included (3 added).
- [x] `npm run test:integration` green — 91/91 files, 2312/2312 tests, real Postgres (includes the
      +3 above, confirmed separately in isolation too: 21/21 in `sessions.test.ts`).
- [x] `npm run build` succeeds with the dev server stopped first — exit 0.
- [x] Smoketested live on 9008: unknown route → custom 404 (HTTP 404 confirmed); a capability
      refusal (staff role on `/reports/trial-balance`) → custom error page (HTTP 500, digest shown);
      a hired-with-no-PIN employment shows the not-issued state; issuing a PIN there persists across
      a hard reload; signing in with it from a cookie-free browser context succeeds and lands on
      `/sales-days`; a duplicate PIN held by someone else refuses with the existing friendly
      message; a duplicate of the SAME person's own PIN surfaced a raw error — filed as DEF-177 and
      mapped to a friendly message in the same session.
- [x] Self-reviewed line by line.
- [x] `docs/DEFECTS-REGISTER.md` DEF-174 added and closed in the same entry, and DEF-177 filed for
      the same-PIN edge case found while verifying — after ianla-25's DEF-173/CAPABILITY-GAPS/bible
      commit landed, not concurrently with it.
- [x] This file's status line updated.
