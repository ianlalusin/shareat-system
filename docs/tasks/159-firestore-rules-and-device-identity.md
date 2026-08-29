# T-159 — The ruleset, and a terminal that authenticates as itself

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> **Depends on:** T-180 (the spike — its four findings are the design inputs), T-154, T-155.
> **Blocks:** T-181, T-182, T-184, T-185. Nothing in the hot lane exists without an identity to
> authorise it.
> **Grounded in a spike that ran.** T-180 proved `request.auth.token.deviceId` survives from a
> custom token, so the mechanism below is confirmed rather than assumed.

## Why a device principal, and not v1's `{id, secret}`

Bible §5.3, non-negotiable:

> *"the biometric mirror is readable **only by a provisioned device identity**, scoped to its own
> store — never by an ordinary staff or manager account. Device identities authenticate with a
> server-issued credential, and that credential is **not** plaintext in `localStorage`."*

v1 stores `{id, secret}` in the clear in `localStorage` (`offline-clock-device.ts:31-51`), which is
a bearer credential for **every enrolled staffer's fingerprint template** at that store, readable by
anything that can run a line of JavaScript in that origin.

⭐ **The fix is not encryption, it is delegation.** The device signs in to Firebase Auth with a
one-time custom token; from then on the **SDK** holds the refresh material in its own storage and
rotates the short-lived ID token itself. There is no long-lived secret of ours on the device to
leak, and revocation is a server-side act rather than a hope.

## Goal

A provisioned terminal can read exactly its own store's mirror and write exactly its own inbox
events, proven by a rules suite; and revoking it takes effect without touching the device.

## Scope

**Create:**
- `firebase/firestore.rules` — the real ruleset
- `firebase/firestore.indexes.json`
- `firebase/firebase.json` — emulator + deploy targets
- `packages/db/schema/clock-terminals.ts`
- `packages/db/src/repo/clock-terminals.ts`
- `packages/domain/src/attendance/terminals.ts`
- `packages/sync-firestore/` — the **only** package that imports `firebase-admin` for the hot lane
- `packages/domain/tests/integration/clock-terminals.test.ts`
- `firebase/rules.test.ts` — the rules suite, against the emulator
- One migration in **0077–0089**

**Modify:** `packages/auth/src/capabilities.ts` + `docs/decisions/CAPABILITY-MATRIX.md` (⭐ **own
first commit**, per the lane constraint) · `packages/db/src/rls/registry.ts` +
`cutover/classification.ts` (**same first commit**) · the schema and db barrels · `.env.example`.

**Out of bounds:** everything else. In particular the publisher (T-181) and the ingestor (T-182).

## Contract

### 1. ⛔ `packages/sync-firestore` — a new package, not `packages/domain/sync/`

`CLAUDE.md` says the publisher and ingestor live at `packages/domain/sync/`. **This deviates,
deliberately, and follows a precedent this repo has already set twice.**
`packages/storage-firebase` says it plainly:

> *"`packages/domain` owns the `StorageDriver` interface and **must not own a cloud SDK** — the same
> isolation `@shareat/etl-firestore` exists for. Domain code depends on the shape; exactly one
> package depends on `firebase-admin`."*

So: **`packages/domain/src/sync/`** owns the interfaces and the transport-free logic;
**`packages/sync-firestore`** is the one place `firebase-admin` is imported for this lane. Reported
here rather than done silently, since it contradicts a line in `CLAUDE.md` (a loader, not the bible).

### 2. `clock_terminals`

| Column | Notes |
|---|---|
| `id` `uuid` pk | ⭐ **This id IS the `deviceId` claim.** One identifier, not a mapping table |
| `orgId` / `storeId` | The store it is scoped to. A terminal reads one store, ever |
| `label` | *"Counter tablet"* — what a manager recognises it by |
| `firebaseUid` | `terminal:{id}`. Deterministic, so re-provisioning cannot orphan an auth user |
| `provisionedBy` → `persons` · `provisionedAt` | |
| `activatedAt` | ⚠️ NULL until the device completes its first sign-in — see §5 |
| `revokedAt` / `revokedBy` / `revokeReason` | Revocation is a timestamp, never a delete |
| `lastSeenAt` | Stamped by the ingestor. A terminal silent for days is an operational signal |

- `unique (firebase_uid)`.
- `check ((revoked_at is null) = (revoked_by is null))` — both or neither, as everywhere else.
- ⛔ **No secret column, of any kind.** If a reviewer finds one, the design has been misread.

### 3. The ruleset — deny by default, and it stays small

Bible §7 rule 5: *"Firestore security rules in v2 are trivially small and deny-by-default… If the
ruleset grows past ~100 lines, something has leaked into Firestore that belongs in Postgres."*

```
match /mirror/{storeId}/{collection}/{docId} {
  allow read:  if isTerminalOf(storeId) || isStoreMember(storeId);
  allow write: if false;                      // the publisher uses the Admin SDK, bypassing rules
}
match /biometricMirror/{storeId}/{docId} {
  allow read:  if isTerminalOf(storeId);      // ⛔ TERMINAL ONLY — never a person, §5.3
  allow write: if false;
}
match /inbox/{eventId} {
  allow create: if isTerminal()
                && request.resource.data.clientPunchId == eventId
                && request.resource.data.deviceId == request.auth.token.deviceId
                && request.resource.data.keys().hasAll([...]);
  allow read:   if isTerminal() && resource.data.deviceId == request.auth.token.deviceId;
  allow update, delete: if false;
}
match /{document=**} { allow read, write: if false; }
```

⭐ **The biometric mirror is a SEPARATE top-level path**, not a sub-collection of `mirror/`. Its rule
is *"terminal only"* while the roster's is *"terminal or store member"*, and two different rules on
one path is exactly the OR-semantics trap landmine #3 describes — where a nested "stricter" rule is
a silent no-op. Different guarantees get different paths.

### 4. ⛔ Every inbox query must carry the constraint the rule checks — T-180 finding 1

The spike found this and it is not optional: **rules are not filters.** An unconstrained `list` over
`/inbox` is refused outright, because the rule cannot be proven to hold for every document the query
might return.

```ts
query(collection(db, 'inbox'), where('deviceId', '==', myDeviceId), orderBy('occurredAt'))
```

`firestore.indexes.json` carries the matching composite index. ⚠️ **The rule and the query are a
matched pair; changing one silently breaks the other**, so the rules suite includes a `list` case.

### 5. ⚠️ Provisioning is not complete until a round trip succeeds — T-180 finding 3

A device **cannot begin authenticating offline.** The spike proved the SDK keeps a session alive
across restarts, but a terminal provisioned and taken offline before its first sign-in has no
identity and cannot write a single punch.

So provisioning is **two-phase**, and the UI must not lie about it:

1. `provisionTerminal` creates the row and mints a **one-time custom token**, valid one hour.
2. The device signs in with it. `activateTerminal` stamps `activatedAt`.
3. ⛔ **Until `activatedAt` is set the terminal is NOT ready**, and the screen says so — *"sign this
   device in once, while it has a connection"*.

```ts
provisionTerminal(tx, actor, { storeId, label }): Promise<{ terminal; customToken }>
activateTerminal(tx, { terminalId }): Promise<ClockTerminal>
revokeTerminal(tx, actor, { terminalId, reason }): Promise<ClockTerminal>
mintTerminalToken(tx, actor, { terminalId }): Promise<{ customToken }>   // re-pair a wiped device
```

⚠️ **The custom token is returned exactly once and never stored** — the same rule `sessions.tokenHash`
already follows. It is displayed as a QR code for the device to scan and is never written to a log.

### 6. Revocation has to work on a device that is not listening

Revoking sets `revoked_at` **and** disables the Firebase Auth user, so the SDK's next token refresh
fails. ⚠️ An already-issued ID token stays valid for up to an hour — that is Firebase's model, not a
defect, and the spec states it rather than implying instant cut-off. The mirror it can still read for
that hour is one store's roster and templates; the inbox it can still write is idempotent and
attributable.

### 7. Capability — ⭐ a NEW one, and it needs its own first commit

**`provision_clock_terminal`.** Not folded into `manage_attendance`: this grants the power to create
an identity that can read **biometric templates**, and bible §7 rule 2 forbids one capability
implying an unrelated one (landmine #9 is exactly that failure).

| super_admin | admin | manager | staff |
|---|---|---|---|
| ✅ | ✅ | ✅ | ✗ |

⚠️ **Manager is the v1-practice answer and it is an escalation worth naming:** a manager who
provisions a terminal could extract its token and read every enrolled template at that store.
Mitigations: every provisioning writes an audit row, the token is one-time and short-lived, and
revocation is one click. **Admin-only is the tighter option and it is Ian's call** — say so in the
report rather than choosing silently.

## Invariants

1. A terminal can read its own store's mirror, and **not** another store's.
2. ⛔ A terminal can read the biometric mirror; **an admin's own account cannot.**
3. An ordinary store member can read the roster mirror and **not** the biometric mirror.
4. No client can write any mirror path.
5. An inbox create with a mismatched `deviceId` or a `clientPunchId` that is not the doc id fails.
6. An inbox `update`/`delete` fails.
7. An unconstrained inbox `list` fails; the constrained one succeeds.
8. A revoked terminal's token refresh fails.
9. Provisioning before activation leaves the terminal not-ready, and it is reported as such.
10. No table, row or log ever holds the custom token.

## Tests

Rules against the emulator (`firebase/rules.test.ts`), reusing the spike's harness. ⚠️ **Every
refusal must be watched failing against a permissive ruleset first** — the spike did exactly that
and it is the only evidence the rules are what refuse.

Integration on **`shareat_test_b`** for provisioning, activation, revocation, and the audit row.

## Out of scope

**The publisher** — T-181 · **The ingestor** — T-182 · **The terminal UI** — T-184 · **Biometric
enrolment** — T-185; this task creates the *path* and its rule, and nothing writes to it yet ·
**A real Firebase project or any deploy** — emulator only, as T-180 · **Rotating an active
terminal's identity on a schedule** — no evidence of the need; revoke-and-reprovision covers it.

## Done when

- [ ] All ten invariants pass; refusals seen failing first.
- [ ] `provision_clock_terminal` in `capabilities.ts` **and** `CAPABILITY-MATRIX.md`, with a test
      proving the ✗ fires — ⭐ **own first commit**, with the registry entries.
- [ ] Migration hand-written in **0077–0089**, journalled `previous.when + 86400000`.
- [ ] `clock_terminals` classified in `cutover/classification.ts` **and** `rls/registry.ts`.
- [ ] `.env.example` documents anything new, and nothing new is required outside production.
- [ ] `typecheck` · `npm test` · `npm run test:integration` green, real output reported.
- [ ] ⚠️ **The manager-vs-admin question in §7 is put to Ian in the report.**
