# T-153 — The Firestore two-lane spike: prove the contract before building on it

> **Status:** Spec written 2026-08-29 by the Opus planner (session `ianla-f9`, lane B).
> **This task exists because Phase 0's did not.** See **DEF-085**: the roadmap marks Phase 0
> `complete` against a gate reading *"the spike proves an offline write survives and reconciles,"*
> and no spike, ruleset, emulator config or Firestore client dependency exists anywhere in the repo.
> **Blocks:** T-159, T-160, T-161, T-162, T-163, T-164 — every Wave 3 and Wave 4 task, which are
> deliberately unspecced until this reports.
> **Blocked by:** nothing.
> **Time-box: one working session.** Bible §10 specified a *time-boxed spike with a toy payload*;
> this is that, restored to the front of the phase it was supposed to de-risk.

## Why this is a spike and not the real thing

Bible §5.2 carries a **binding consequence**, and everything in Phase 4 is built on it:

> *"the clock terminal reads and writes Firestore via the **client SDK**, never via Server Actions.
> A Server Action cannot function offline. Any v2 code putting a Server Action on the offline clock
> path is a defect."*

That sentence has never been executed in this codebase. `firebase-admin` is present — for the ETL
reader and Storage brokering — and the Admin SDK **has no offline mode at all**, so nothing that
currently runs proves anything about the claim.

⭐ **A spike answers one question and is then deleted.** The question here is not *"can we write a
publisher"* — of course we can. It is: **does the Firestore client SDK, under a deny-by-default
ruleset, actually deliver offline persistence, automatic replay, and refused mirror writes, on the
platform this terminal will run on?** Bible §5.2 asserts all three as *"platform behaviour, which v1
reimplemented by hand and got partly wrong."* If any of the three is false, Phase 4's shape changes,
and it is far cheaper to learn that now than in Wave 4.

⚠️ **Report a negative result as a result.** §3.4a: *"A task reported complete with a failing gate
is worse than one reported blocked."* A spike that proves the contract does **not** hold is a
successful spike and the most valuable output this task can produce.

## Goal

Prove, with a running emulator and an automated test, that a client-SDK write survives with the
network down and reconciles on reconnect — and that the security rules refuse the two writes the
two-lane contract forbids.

## Scope — the exact files this task may create or modify

**Create:**
- `spike/firestore-two-lane/README.md` — the findings. **The durable artifact; the rest is disposable**
- `spike/firestore-two-lane/firebase.json` — emulator config (firestore only)
- `spike/firestore-two-lane/firestore.rules` — the ~30-line deny-by-default ruleset
- `spike/firestore-two-lane/package.json` — its own dependencies, isolated from the workspace
- `spike/firestore-two-lane/rules.test.ts` — rules behaviour, via `@firebase/rules-unit-testing`
- `spike/firestore-two-lane/offline.test.ts` — the offline write/replay proof
- `.gitignore` — one line, if the emulator writes artifacts

**Modify:** nothing else. ⛔ **Not** `package.json` at the repo root, **not** `vitest.config.mts`,
**not** any `packages/*` or `apps/*` file.

> ⭐ **`spike/` is deliberately outside `packages/` and `apps/`.** It is not a workspace member, so
> it cannot be imported by real code, cannot break the app-boundary test, and cannot quietly become
> the implementation. Deleting the directory must leave the build green — that is the definition of
> disposable, and T-160 asserts it.

## Contract

### 1. The ruleset — deny by default, ~30 lines (bible §7 rule 5)

Two collections, one per lane, and nothing else reachable:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Lane A — MIRROR. Postgres -> Firestore. Read-only to every client, always.
    match /mirror/{docId} {
      allow read: if request.auth != null;
      allow write: if false;              // the publisher uses the Admin SDK, which bypasses rules
    }

    // Lane B — INBOX. Device -> Firestore, append-only.
    match /inbox/{eventId} {
      allow create: if request.auth != null
                    && request.resource.data.keys().hasAll(['clientPunchId', 'occurredAt', 'deviceId'])
                    && request.resource.data.clientPunchId is string
                    && request.resource.data.clientPunchId == eventId;
      allow update, delete: if false;     // §5.1: devices may not update or delete their events
      allow read: if request.auth != null && resource.data.deviceId == request.auth.token.deviceId;
    }

    match /{document=**} { allow read, write: if false; }
  }
}
```

⭐ **`clientPunchId == eventId` is the load-bearing line.** It makes the idempotency key the
document id, so a replay of the same event is a write to the same path rather than a second
document — the client SDK's own retry then cannot duplicate it, before the ingestor's `UNIQUE`
constraint ever gets involved. Defence in depth, and it costs one clause.

### 2. `offline.test.ts` — the four assertions that ARE the gate

Against the emulator, using the **client** SDK (`firebase/firestore`) with
`persistentLocalCache`, and `disableNetwork()` / `enableNetwork()` to simulate the outage — the
documented way to test this, and closer to a pulled cable than mocking:

| # | Assertion | What it proves |
|---|---|---|
| 1 | With the network disabled, `addDoc` into `inbox/` **resolves locally** and the doc is readable from the local cache | A punch can be captured offline at all |
| 2 | With the network still disabled, a **fresh SDK instance** on the same persisted store still sees the queued write | ⭐ It survives the terminal being **reloaded or power-cycled**, which v1's IndexedDB queue handled by hand. If this fails, `persistentLocalCache` is not the queue and Phase 4 needs one |
| 3 | On `enableNetwork()`, the write reaches the server **without any application-level replay code** | *"The Firestore SDK provides offline persistence, automatic replay… as platform behaviour"* (§5.2) — the sentence Phase 4 is built on |
| 4 | Two writes made offline arrive in the order they were made | §5.4 rule 3 replays in event-time order; if the SDK does not preserve order, the ingestor must, and that changes T-161 |

### 3. `rules.test.ts` — the four refusals

| # | Assertion |
|---|---|
| 1 | An authenticated client **cannot write** `mirror/{id}` — the forbidden shape (§5.1: *"a Firestore document that is both read as truth and written by a client… does not exist in Shareat System"*) |
| 2 | An authenticated client **can create** `inbox/{id}` with a well-formed payload |
| 3 | An authenticated client **cannot update or delete** its own inbox event once created |
| 4 | A create whose `clientPunchId` disagrees with the document id is **refused** |

⚠️ **Every one of these must be confirmed failing first for the right reason** (§3.2). Landmine #4
is *"rules deploy green then silently deny at runtime"*; a rules test that never saw a refusal fire
is the same class of nothing.

### 4. `README.md` — what the spike is actually for

The findings survive; the code does not. It must answer, in plain sentences:

- **Did all four offline assertions hold?** If any did not, **what exactly happened**, verbatim.
- **How large is the client SDK** added to a terminal bundle, measured not guessed — it ships to a
  device that may be on a slow connection when it first loads.
- **What is the observed behaviour past the cache's limits** — a write queued for hours, a bundle
  larger than expected. `MAX_QUEUE_AGE` (§5, D3 in the plan) is v1's answer to a problem this SDK
  may not have.
- **Does `request.auth.token.deviceId` work from a custom token**, which is what T-159's
  device-principal design (plan §3, row 5) assumes.
- ⭐ **What this changes about the plan.** The one section a downstream implementer will actually read.

## Invariants

1. Deleting `spike/` leaves `npm run typecheck`, `npm test` and `npm run build` green. It is not
   workspace code and nothing may come to depend on it.
2. The spike touches **no** Postgres database — not `shareat_test_b`, not `shareat_dev`. It has
   nothing to do with the relational side and must not acquire a reason to.
3. No credential is read or written. The emulator needs none, and a spike is exactly where somebody
   would reach for a real project by reflex.

## Tests

The two files above **are** the tests; there is no implementation to test separately. Run them
against `firebase emulators:exec` so the emulator's lifecycle is the test runner's problem.

⚠️ **Confirm each assertion fails for the right reason before it passes.** For the offline suite
that means, at minimum, watching assertion 3 fail while the network is still disabled — a test that
only ever passed proves nothing (§3.2).

## Out of scope — each with its reason

**The real publisher and ingestor** — T-160 and T-161, and they are unspecced on purpose until this
reports · **Any real entity** — the toy payload is the point; a spike that models `attendance_punches`
has stopped being time-boxed · **Authentication beyond a stub** — the emulator's auth stub is enough
to prove rules; real custom-token minting is T-159 · **The service worker and the app shell** — a
different offline problem (can the *page* load offline) from this one (does the *write* survive),
and it belongs to T-163 · **Production Firebase project setup** — no deploy, no real project, no
rules push. This runs on the emulator and stops there.

## Done when

- [ ] Four offline assertions and four rules assertions run against the emulator, each seen failing
      first.
- [ ] `spike/firestore-two-lane/README.md` answers all five questions in Contract §4, including the
      bundle size as a measured number.
- [ ] `spike/` deleted locally once, and `typecheck` + `npm test` + `npm run build` confirmed green
      without it, then restored. *(Ask before the build — this lane does not own port 9008.)*
- [ ] ⭐ **The plan is updated with what the spike found**, in `docs/plans/phase-4-attendance.md` §6
      Wave 0 — including, if it comes to it, the sentence that the contract does not hold.
- [ ] If any assertion failed: **stop, and report.** Do not proceed to T-154. A failed spike is this
      task succeeding, and the phase needs re-planning before more is built on the assumption.
