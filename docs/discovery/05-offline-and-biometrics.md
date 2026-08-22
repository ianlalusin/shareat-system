# 05 — Offline Capability, Biometrics & Attendance Clock (Discovery)

Read-only discovery over `C:\Users\ianla\webapps\ERP-rebuild` (Next.js 16 + Firebase +
Capacitor Android shell). Scope: what actually works with zero network today, the
biometric data model, the offline queue/replay machinery, and the APK shell. All
claims are cited `file:LINE` against the source tree as of 2026-08-22. No file under
`ERP-rebuild` was modified to produce this document.

---

## Executive summary

Only **one** credential method has a real offline path: **fingerprint**, via a
device-side IndexedDB cache of templates + a native 1:N matcher (ZK9500 USB reader,
Capacitor plugin). Passcode, NFC/QR, and face all require a live round trip to a
Next.js Server Action, which itself requires the App Hosting backend and Firestore
Admin SDK to be reachable — there is no client-side fallback for any of them, and the
UI does not consistently gate them off when offline (silent-failure risk, see
"Gaps" below). Face is **deliberately** online-only: a 2026-07-04 security incident
review (`docs/security/face-recognition-review-2026-07-04.md`) found that shipping
raw face embeddings into a browser-accessible IndexedDB was a biometric-exfiltration
hole, so face embeddings/tokens were removed from the offline bundle entirely and
face now always resolves via a server-side 1:N match.

The offline design is small and purpose-built: one shared IndexedDB database
(`shareat-offline`, via the `idb` package) holding two object stores — a punch queue
and a per-store credential "bundle" (active local users + fingerprint templates only).
A hand-rolled static Service Worker caches immutable assets and does network-first
page navigation, but is registered only on a device a manager has explicitly flagged
as a "clock station." Firestore's client-side `persistentLocalCache` is enabled
(`src/lib/firebase/client-init.ts:29-31`) but is **irrelevant to the clock path** —
every clock/identify/roster/feed operation is a Next.js Server Action (an HTTP RPC to
the App Hosting backend using the Admin SDK), not a client Firestore SDK read/write,
so the client cache never intercepts it.

---

## 1. Clock-in flow, end to end

### 1.1 Credential methods and their offline capability

| Method | Identify path | Punch path | Works fully offline? |
|---|---|---|---|
| Passcode (6-digit) | `getAttendanceStateAction` (Server Action, Admin SDK) | `clockByPasscodeAction` | **No** — both hops are server-side (`resolveLocalUserByPasscode`, `src/lib/auth/local-credential.ts:41-73`, does a Firestore query via `adminDb`). No offline queue path exists for passcode. |
| NFC tap / QR badge | `getAttendanceStateAction` with `rawCardId` | `clockByNfcAction` | **No** — same as passcode; server-side `assignId`/`nfcCardId` lookup (`attendance-clock.actions.ts:748-755`). |
| Fingerprint (ZK9500 USB, APK-only) | On-device native 1:N match (`Fingerprint.identify()`) against a locally loaded matcher DB | `clockByFingerprintAction`, or **offline**: `enqueuePunch` | **Yes** — the only method with a genuine offline path (device-local match + queued punch). |
| Face (WebView camera, browser or APK) | `identifyFaceAction` (server-side 1:N match over `faceSecrets`) | `clockByFaceAction` | **No, by design** — templates never leave the server; UI explicitly disables the Face button when `!online` (`src/app/operation/attendance/time-clock/page.tsx:875-879,933-937`). |

### 1.2 Step-by-step (fingerprint, the offline-capable path)

1. **Arm the reader.** `startFingerprint()` opens the USB reader (`Fingerprint.openReader()`) and loads a matcher DB (`Fingerprint.loadDb`) — `src/app/operation/attendance/time-clock/page.tsx:451-528`. The DB loaded is the **"logged-out" pool**: everyone enrolled minus whoever is currently on shift (`loggedOutPool`, `src/lib/biometric/fingerprint-pool.ts:28-34`), so a press can only mean "clock IN." Break/Clock-Out are driven from tapping a roster row first (`verifyThenAct`, `time-clock/page.tsx:577-631`), which narrows the matcher to a **single** enrolled credential (`soloPool`) — turning the press into a 1:1 verification rather than a 1:N search.
2. **Capture + on-device match.** The ZK9500 fires `extractOK(template)` on every press; the native plugin runs `ZKFingerService.identify(template, ..., MATCH_THRESHOLD=70, 1)` **entirely on-device** (`android/app/src/main/java/com/shareat/erp/FingerprintPlugin.java:169-185`) and resolves `{id, score}` where `id` is `${matchToken}#${slotIndex}` (`buildFingerprintDbEntries`, `src/lib/biometric/fingerprint-core.ts:38-49`). This step needs **no network** whether online or offline — the match already happens locally even in the "online" branch.
3. **Resolve identity.**
   - **Online:** the resolved `matchToken` is sent straight into `clockByFingerprintAction` with `intent: 'in'` (the pool guarantees intent) — no separate identify round trip (`time-clock/page.tsx:507-513`).
   - **Offline:** `findByMatchToken(storeId, matchToken)` looks the token up in the **cached bundle** in IndexedDB (`src/lib/offline/credential-cache.ts:94-98`), entirely client-side.
4. **Write the punch.**
   - **Online:** `clockByFingerprintAction` (Server Action) → `clockToggle()` runs on the server: debounce, throttle, open-session lookup, transactional write of the `attendanceSessions` doc + `localUsers.lastClockPunchAt`, plus an idempotency marker doc (`attendance-clock.actions.ts:152-422`).
   - **Offline:** `enqueuePunch()` writes a row straight to the IndexedDB `punches` store (`src/lib/offline/punch-queue.ts:14-19`) and optimistically opens a **local-user session** so the staffer can keep using the shared device (`punchOffline`, `time-clock/page.tsx:323-335`). No `AttendanceSession` document exists yet — the terminal has no way to know if this is really a clock-IN or clock-OUT (server state is unknown offline), so **both buttons are offered** and whichever the operator taps is queued as-is (`time-clock/page.tsx:802-812`).
5. **Reconcile.** When the device (or any page in the app) sees an `online` event, `startSyncLoop` (`src/lib/offline/sync-engine.ts:35-40`, mounted app-wide via `OfflineSyncBootstrap` in `src/app/providers.tsx:51`) replays every queued punch **in `atMs` order** through the same `clockByFingerprintAction`/`clockByFaceAction` Server Actions, now carrying `atMs` + `clientPunchId` so the server treats it as a backdated replay (`sync-engine.ts:10-32`). A transient failure (network/auth) re-queues and **stops the loop** (so later, in-order punches don't jump ahead of an earlier one still stuck); a definitive business-rule rejection dead-letters just that one punch and continues.

### 1.3 What is genuinely offline vs. silently online-only

- **Genuinely offline:** fingerprint identify+punch capture (steps 1–4 above), the local-user "logged in" session it opens, and the banner/queue UI (`OfflineBanner`, `src/components/offline/OfflineBanner.tsx`).
- **Silently requires network (no explicit offline gate in the UI):**
  - `identify()` — the passcode/NFC/QR entry path (`time-clock/page.tsx:271-288`) is called unconditionally; there is no `online` check before calling `getAttendanceStateAction`. If a staffer keys a passcode while offline, the Server Action call fails and the banner shows a generic `"Read failed"` — not "passcode doesn't work offline." The amber notice at `time-clock/page.tsx:885-887` only appears when the **device itself** isn't offline-enabled; it does not appear (and does not stop the attempt) once offline mode is on but the staffer happens to use a non-fingerprint method.
  - `loadFeed()` / `loadRoster()` ("Today's punches" and "On shift now") are Server Actions called unconditionally on mount/focus (`time-clock/page.tsx:162-185`) with no try/catch; offline, they simply fail silently and the lists go stale.
  - Break Start/Break End (`startBreakAction`/`endBreakAction`) have **no offline queue at all** — the offline branch of the UI omits the Break buttons entirely (comment: "Breaks are hidden offline (deferred)", `time-clock/page.tsx:804`).
  - The registered-station bundle refresh (`refreshBundleIfStale`) only runs from the mounted Time Clock page (`time-clock/page.tsx:218-220`); there is no background/service-worker-driven refresh, so a station only re-syncs its bundle while that page is open and online.

---

## 2. Biometric data

### 2.1 Fingerprint

- **Template format**: base64-encoded ZKFinger proprietary template, `TEMPLATE_SIZE = 2048` bytes raw (`android/app/src/main/java/com/shareat/erp/FingerprintPlugin.java:54`) → ~2.7 KB as base64. Enrollment merges 3 presses of the same finger into one template via `ZKFingerService.merge` (`FingerprintPlugin.java:187-211`); up to `MAX_FINGERS = 2` fingers per staffer (`src/lib/biometric/fingerprint-core.ts:5`).
- **Server storage**: `fingerprintSecrets/{storeId}/users/{localUserId}` — top-level collection, **outside** `stores/`, `{ localUserId, matchToken, templates: string[], enrolledAt, updatedAt, updatedByUid }` (`src/types/local-user.ts:68-75`). Firestore rules: `allow read, write: if false` unconditionally (`firestore.rules:625-627`) — client SDK can never read it; only the Admin SDK (server actions) can.
- **matchToken**: 16 random bytes → 32 hex chars (`generateFingerprintMatchToken`, `src/lib/biometric/fingerprint-token.ts:7-9`), rotated on every (re-)enrollment (`enrollFingerprintAction`, `src/lib/actions/attendance-fingerprint.actions.ts:69-74`, comment "M5" — parity fix with face).
- **Matching**: **on-device**, native — `ZKFingerService.identify()` inside the Android plugin (`FingerprintPlugin.java:174-176`), threshold 70 (proprietary score scale, not comparable to face's Euclidean distance). The server never re-runs a biometric match for fingerprint; it only trusts the `matchToken` the device reports (see "Known gaps" below).
- **Offline copy**: templates + matchToken for **active, linked** local users are shipped to a device's IndexedDB bundle by `assembleOfflineBundle` (`src/lib/offline/bundle.ts:63-79`) via `getOfflineClockBundleAction` (`src/lib/actions/offline-clock.actions.ts:80-115`), gated to **manager/admin** or a **registered clock-station device credential** (`assertClockTerminal`, `src/lib/server/clock-terminal-auth.ts:27-46`).

### 2.2 Face

- **Descriptor format**: 128-float embedding from `@vladmandic/face-api` (`FACE_DESCRIPTOR_DIM = 128`, `src/lib/biometric/face-core.ts:8`), computed **client-side in the WebView/browser** using self-hosted, cache-versioned model weights (`MODEL_URL`, `src/lib/face/face-recognition.ts:17`; long-cache headers in `next.config.js:20-40`). Up to `MAX_FACE_SAMPLES = 5` samples per staffer (`face-core.ts:15`).
- **Server storage**: `faceSecrets/{storeId}/users/{localUserId}` — top-level, outside `stores/`, `{ localUserId, matchToken, embeddings: string[] (comma-joined floats, Firestore forbids nested arrays), model, enrolledAt, updatedAt, updatedByUid }` (`src/types/local-user.ts:82-92`). Rules: `allow read, write: if false` (`firestore.rules:632-634`).
- **Matching**: **server-side only** — `matchFace()` (`src/lib/biometric/face-core.ts:106-146`) does 1:N Euclidean-distance matching (`FACE_MATCH_THRESHOLD = 0.5`, stricter than face-api's 0.6 default) with a lookalike margin (`FACE_MATCH_MARGIN = 0.04`) against the runner-up candidate, run inside `identifyFaceAction` (`attendance-clock.actions.ts:824-881`) on the two full collections (`localUsers`, `faceSecrets`) read fresh every call.
- **Liveness**: a blink-detection challenge (rolling EAR dip-and-recovery, `detectBlink`, `src/lib/face/face-recognition.ts:49-64`) gates capture — `decideCapture` only reaches `'capture'` after `blinked: true` (`face-recognition.ts:170-178`). This is **client-side only**; the server trusts whatever descriptor it is handed. Per the security review this is a known residual gap (no server-issued liveness nonce yet).
- **Offline copy**: **none, deliberately.** `assembleOfflineBundle` never includes face; the bundle test explicitly asserts `(b.users[0] as any).face` is `undefined` (`src/lib/offline/bundle.test.ts:22-23,29`).

### 2.3 Privacy / security posture (from `docs/security/face-recognition-review-2026-07-04.md`)

- **Fixed**: offline bundle no longer carries face templates/tokens (was Critical — biometric exfiltration to any store member's IndexedDB); face match-token now rotates on every re-enrollment; blink liveness extended to enrollment as well as clock-in.
- **Still open / accepted risk today**:
  - Punches are authorized by **possession of `matchToken` alone** — neither `clockByFingerprintAction` nor `clockByFaceAction` re-runs a biometric match server-side; a leaked token (or, offline, a leaked cached bundle) can punch indefinitely until the token is rotated (finding H2).
  - Liveness (blink) is **client-enforced only** — no server nonce/anti-replay yet (finding H3).
  - `listFingerprintTemplatesAction` (`src/lib/actions/attendance-fingerprint.actions.ts:138-185`) is gated only to `requireStoreMember` (**any** authenticated store member, not manager/admin) and returns every enrolled staffer's raw template + matchToken — an explicitly-flagged interim gap ("C-2a interim mitigation," lines 165-179): the read is now **audited** (`configAuditLog` "fingerprint_templates_read") but not yet blocked. This is a **wider** exposure surface than the offline bundle action itself, which *is* manager/admin-or-registered-terminal gated.
  - The 5-minute post-punch cooldown shown in the UI (`CLOCK_COOLDOWN_MS`, `attendance-clock.actions.ts:35`) is **display-only** — nothing server-side blocks a second punch inside that window beyond the unrelated 8-second debounce (finding M1 in the security doc).
  - `atMs`/`offlineOrigin` are entirely client-supplied; the server infers "this is a replay" purely from the *presence* of `atMs` (`clockByFingerprintAction`, `attendance-clock.actions.ts:625,644-673`; comment "H3" at line 666). The kill-switch and sync-token requirement close the two worst exploits (see §4), but the offline-replay *semantics themselves* (skip debounce, backdate) are available to any authenticated caller willing to send `atMs`, not only a genuine offline device.
  - Fingerprint's on-device match (native ZK9500) has no equivalent "confidence" concept surfaced to the server — the server only ever sees a `matchToken` string.

---

## 3. Offline mechanisms in use today

| Mechanism | File(s) | Purpose |
|---|---|---|
| Shared IndexedDB (`idb` v8, `shareat-offline`) | `src/lib/offline/db.ts:6-25` | One DB, two object stores: `punches` (keyPath `clientPunchId`, indexes `by-status`/`by-atMs`) and `bundles` (keyPath `storeId`). |
| Punch queue | `src/lib/offline/punch-queue.ts` | `enqueuePunch` (idempotent on `clientPunchId`, line 14-19), `listPunches` (sorted by `atMs`), `updatePunch`, `deadLetter`, `removePunch`, `pendingCount`. |
| Credential/bundle cache | `src/lib/offline/credential-cache.ts` | `refreshBundle` (pulls from server, prefers the device's own registered-terminal credential over a human's `actorUid`, lines 17-33), `refreshBundleIfStale` (only refreshes past the TTL half-life), `getCachedBundle` (purges + returns null once past `BUNDLE_TTL_MS`), `offlineFingerprintDbEntries`, `cachedFingerprintCredentials`, `findByMatchToken`. Calls `navigator.storage?.persist?.()` after every write (line 31) to make the cache eviction-resistant. |
| Bundle shape + freshness policy | `src/lib/offline/bundle.ts` | `OfflineBundle { storeId, builtAtMs, users: OfflineBundleUser[] }`; `BUNDLE_TTL_MS = 7 days` (line 26), `BUNDLE_REFRESH_AT_MS` = half that (line 33), `shouldRefreshBundle`/`isBundleFresh` guard against clock-skew and treat un-stamped/expired bundles as stale rather than trusting them forever. |
| Device-local flags (localStorage, not IndexedDB) | `src/lib/offline/offline-clock-device.ts` | Per-store "offline clock enabled" flag (`shareat:offlineClock:{storeId}`), per-store registered-terminal credential (`shareat:clockTerminal:{storeId}`, `{id, secret}`), and a device-global "offline boot" flag (`shareat:offlineBoot`) that gates Service Worker registration. |
| Reconnect sync/replay | `src/lib/offline/sync-engine.ts` | `syncQueuedPunches` replays pending punches in `atMs` order through the real Server Actions; `startSyncLoop` runs once on mount and on every `window online` event; mounted globally via `OfflineSyncBootstrap` (`src/components/offline/OfflineBanner.tsx:38-43`, wired in `src/app/providers.tsx:51`). |
| Online/offline signal | `src/lib/offline/useOnlineStatus.ts` | Thin `navigator.onLine` + `online`/`offline` event hook. |
| User-facing status | `src/components/offline/OfflineBanner.tsx` | Polls `pendingCount()`/dead-letter count every 4s; shows "Offline — N will sync", "Syncing N…", or "N failed — tell a manager." **No in-app UI was found to inspect or manually resolve dead-lettered punches** — they sit in IndexedDB until the queue is otherwise cleared. |
| Service Worker | `public/sw.js` (hand-rolled, no build tooling) | Cache-first for `_next/static`, `/models/face-api/*`, fonts/images; network-first for page navigations with a cached-shell fallback (prefers `/operation/attendance/time-clock`, then `/dashboard`); **passes through** everything else (RSC payloads, `/api`, cross-origin Firestore/Storage) untouched so it never serves stale data-plane responses. |
| SW registration gate | `src/components/offline/ServiceWorkerRegister.tsx` | Registers/unregisters `/sw.js` based solely on the `offlineBoot` localStorage flag, reacting to a same-tab `offlineboot-change` event. |
| SW distrust in the root layout | `src/app/layout.tsx:59-74` | An inline script unconditionally unregisters **all** service workers and sweeps Cache Storage on every page load — except it now preserves any `shareat-offline-*` cache key by prefix, so it doesn't fight its own offline-clock SW. Comment: fixes a real production incident where a stale SW hung the APK's post-login RSC refresh. |
| Firestore client persistence | `src/lib/firebase/client-init.ts:27-37` | `initializeFirestore` with `persistentLocalCache({ tabManager: persistentMultipleTabManager() })`. **Does not power the clock path** — every attendance read/write goes through a `'use server'` Server Action using the Admin SDK, which the client cache cannot intercept. It only benefits other client-side `useCollection`/`getDocs` UI elsewhere in the app. |
| Local-user (shared-device) session | `src/lib/store/useLocalUserStore.ts` | Zustand + `localStorage` persist (`shareat:localUser`), 8-hour expiry (`EIGHT_HOURS_MS`, line 23). Used to "log in" a staffer on the shared terminal after an offline punch so they can browse cached records — independent of the punch queue itself. |

---

## 4. Idempotency & replay

Core pure logic lives in `src/lib/attendance/offline-replay.ts`, unit-tested in
`offline-replay.test.ts`, and exercised end-to-end by five
`attendance-clock.*.test.ts` files that use an in-memory fake Firestore
(`src/test/fake-firestore`).

- **`validateAtMs`** (`offline-replay.ts:10-18`): bounds a punch time — `undefined` = live (now); rejects future timestamps and anything older than `MAX_QUEUE_AGE_MS = 72 hours` (`offline-replay.ts:7`). A punch that queued locally for **more than 3 days** will be rejected once finally synced — and since that rejection carries no `retryable: true`, `sync-engine.ts` **dead-letters** it rather than retrying (§6). This is a hard ceiling on how long a device may stay offline before its oldest queued punches become permanently unsalvageable (surfaced only as "N failed — tell a manager" in the banner).
- **Idempotency key**: `clientPunchId` (client-generated `crypto.randomUUID()`, `time-clock/page.tsx:325`). Client-side, `enqueuePunch` no-ops if the id is already queued (`punch-queue.ts:16`, tested in `punch-queue.test.ts:27-31`). Server-side, `clockToggle` writes/reads a companion doc `stores/{storeId}/attendancePunchLog/{clientPunchId}`: if it already exists, the call is treated as an already-processed **no-op success** (`attendance-clock.actions.ts:164-169`), and on the writing side the marker is set **atomically in the same transaction** as the session write (`attendance-clock.actions.ts:404`) so a crash between the two can never leave a committed replay looking unprocessed.
- **Debounce (accidental double-tap, live only)**: `passesDebounce` (`offline-replay.ts:23-29`) blocks a second **live** punch within `DEBOUNCE_MS = 8000` (`attendance-clock.actions.ts:27`) of `localUsers.lastClockPunchAt`, but a **replay is never debounced** — dedupe for replays is `clientPunchId` alone, because a backdated replay would otherwise produce a negative delta and be silently swallowed by the debounce check (explicit comment + test, `offline-replay.test.ts:45-47`).
- **Race-safe debounce claim**: both clock-IN and clock-OUT claim `lastClockPunchAt` **transactionally, before any other write** (`attendance-clock.actions.ts:254-261` for OUT, `:391-406` for IN) via `monotonicPunchAt` (`offline-replay.ts:32-34`, stamp never regresses). `attendance-clock.debounce-race.test.ts` locks in that ordering — it exists specifically because the clock-OUT path used to write that stamp as a **plain, non-transactional** set() at the very end of its work, leaving a window where a concurrent clock-IN (e.g. the idle fingerprint loop re-arming on a still-resting finger) could read a stale stamp and create a spurious duplicate open session — a real 2026-08-19 production incident (also referenced in `time-clock/page.tsx:53-60`, `JUST_PUNCHED_OUT_COOLDOWN_MS`).
- **Per-method kill switch survives replay**: `assertMethodEnabled` runs for **every** punch, replay included (`attendance-clock.actions.ts:660`, comment explains this was previously skippable by supplying `atMs`). `attendance-clock.replay-integrity.test.ts` locks this in for both fingerprint and face, and additionally proves the kill switch **fails open only when nothing has ever been read successfully** for that store, and otherwise sticks to the last known-good config on a transient read failure (`attendance-clock.actions.ts:106-129`, tests at `replay-integrity.test.ts:154-192`).
- **Backdated punch requires a sync token**: any call carrying `atMs` without a `clientPunchId` is rejected outright — `"Backdated punch rejected: missing sync token."` (`attendance-clock.actions.ts:669-673,907-911`) — closing off an interactive caller spoofing a shift by POSTing a bare backdated time; a genuine offline replay always carries both.
- **A replayed clock-out cannot silently make a flagged day payable**: if the session being closed was already `needs_review` (e.g. manager-flagged missing-out), a replay's clock-out data (hours, anomalies, breaks) is written but the **status is deliberately kept at `needs_review`** rather than promoted to `auto_paired` (`attendance-clock.actions.ts:309-314`), because `auto_paired` is in payroll's `PAYABLE_STATUSES`. Verified in `attendance-clock.replay-integrity.test.ts:132-149`.
- **Session partitioning for replay**: `partitionSessionsForPunch`/`resolveClockOutTarget` (`offline-replay.ts:39-61`) split a staffer's non-closed sessions by the **punch's own shift day** (which may be backdated), not wall-clock today — so a backdated replay only ever sweeps/repairs sessions on or before its own day, never a day that is chronologically newer than the punch (tested in `offline-replay.test.ts:68-75`).
- **Throttle (brute-force / hill-climb guard)**: applies to passcode and, since a 2026-08 hardening pass, **face** (`identifyFaceAction`) — `MISS_THRESHOLD = 10` misses in `MISS_WINDOW_MS = 60s` locks the store for `LOCK_COOLDOWN_MS = 60s` (`attendance-clock.actions.ts:453-512`). Deliberately runs **before** the two full-collection reads so a locked attempt costs nothing (tested explicitly in `attendance-clock.throttle.test.ts:81-92`). **Fingerprint has no equivalent throttle** in these actions — the match itself already happened on-device, so the server-side risk is presenting an already-resolved token, and the mitigation there is the registered clock-station binding (§7) plus one-shot token rotation on enroll, not a miss counter.

No contradiction was found between the tests and the implementation for the replay/idempotency logic — the tests read as a precise, currently-accurate specification of `clockToggle`'s behavior.

---

## 5. The hot-data set — what a clock terminal needs locally to survive with zero network

| # | Entity | Shape / size | Refresh cadence today | Staleness tolerance | Read-only or written offline | Current mechanism |
|---|---|---|---|---|---|---|
| 1 | Active, linked local-user roster (name, position, `staffId`) for the store | `OfflineBundleUser` minus fingerprint: `{localUserId, staffId, username, fullName, position, positions[]}` — tiny (~200 bytes/staffer) | Pulled on manager enroll + on every `refreshBundleIfStale` call while the Time Clock page is open and online (halfway through the 7-day TTL) | Must reflect **terminations/role changes** reasonably promptly — a departed staffer stays clockable until the bundle is refreshed or the 7-day TTL lapses (`BUNDLE_TTL_MS`, `bundle.ts:26`) | Read-only | `assembleOfflineBundle` (`offline/bundle.ts:63-79`) → IndexedDB `bundles` store |
| 2 | Fingerprint templates + matchToken per staffer | `{matchToken: 32-hex, templates: string[] (1-2 × ~2.7KB base64)}` — ~5.5 KB/staffer worst case | Same as #1 | Same as #1; a **revoked terminal** is force-purged immediately on next refresh attempt (`credential-cache.ts:22-28`) | Read-only | Same bundle, `fingerprintSecrets` sourced server-side |
| 3 | Clock-terminal device identity (`{id, secret}`) | ~90 bytes | Set once at manager registration (`registerClockTerminalAction`); never rotates automatically | Must never expire silently — it *is* the credential that lets the device self-refresh #1/#2 with no manager present | Read-only (device-local secret, never re-derived) | `localStorage` (`offline-clock-device.ts:31-51`), **not** IndexedDB, **not** encrypted at rest |
| 4 | Same-shift-day queued punches (this device's own, not yet synced) | `{clientPunchId, storeId, staffId, localUserId, matchToken, method:'fingerprint', intent, atMs, status, attempts}` — ~250 bytes each | Written immediately on offline punch; drained on reconnect | Hard ceiling `MAX_QUEUE_AGE_MS = 72h` (`offline-replay.ts:7`) — beyond that a punch is rejected as unsyncable and dead-lettered | **Written offline** (only writable entity in this table) | IndexedDB `punches` store (`punch-queue.ts`) |
| 5 | Store attendance config (credential kill-switches, debounce/cooldown constants, break toggle) | `AttendanceConfig` subset, small | **Not cached offline at all** | N/A — see gap below | Read-only (would be) | **Missing.** An offline device has no local copy of `enabledCredentials`/`breakEnabled`; it always assumes fingerprint clock-in is allowed and always hides Break (hard-coded UI decision, not a config read) |
| 6 | On-shift roster / today's punch feed | `OnShiftRow[]` / `ClockSessionRow[]` | Live Server Action reads only | N/A | Read-only (would be) | **Missing.** Not cached; silently stale/empty offline (§1.3) |
| 7 | Local-user "logged in" session (shared-device UX, not itself a punch) | `LocalUserSession`, ~300 bytes | Set on identify/offline-punch; 8h expiry | 8 hours (`EIGHT_HOURS_MS`) | Written offline | `localStorage` via Zustand persist (`useLocalUserStore.ts`) |
| 8 | Face embeddings/tokens | — | — | — | **Excluded by design** | Never leaves the server (§2.2) |

**Notes for the rebuild:**
- Rows 1–2 are the only data a fingerprint-only offline terminal actually needs, and they are already isolated cleanly (`OfflineBundle`/`assembleOfflineBundle`) — this shape is a reasonable starting point for whatever "hot Firebase subset" the relational migration keeps.
- Row 5 (config) is a **real functional gap today**, not just a rebuild nice-to-have: if a manager disables fingerprint clock-in while a station is offline, the station has no way to know and will happily keep queuing punches that are only rejected — silently, as dead letters — once the connection returns and `assertMethodEnabled` runs for the first time on each queued punch.
- Row 4's 72-hour ceiling is a concrete design constant worth preserving or deliberately revisiting (e.g. is 72h still right for a store that could plausibly lose connectivity over a long weekend?).
- No number for "typical staff per store" was found in code or schema docs; the table above is per-staffer, not per-store — sizing the actual bundle payload requires that operational number from Ian.

---

## 6. Write-back requirements

- **What a device writes while offline**: exactly one thing — a queued fingerprint punch (`clientPunchId, storeId, staffId, localUserId, matchToken, method:'fingerprint', intent:'in'|'out', atMs`). Nothing else (breaks, passcode punches, roster/feed data) is ever written or cached offline.
- **Ordering on reconnect**: strict `atMs` ascending replay (`listPunches` sorts by `atMs`, `punch-queue.ts:25`; `syncQueuedPunches` iterates in that order, `sync-engine.ts:16`) — required because clock-out logic depends on finding the matching clock-in.
- **Conflict/validation rules applied on replay** (all server-side, same code path as a live punch):
  1. Store-membership + per-method kill-switch (re-checked fresh every replayed punch, §4).
  2. `validateAtMs` bounds (not future, ≤72h old).
  3. Idempotency via `clientPunchId` → `attendancePunchLog/{clientPunchId}` doc (already-processed replays are silent no-op successes, safe to resend).
  4. Debounce is **skipped** for replays (dedupe is the idempotency doc, not the time window).
  5. A replay closing a `needs_review` session repairs the data but **does not** clear the flag or promote payability — a manager must still review it.
- **Dedupe key**: `clientPunchId`, enforced twice — once cheaply on the client (`enqueuePunch` no-ops on an existing id) and once authoritatively on the server (the `attendancePunchLog` doc, written atomically with the session mutation).
- **Failure handling on sync** (`sync-engine.ts:10-32`):
  - `res.ok === false && res.retryable === true` (network/auth/unexpected) → punch stays `pending`, loop **stops** (preserves order for what's left), retried on the next `online` event.
  - `res.ok === false` and not retryable (a definitive business-rule rejection — wrong direction, unrecognized credential, method disabled, punch too old) → `deadLetter()`, loop **continues** to the next punch.
  - A thrown exception (uncaught network error) → treated the same as a retryable failure; loop stops.
- **Manual reconciliation**: `OfflineBanner` surfaces a dead-letter count and tells staff to "tell a manager" (`OfflineBanner.tsx:33`) — **no admin/manager UI was found anywhere in the app that reads dead-lettered punches out of a device's IndexedDB**, inspects them, or lets a manager manually re-file the underlying attendance session. Recovery today appears to be entirely informal (a manager manually creates/edits an `AttendanceSession` via the review UI after being told by a staffer). This is worth calling out explicitly as a product gap if the rebuild wants dead-letter recovery to be a real workflow rather than a verbal handoff.

---

## 7. APK / Capacitor shell

- **Shell model**: `capacitor.config.ts:1-22` — `webDir: 'out'` is configured but the app is actually an **online WebView pointed at a live URL** (`server.url: 'https://erp.shareat.net'`), not a bundled static build. The comment is explicit: *"The APK is an online webview shell — it loads this URL, not the (empty) bundled `out/`."* There is no offline-bundled web app; "offline" capability inside the APK comes entirely from the same browser-side mechanisms described above (IndexedDB + the hand-rolled Service Worker), running inside the WebView exactly as they would in a desktop/mobile browser tab.
- **Build/sync**: `npm run cap:sync` copies the web build into `android/` (tracked in git — reviewed as a diff before commit per `CLAUDE.md`); `npm run cap:build` produces a debug APK. Release signing is handled separately (see `AGENTS/ERP Guardian` docs referenced in project memory, out of this discovery's file scope).
- **Native plugins** (all under `android/app/src/main/java/com/shareat/erp/`, each with a thin `registerPlugin<...>()` JS wrapper that no-ops/returns `false` off-native):
  - `FingerprintPlugin.java` — wraps the ZKTeco ZKFinger Android SDK v2.1 for a ZK9500 (VID `0x1b55`, PID `0x0120`/`0x0124`) USB fingerprint reader. Push-model capture bridged to a promise-per-call JS API (`isAvailable`, `openReader`, `closeReader`, `enroll`, `loadDb`, `identify`, `clearDb`, `cancel`). JS binding: `src/lib/biometric/fingerprint.ts`.
  - `NfcCardPlugin.java` — one-shot foreground NFC reader mode (no manifest intent-filter needed), `writeAssignId`/`readTag`/`cancel`. JS binding: `src/lib/nfc/nfcCard.ts`.
  - `ThermalPrinterPlugin.java` — out of scope for attendance, noted only because it shares the same plugin pattern.
- **Manifest permissions** (`android/app/src/main/AndroidManifest.xml:40-50`): `INTERNET`, `CAMERA` (+ optional camera feature, for face), `NFC` (+ optional NFC feature), `BLUETOOTH`/`BLUETOOTH_ADMIN`/`BLUETOOTH_CONNECT`/`BLUETOOTH_SCAN`, and `android.hardware.usb.host` (optional feature, for the ZK9500). Camera and NFC are both declared `required="false"` — the app is expected to run (degraded) on hardware lacking either.
- **A production incident baked into the shell**: `src/app/layout.tsx:59-74` unconditionally unregisters every Service Worker and sweeps Cache Storage (except `shareat-offline-*` keys) on **every page load**, specifically because a stale SW once hung the APK WebView's post-login RSC refresh. This means the offline-clock SW is deliberately re-registered fresh every load rather than trusted to persist — a real operational tension between "keep the offline cache warm" and "never let a stale SW break login," resolved today by re-registering rather than by versioning the SW more carefully.
- **No manifest/PWA-level offline declaration**: `public/manifest.webmanifest` exists (icons, `start_url: /dashboard`, `display: standalone`) but carries no offline-specific fields; offline behavior is entirely the hand-rolled `sw.js` + IndexedDB, opted into per-device rather than declared app-wide.

---

## File index (primary sources cited above)

- `src/lib/offline/db.ts`, `punch-queue.ts` (+`.test.ts`), `bundle.ts` (+`.test.ts`), `credential-cache.ts`, `offline-clock-device.ts`, `sync-engine.ts`, `useOnlineStatus.ts`
- `src/lib/attendance/offline-replay.ts` (+`.test.ts`), `clock-terminal.ts`, `assign-id.ts`, `shifts.ts`, `workday.ts` (referenced, not deep-read)
- `src/lib/actions/attendance-clock.actions.ts`, `offline-clock.actions.ts`, `attendance-fingerprint.actions.ts`
- `src/lib/actions/attendance-clock.replay-integrity.test.ts`, `.debounce-race.test.ts`, `.throttle.test.ts`, `.roster.test.ts`, `.audit.test.ts`, `.read-path.test.ts`
- `src/lib/biometric/face-core.ts` (+`.test.ts`), `face-token.ts`, `fingerprint-core.ts` (+`.test.ts`), `fingerprint-token.ts` (+`.test.ts`), `fingerprint-pool.ts` (+`.test.ts`), `fingerprint-arm.ts` (+`.test.ts`), `fingerprint.ts`
- `src/lib/face/face-recognition.ts` (+`.test.ts`)
- `src/lib/nfc/nfcCard.ts`
- `src/lib/kiosk/kiosk-access.ts`
- `src/lib/server/clock-terminal-auth.ts`
- `src/lib/auth/local-credential.ts`
- `src/lib/store/useLocalUserStore.ts`
- `src/lib/firebase/client-init.ts`
- `src/app/operation/attendance/time-clock/page.tsx`
- `src/components/offline/OfflineBanner.tsx`, `ServiceWorkerRegister.tsx`
- `src/app/layout.tsx`, `src/app/providers.tsx`
- `public/sw.js`, `public/manifest.webmanifest`
- `capacitor.config.ts`, `next.config.js`
- `android/app/src/main/java/com/shareat/erp/FingerprintPlugin.java`, `NfcCardPlugin.java`
- `android/app/src/main/AndroidManifest.xml`
- `firestore.rules` (lines ~354-401, ~618-634)
- `src/types/local-user.ts`, `attendance-session.ts`, `attendance-config.ts`
- `docs/security/face-recognition-review-2026-07-04.md`
