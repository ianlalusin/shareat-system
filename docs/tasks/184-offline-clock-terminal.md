# T-184 — The offline clock terminal

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> ⚠️ **RENUMBERED 2026-08-30: was T-163.** Both this lane and the inventory lane had taken T-163; attendance moved because it is finished while inventory is still being written. ⛔ **Commit messages predating the rename still say T-163** — git history is not rewritten.
> **Depends on:** T-180 (the spike, and its five findings), T-159 (device identity + rules),
> T-181 (mirror), T-182 (ingestor), T-185 (the credentials it resolves against).
> ⭐ **This is the task that meets Phase 4's exit gate:** *a terminal clocks in with the network
> pulled and reconciles cleanly on reconnect.*

## What this is, in one paragraph

A page a tablet on the counter loads once and leaves open all day. It signs in **as itself** — a
device principal, not a person — reads the store's roster, config and credential mirror out of
Firestore's local cache, and writes a punch into `/inbox` when somebody scans a badge. With the
network pulled, every one of those steps still works, and the punch replays on reconnect **with no
application code that does the replaying.** That last clause is the whole bet, and T-180 confirmed
the platform keeps it.

## ⛔ The one rule that governs every line of this task

Bible §5.2, binding:

> *"the clock terminal reads and writes Firestore via the **client SDK**, never via Server Actions.
> A Server Action cannot function offline."*

⭐ **A rule nothing enforces is a comment.** So this task ships a test that **fails the build** when
anything reachable from the terminal route imports a Server Action, `next/headers`, or any
`@shareat/db` / `@shareat/domain` module. The rule has been true in prose since Phase 0 and has
never once been checked.

## Scope

**Create:** `apps/erp/src/app/clock/` (the route, client-only) ·
`apps/erp/src/lib/terminal/` (the Firebase app, the mirror reader, the punch writer) ·
`apps/erp/tests/clock-route-is-client-only.test.ts` · the browser assertions.
**Modify:** `apps/erp/package.json` (the `firebase` client SDK) · `.env.example`.
**Out of bounds:** the ZK9500 fingerprint plugin (D2 parked) · face (online-only, and not on this
path at all) · enrolment screens (T-185 is the domain; its UI is not in Phase 4's gate) · the
missed-clock-out sweep (⚠️ specced as "T-166"; that number went to the inventory lane's Deliveries — see T-195 §4, which also declined to build the sweep, leaving it still needing its own task).

---

## Contract

### 1. The five findings T-180 owes this task

Each one is a line of code plus a comment, and each was paid for by the spike.

| # | Finding | What this task must do |
|---|---|---|
| 1 | ⛔ **Rules are not filters.** An unconstrained `list` over `/inbox` is refused outright | **Every** inbox query carries `where('deviceId','==',<own id>)`. The rule and the query are a matched pair |
| 2 | ⭐ The persistent store is keyed `firestore/{firebaseAppName}/{projectId}/main` | The app name is a **pinned constant** with the warning attached. Renaming it orphans every unsynced punch, silently |
| 3 | ✅ A device must **sign in while online** | The pairing screen says so, and refuses to pretend a terminal is ready before a round trip has succeeded |
| 4 | 📏 127 KB gzipped for `app` + `auth` + the Firestore surface | Import exactly that surface. No `firebase/analytics`, no barrel imports |
| 5 | ⛔ **Browser confirmation still owed** | §5 below — this is the definition of done, not a footnote |

### 2. ⭐ What the terminal reads, and from where

Three mirrors, all read through the **local cache first**, all working offline:

| Mirror | Path | Used for |
|---|---|---|
| Config | `mirror/{storeId}/config/current` | Which credential methods are switched on |
| Roster | `mirror/{storeId}/roster/{employmentId}` | The name to show after a scan |
| Credentials | `biometricMirror/{storeId}/credentials/{id}` | ⭐ Resolving a scanned badge to an employment |

⚠️ **The terminal resolves a badge only to decide what to SHOW.** It still sends
`credentialKind` + `credentialRef` and never an employment id — T-185 made the server the authority,
and a terminal that "helpfully" sent its own conclusion would put the hole straight back.

### 3. The punch

One document, created at `/inbox/{clientPunchId}`, where the id **is** the idempotency key — so the
SDK's own retry writes to the same path instead of creating a second event (T-159's rule enforces
`clientPunchId == eventId`).

```ts
{ clientPunchId, occurredAt, deviceId, storeId, credentialKind, credentialRef, method, assertedIntent }
```

⛔ **`setDoc`, never `addDoc`.** `addDoc` mints a server id and would break the idempotency key that
the rule, the ingestor's `UNIQUE` constraint and the quarantine's healing all key on.

### 4. What the screen shows, and the one number that matters

- The store and the terminal's own label, so a manager can tell two tablets apart.
- ⭐ **A pending count** — punches captured and not yet acknowledged — queried with the constrained
  query from finding 1. This is the number that tells a cashier whether their clock-in is *safe*,
  and v1's equivalent is a banner reading *"N failed — tell a manager"* with nothing behind it.
- An online/offline indicator that is honest: **offline is a normal state here, not an error.**

⚠️ **No dead-letter.** There is nowhere for a punch to go and die: it is in Firestore or it has not
been written. That is landmine #14 closed at the source rather than at the screen (T-183).

### 5. ⭐⭐ Definition of done — the browser assertions

T-180 §5, verbatim:

> ⛔ *"The terminal is a browser, so this gap is real. Before T-184 is called done, run the same four
> assertions **in a real browser**… What a browser adds that the shim cannot: real IndexedDB quota
> and eviction, the multi-tab primary lease, and Safari/WebView storage policies… **The last of those
> is the one that could actually lose a punch.**"*

So, in Chrome, against the emulator:

| # | Assertion |
|---|---|
| 1 | Network down: a punch write resolves locally and is readable from cache |
| 2 | The queued punch **survives a page reload** while still offline |
| 3 | On reconnect it reaches the server with **no application replay code** |
| 4 | Two offline punches arrive in the order they were made |

⚠️ **The emulator is the right target and the distinction matters:** what finding 5 says is unproven
is *browser storage behaviour*, not *production Firebase*. Real Chrome + real IndexedDB against the
emulator tests exactly the gap; pointing at production would test the same browser behaviour while
writing junk into a live project.

⭐ `navigator.storage.persist()` is called on load — v1 already does this
(`credential-cache.ts:31`) and it is the mitigation for the eviction risk finding 5 names.

## Invariants

1. Nothing reachable from `/clock` imports a Server Action, `next/headers`, `@shareat/db` or
   `@shareat/domain`. **Enforced by a test that fails the build.**
2. Every `/inbox` query carries `where('deviceId','==',…)`.
3. The Firebase app name is a constant, referenced nowhere else by literal.
4. A punch is written with `setDoc` at the id equal to its `clientPunchId`.
5. The event carries a credential, never an employment id.
6. An unpaired terminal says it is unpaired and refuses to capture punches.
7. A scan that matches no mirrored credential is refused **on the device**, with a message — not
   written and left to quarantine.
8. The pending count uses the constrained query and drops to zero after a reconnect.
9. ⭐ All four browser assertions pass in Chrome.

## Out of scope

**Fingerprint capture** (D2) · **Face** (online-only; not on this path) · **NFC hardware** — the
scan input is a text field that a USB badge reader or a QR scanner types into, which is how the
hardware actually behaves · **A service worker / installable app shell** — a different offline
problem (can the *page* load), named by T-180 as not covered and still not covered here ·
**Break punches** — v1 drives them from a roster tap; the gate is in/out.

## Done when

- [ ] All nine invariants pass.
- [ ] The client-only guard test is present and **watched failing** (add a forbidden import, see it
      go red) — the same discipline T-180 used on the ruleset.
- [ ] The four browser assertions run in Chrome, with what was observed reported.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green, dev server
      stopped before the build.
