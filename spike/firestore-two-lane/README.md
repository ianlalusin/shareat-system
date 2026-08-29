# T-180 — Firestore two-lane spike: findings

**Run 2026-08-29, lane B, session `ianla-f9`. Result: the contract HOLDS. 14/14 green.**

```
npm install
npm test          # firebase emulators:exec --only firestore,auth -- vitest run
```

> ⚠️ **This directory is disposable.** It is not an npm workspace member; nothing in `packages/` or
> `apps/` may import it. **The findings below are the deliverable** — the code exists to produce
> them and T-181/T-182/T-184 should be written from this file, not from these tests.

---

## The question

Bible §5.2 makes a **binding** claim and rests all of Phase 4 on it:

> *"the clock terminal reads and writes Firestore via the **client SDK**, never via Server Actions.
> A Server Action cannot function offline."*
> *"the Firestore SDK provides offline persistence, automatic replay, and conflict-free append-only
> writes **as platform behaviour**, which v1 reimplemented by hand and got partly wrong."*

Per **DEF-085**, that had never been executed once in this codebase — Phase 0 was marked complete
against a spike that was never built. This is it, restored to the front of Phase 4.

## Verdict — all four gate assertions hold

| # | Assertion | Result |
|---|---|---|
| 1 | Network down: a write resolves locally, readable from cache, `hasPendingWrites` | ✅ |
| 2 | The queued write **survives a power cycle** and still reaches the server | ✅ *(with two caveats — §2)* |
| 3 | On reconnect it reaches the server with **no application replay code** | ✅ |
| 4 | Two offline writes arrive in the order they were made | ✅ |

Plus the four refusals (`rules.test.ts`), all confirmed: a client cannot write a mirror doc; can
create an inbox event; cannot update or delete one; a create whose `clientPunchId` disagrees with
the document id is refused.

⭐ **Every refusal was watched failing.** The real ruleset was swapped for `allow read, write: if
true` and **7 of 9 rules tests failed**, which is the only proof that the rules — and not something
incidental — are what refuse. Landmine #4 is *"rules deploy green then silently deny at runtime"*;
its mirror image, rules that deploy green and silently **allow**, is what that swap rules out.

**v1's hand-rolled `punch-queue.ts` + `sync-engine.ts` are genuinely replaceable.** Bible §5.2's
"simplification, not an addition" is correct as written.

---

## The five findings that change how Wave 3 and Wave 4 get built

### 1. ⛔ Firestore rules are not filters — an unconstrained query on the inbox is refused outright

The inbox read rule is `resource.data.deviceId == request.auth.token.deviceId`. A **`get`** of one
document evaluates fine. A **`list`** does not, unless the query itself carries the same constraint:

```ts
// REFUSED — "Property deviceId is undefined on object. for 'list' @ L41"
getDocs(query(collection(db, 'inbox'), orderBy('occurredAt')))

// ALLOWED — the query proves the rule holds for every document it can return
getDocs(query(collection(db, 'inbox'), where('deviceId', '==', myDeviceId), orderBy('occurredAt')))
```

**Consequence for T-184:** every terminal query over `inbox` (*"3 punches waiting to sync"*) must
carry `where('deviceId','==',…)`. **For T-159:** this needs a composite index, and the rule and the
query are a matched pair — changing one silently breaks the other. Worth a test that lists.

### 2. ⭐ The persistent store is keyed by the FIREBASE APP NAME, and renaming it orphans the queue

The IndexedDB database is literally:

```
firestore/{firebaseAppName}/{projectId}/main
```

Not the project alone, and not the Firestore database id. **This cost the spike two false negatives.**
The first version of assertion 2 gave each instance a fresh app name to avoid the SDK returning a
cached instance — so the "restarted" terminal opened a *different database*, found nothing, and the
suite reported that offline persistence does not survive a restart. It does. The test was wrong.

**Consequence for T-184:** the terminal's Firebase app name is **part of its durable identity**.
Changing it — a refactor, a rename, a second `initializeApp` with a different label — silently
orphans every punch not yet synced, with no error anywhere. ⚠️ **Pin it as a named constant with a
comment saying exactly this**, and never derive it from anything that can vary per build.

The second caveat: the mutation needs a **flush window** before the process dies. The test gives it
500 ms. A real power cut gives it none, so a punch captured in the final instant before the plug is
pulled can be lost. That is inherent to any local queue, v1's included, and it is not worth
engineering around — but it should be **stated** rather than discovered.

### 3. ✅ `request.auth.token.deviceId` works from a custom token — the device-principal design is sound

Plan §3 row 5 proposes that the terminal authenticate **as itself** via a server-minted custom token
carrying a `deviceId` claim, so bible §5.3's ban on a plaintext device secret in `localStorage`
(which is what v1 does) is satisfied by the SDK holding the refresh material instead.

**Confirmed working.** A custom token with `claims: { deviceId }` surfaces as
`request.auth.token.deviceId` in the rules, and the read rule discriminates on it correctly — a
signed-in human with no such claim is refused (`rules.test.ts` 4c).

⚠️ **One constraint that falls out and belongs in T-184:** a device **must sign in while online**.
It cannot begin authenticating offline. The SDK keeps the session alive across restarts, but a
terminal provisioned and then immediately taken offline before its first sign-in has no identity and
cannot write. **Provisioning must therefore complete a round trip before the terminal is trusted to
work offline**, and the UI has to say so.

⚠️ The emulator accepts an **unsigned** custom token (`"alg": "none"`), which is why this spike needs
no service-account credential. Production does not — T-159's minting service signs with the service
account. `device-principal.ts` says so at the top so nobody ports it.

### 4. 📏 The client SDK costs **127 KB gzipped** (470 KB minified) on the terminal

Measured with `esbuild --bundle --minify`, importing exactly what a terminal needs: `firebase/app`,
`firebase/auth`, and the Firestore surface (`initializeFirestore`, `persistentLocalCache`, `doc`,
`setDoc`, `getDoc`, `onSnapshot`, `collection`, `query`, `where`, `orderBy`).

Acceptable for a device that loads the app once and then runs all day, and it is **replacing** v1's
hand-rolled queue rather than adding to it. Worth noting for T-184's first-load budget on a slow
connection — it is not a reason to reconsider the approach.

### 5. ⚠️ What this spike did NOT prove — the honest limit

The suite runs in **Node** with `fake-indexeddb` plus a `localStorage`/`sessionStorage` shim, because
neither exists in Node and `persistentLocalCache` needs both. That makes assertion 2 a real test of
the persistence layer, **against a shimmed store rather than a browser's own.**

⛔ **The terminal is a browser, so this gap is real.** Before T-184 is called done, run the same four
assertions **in a real browser** — Chrome, and whatever the APK's WebView is if D2 resolves toward an
APK. What a browser adds that the shim cannot: real IndexedDB quota and eviction, the multi-tab
primary lease, and Safari/WebView storage policies that evict IndexedDB under pressure. **The last of
those is the one that could actually lose a punch**, and `navigator.storage.persist()` — which v1
already calls (`credential-cache.ts:31`) — is the mitigation to carry forward.

Also not covered here, deliberately: mirror publishing at scale, tombstones, `srcVersion` ordering,
the service worker and app-shell caching (a different offline problem — can the *page* load), and the
72-hour queue-age question, which plan §5 D3 dissolves rather than answers.

---

## What this changes in the plan

**Nothing structural — Waves 3 and 4 may now be specced.** The contract held, so the outbox →
mirror → inbox → ingestor shape stands as planned. The four findings above are constraints on
*how*, not on *whether*:

| Finding | Lands in |
|---|---|
| Constrained queries + composite index | T-159 (rules), T-181 (index), T-184 (every inbox query) |
| App name is persistence identity | T-184 — a pinned constant with the warning attached |
| Device must sign in while online | T-159 (provisioning is not complete until a round trip succeeds) |
| Browser confirmation still owed | T-184's definition of done |
