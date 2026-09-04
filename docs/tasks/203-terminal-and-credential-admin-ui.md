# T-203 — Terminal provisioning and credential enrolment admin UI: closes DEF-133

> **Status:** ✅ **Built and smoketested, 2026-09-04.** `/attendance/terminals` and
> `/staff/[employmentId]/credentials` both live; `docs/DEFECTS-REGISTER.md` DEF-133 closed. Gates:
> typecheck clean · unit 942/943 (1 pre-existing skip) · integration 79 files / 2117 tests green on
> `shareat_test_203` · `npm run build` exit 0 · live-smoketested on 9008 against the real
> `shareat-hub-v2` project (provision/re-pair/revoke a real terminal, enrol/revoke a card and a
> dev-only fingerprint template) — `activateTerminal`'s device-side round trip is the one thing NOT
> verified (needs the Firebase emulator or a real device). Not committed — Ian's call. Nav entry
> still owed: `/attendance/terminals`, capability `provision_clock_terminal`, admin-only (left for
> the coordinator since T-202 was editing `nav.tsx` concurrently).
> **Depends on:** T-159 (`packages/domain/src/attendance/terminals.ts`, `createFirestoreTerminalDriver`
> in `packages/sync-firestore`), T-185 (`packages/domain/src/attendance/credentials.ts`), T-202
> (an employment must exist before a credential can be enrolled against it).
> **Blocks nothing structurally**, but `apps/erp/src/app/clock/page.tsx:162,292` already references
> "the provisioning screen" as where its pairing token comes from — that screen not existing is the
> whole defect.

## Why this exists

`provisionTerminal` / `activateTerminal` / `revokeTerminal` / `mintTerminalToken`
(`packages/domain/src/attendance/terminals.ts`) and `enrolCard` / `enrolFingerprint` /
`revokeCredential` / `listCredentials` (`packages/domain/src/attendance/credentials.ts`) are built,
tested, and have zero callers outside their own tests. `createFirestoreTerminalDriver()`
(`packages/sync-firestore/src/index.ts`) — the thing that actually mints a Firebase custom token —
is imported nowhere. Nothing in `apps/erp/src/app` can provision a terminal or enrol a badge; only
hand-run SQL/scripts could.

## Goal

An admin can, from the running app: provision a new clock terminal for a store and see its
one-time pairing token (as text and as a QR code) so a physical device can be paired; see which
terminals exist, whether each is activated, and revoke one with a reason. A manager can, from the
running app: enrol a card credential against an open employment, see what's enrolled (metadata
only — never a secret), and revoke a credential with a reason.

## Scope — files this task may create or modify

**New:**
- `apps/erp/src/app/attendance/terminals/page.tsx` — list terminals for the actor's store(s),
  provision, activate-status display, revoke
- `apps/erp/src/app/attendance/terminals/actions.ts` — server actions over `terminals.ts`, wired to
  `createFirestoreTerminalDriver()`
- `apps/erp/src/app/attendance/terminals/lib.ts` — list/store helpers, `withOrgPrincipal` re-export
- `apps/erp/src/app/staff/[employmentId]/credentials/page.tsx` — enrol/revoke/list credentials for
  one employment (linked from T-202's employment detail page)
- `apps/erp/src/app/staff/[employmentId]/credentials/actions.ts` — server actions over
  `credentials.ts`

**Modify:**
- `apps/erp/src/app/clock/page.tsx` — nothing functionally required, but if its "the provisioning
  screen" copy names a route, point it at the real one now that it exists

**Do not touch:** `apps/erp/src/components/nav.tsx` — **T-202 is being built at the same time and
also needs one entry there.** Two agents editing the same file concurrently is exactly what bible
§3.4 forbids ("two agents must never touch the same file"). The coordinator adds both nav entries
after this task and T-202 both land; report the exact route and the capability it should gate on
(`provision_clock_terminal`, admin-only) so that edit is a one-line lookup, not a rediscovery.

Also do not touch `packages/domain/src/attendance/terminals.ts` or `credentials.ts` (both complete
as specified by T-159/T-185 — this task is UI only), `packages/sync-firestore/src/index.ts` (the
driver factories already exist and are correct; this task is their first caller, not their author),
any migration.

## Contract

### 1. Terminal screen (`/attendance/terminals`)

List: `listTerminals(tx, actor, { storeId })` per store the actor covers. Columns: label,
provisioned/activated/revoked state (`isReady()` from `terminals.ts` — reuse it, do not
reimplement the readiness check), last seen.

Provision: a form (label, store) calling

```ts
withOrgPrincipal(actor.orgId, tx =>
  provisionTerminal(tx, actor, createFirestoreTerminalDriver(), { storeId, label }))
```

⚠️ **The returned `customToken` is shown exactly once**, on the confirmation view right after
provisioning — as selectable text AND as a QR code (there's no QR library in this repo yet; a
lightweight one is fine, or an inline SVG QR encoder — avoid adding a heavy dependency for one
screen). It is never written to a log, never re-fetchable from this screen after navigating away
(`terminals.ts`'s own doc comment: *"Returned once and never stored"* — the UI must not defeat that
by, say, keeping it in a client-side store that survives a refresh). If a token is lost, the
correct action is `mintTerminalToken` (re-pair), surfaced as a button on an already-provisioned
terminal's row — not a way to recover the old one.

Revoke: a form (reason, required) calling `revokeTerminal(tx, actor, driver, { terminalId, reason
})`. Confirm before submitting — this is a real capability cutoff for a physical device, not a
label edit (per the general destructive-action guidance; a plain confirm-and-submit is enough, no
need for a modal library).

### 2. Credential screen (`/staff/[employmentId]/credentials`)

Reached only from an employment that exists (T-202). List: `listCredentials(tx, actor, {
employmentId })` → `CredentialSummary[]` — id, kind, `cardHint`, `fingerCount`, enrolledAt,
enrolledBy. **Never render a raw card id or template** — the domain layer already doesn't return
one; do not work around that by, say, accepting the id back through a hidden field and echoing it.

Enrol card: a form (card id — typed or scanned via a keyboard-wedge reader, which types digits and
Enter exactly like a keyboard) calling `enrolCard(tx, actor, { employmentId, cardId })`. Surface
`CredentialError`'s message plainly (it already reads well — e.g. the duplicate-card message).

Enrol fingerprint: **build the form, but say plainly in the report what it actually is.** There is
no native fingerprint reader integration anywhere in this stack yet (the domain module's own header
comment: *"fingerprint needs the native reader in the APK that D2 parked"*). `enrolFingerprint`
takes `templates: string[]` — raw captured template strings — with no capture mechanism to produce
them from a browser. Build a minimal form that accepts pasted/typed template text (useful only for
seeding test data or a future reader integration to target) and label it clearly as such in the UI
copy — do not present it as a working biometric enrolment flow when no capture device is wired up.
If this reads as more confusing than useful, the alternative is to ship the card-enrolment half
only and name fingerprint enrolment as still-blocked in the report; make the call and say which one
you took.

Revoke: a form (reason, required) calling `revokeCredential(tx, actor, { credentialId, reason })`.

### 3. Capability gates — already decided, do not re-litigate

- `provision_clock_terminal`: `super_admin`/`admin` only, `manager: false`
  (`packages/auth/src/capabilities.ts:602` — T-159's own spec printed a placeholder table showing
  manager included and flagged it as "Ian's call"; the shipped matrix already answered it as
  admin-only. Follow the shipped matrix, not the spec's placeholder table).
- `manage_attendance`: `super_admin`/`admin`/`manager`, `staff: false` — gates both credential
  enrolment and the terminal list-read (`listTerminals` already calls it internally).

### 4. The Firestore driver is real, not an emulator fake, in this environment

`packages/sync-firestore` reads `FIREBASE_SERVICE_ACCOUNT_KEY_FILE` from `.env.local`
(`./secrets/storage.sa.json`, project `shareat-hub-v2` — the same project POS/CUSTOMER already
share). Calling `provisionTerminal` with `createFirestoreTerminalDriver()` from a local dev run
therefore mints a **real** Firebase custom token and touches the **real** `shareat-hub-v2` Auth
user store, not an emulator. That is consistent with what this screen is for (a real device needs a
real token) but means the smoketest's provision/revoke calls are not free of side effects on shared
infrastructure — provision a terminal with an obviously-test label (e.g. `SMOKETEST — safe to
delete`) and revoke it again before finishing, the same discipline DEF-129/DEF-136's smoketests
already used for their own live data.

## Invariants (inherited from T-159/T-185)

1. A terminal is not "ready" until `activatedAt` is set, and the screen says so rather than
   implying a freshly-provisioned terminal can already punch.
2. The custom token is never persisted or logged by this screen.
3. A credential enrolment never returns or displays a secret value — hint/metadata only.
4. Revoking either a terminal or a credential requires a non-empty reason.

## Tests

No new domain/repo tests — `terminals.ts` and `credentials.ts` are already fully covered by T-159's
and T-185's own integration suites, and this task adds no new domain code. If the existing suite
needs re-running to confirm nothing broke, **this lane's database is `shareat_test_203`** — T-202
and T-204 are running concurrently on `shareat_test_202` and `shareat_test_204`; do not use
`shareat_test` or `shareat_test_b`. Run `ListAgents` first. Smoketest live on 9008 per the
project's definition of done, with the explicit caveat below.

⚠️ **Name what could and couldn't be verified.** `docs/tasks/159-...md` and
`docs/tasks/185-...md` both state their own rules suites need the Firebase **emulator**, and
`docs/tasks/200-clock-terminal-redesign.md`/T-184's own notes say the full terminal round trip
(provision → device signs in → `activateTerminal`) needs that emulator too. If this environment
cannot reach the emulator or the real device-sign-in half, smoketest what's reachable — the admin
screens themselves (provision produces a token and a QR code on screen; revoke changes state;
credential enrol/list/revoke against real Postgres) — and say explicitly in the report that
`activateTerminal`'s device-side round trip and any rules-suite-dependent behaviour remain
unverified by this task, rather than claiming full verification.

## Out of scope — with reasons

**Fingerprint capture hardware/APK integration** — parked project-wide (D2), not this task's to
solve; see §2's framing · **Face recognition** — permanently online-only per D1, not part of the
credential set this UI manages · **The terminal's own pairing/kiosk screen** — T-184/T-200, already
exists at `/clock` · **Card issuance/printing** — operational, not software · **Bulk terminal
provisioning** — no evidence of need.

## Done when

- [x] `typecheck` clean.
- [x] `npm test` clean (no new domain tests expected; existing suite must still pass) — 942/943 (1
      pre-existing skip), 56 files.
- [x] `npm run test:integration` green on the assigned lane, real output reported — `shareat_test_203`,
      79 files / 2117 tests, all passed, 0 failed.
- [x] `npm run build` succeeds with the dev server stopped first — exit 0, both new routes compiled.
- [x] Smoketested live on 9008 for everything reachable without the emulator; the report names what
      is NOT verified (device activation round trip) rather than claiming it.
- [x] A test terminal provisioned during the smoketest is revoked before finishing (§4).
- [x] Self-reviewed line by line (§9).
- [x] `docs/DEFECTS-REGISTER.md` DEF-133's row updated with what shipped and this task's number.
- [x] This file's status line updated.
