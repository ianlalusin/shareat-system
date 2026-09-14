# T-314 — fingerprint capture: import the half v2 does not have

> ### **Status: SPEC APPROVED 2026-09-14 by `system32-85`. NOT BUILT — no slice started.**
>
> Written by lane C (`webapps-f7`, Opus 5): no code, no Android project, no dependency added.
> ⭐ **Approved with the spec's own two changes to the orchestrator's cut ACCEPTED** — `D` before
> `C` (v1 ships no x86 binaries, so the native plugin has no emulator and its only test surface is
> a real arm tablet, which means the delivery path must exist before the code that needs it), and
> the new slice `S`, the offline shell. **Final order: A → B → S → D → C → E → F → G.**
> ⭐ **The spec also corrected the briefing's premise** and the correction stands: `clock_terminals`
> carries no reader-capability column, and `attendance_config.credential_fingerprint` is per STORE
> while the rule is inherently per DEVICE — so slice F needs a migration. **Indices `0149` (F) and
> `0150` (G) are allocated, one slot per cycle.** ⛔ Their `when` is re-derived from
> `packages/db/migrations/README.md` and ADR-012 §5 **at build time**, never from this banner:
> DEF-039's failure mode is a migration silently skipped for a `when` that sorts wrong, so the
> arithmetic must be confirmed by something that executes.
> ⚠️ **Slice A ships with no production caller until E wires it.** Recorded here so a reviewer does
> not read a correct slice as the DEF-129/135/136/137/147 shape.
>
> Ian, via system32-85: *"then import everything needed by the fingerprint."*
>
> ⚠️ **This document proposes a different slice order from the one in the briefing, and adds one
> slice nobody has named.** Both arguments are in §Slice order, with the evidence. If the
> orchestrator disagrees, the cut is theirs — the reasoning is written down either way.
>
> Prior art read at source, read-only (RULES §1 rule 1): `webapps/ERP-rebuild`. Every number below
> was measured on 2026-09-14, not quoted.

---

# 1. VERDICT

**BUILD IT — and it is not close.** ⭐ **94.0% of real attendance is captured by fingerprint
today.** Measured, not estimated: `tests/golden/fixtures/attendance-sessions.json` holds **703 real
sessions across three stores (lipa, malvar, banay) over 35 days, 2026-08-01 to 2026-09-04**, and
their recorded `context.source` splits:

| Source | Sessions | Share |
|---|---|---|
| **`fingerprint`** | **661** | **94.0%** |
| `manual` (a manager's back-office entry, not a terminal) | 27 | 3.8% |
| `face` | 15 | 2.1% |
| `nfc` / `qr` / passcode | **0** | **0.0%** |

**~1,322 punch events, ~18.9 sessions a day across three stores**, and v1 has seven. This is the
highest-frequency human interaction in the entire system, and v2 cannot perform it at all.

⛔ **BUT THE SAME TABLE CUTS THE SCOPE ROUGHLY IN HALF.** v1 offers four punch methods plus face on
a 1,070-line screen. **Three of them are used zero times in five weeks of real data.** So the thing
to import is *fingerprint*, and the correct answer to "import everything needed by the fingerprint"
is that card, QR and passcode capture are **not** needed by it and must not ride along. §7 lists
them as deliberate exclusions rather than omissions.

⚠️ **What gets worse if it is never built:** on cutover morning nobody can clock in. Attendance and
payroll are already built and tested (Phase 4/5) — against *enrolled* credentials they never explain
how anyone obtains. `docs/CAPABILITY-GAPS.md` calls this *"a Phase 4 remainder that was closed on
paper"*, and the 94% is what that sentence costs.

---

# 2. THE STATED REASON, AND WHETHER IT HOLDS

The request arrives as *"import everything needed by the fingerprint"*, on the premise that v2 has
no fingerprint support. ⭐ **The premise is half wrong, and the half that is wrong is the expensive
half.**

**v2 already has the entire verification path, and it works today.** Verified by reading, not taken
on report:

- `apps/erp/src/lib/terminal/lane.ts:164-171` — `resolveScan` matches a scanned string against
  `c.cardId === value || c.matchToken === value`.
- `apps/erp/src/app/clock/page.tsx:220` — `const method = credential.kind === 'card' ? 'qr' : 'fingerprint'`.
- `apps/erp/src/app/clock/page.tsx:372-373` — the scan box is *"a plain text box on purpose: a USB
  badge reader and a QR scanner both TYPE."*

> ⛔ **So a correct `matchToken` typed into the clock terminal's box resolves as a fingerprint punch
> right now**, through the real ingestor, with the real cooldown, the real intent derivation and the
> real offline write. **The verification half is not a gap. The CAPTURE half is the entire gap.**

That reframing is worth stating because it is what makes slice A possible at all: the logic that
turns a sensor image into a `matchToken` can be imported, tested and finished **before any hardware
exists**, and it will meet a verification path that is already waiting for it.

---

# 3. WHAT ALREADY EXISTS

## 3.1 In v2 — more than expected

| Piece | State | Evidence |
|---|---|---|
| Credential record, 1–2 templates, match token | ✅ Built | `packages/db/schema/attendance-credentials.ts:83-92`; CHECK at `:134-136` enforces `fingerprint` ⇒ `matchToken` **and** 1–2 `templates` |
| Uniqueness of a match token per org | ✅ Built | partial unique index, `attendance-credentials.ts:117-118` |
| **Templates already mirrored to terminals** | ✅ Built | `packages/domain/src/sync/publisher.ts:187` writes `templates`; `:161` to `biometricMirror/{storeId}/credentials/{id}` |
| **A terminal-only biometric mirror path** | ✅ Built | `firebase/firestore.rules` — `biometricMirror/{storeId}/credentials/{docId}`, `allow read: if isTerminalOf(storeId)`, a **separate top-level path so no OR can widen it**. Face excluded by construction |
| Terminal already subscribes to it | ✅ Built | `lane.ts:140` |
| Scan → credential resolution | ✅ Built | `lane.ts:164-171` |
| Offline punch write, idempotent | ✅ Built | `lane.ts:208` `writePunch`, `setDoc` at a chosen id, `acknowledged` deliberately un-awaited |
| **Per-store method switch, server-enforced** | ✅ Built | `attendance-config.ts:277-279` `credential_fingerprint`; `packages/domain/src/sync/ingestor.ts:418` `methodEnabled` refuses a disabled method **at ingest**, not in the UI |
| Hard-enforced device claims | ✅ Built | `clock_terminals`, `provisionTerminal`/`mintTerminalToken` — v2 is genuinely ahead of v1's *"soft-enforced for now"* |
| **Capture from a sensor** | ⛔ **Absent** | no Capacitor dependency, no `android/`, no `capacitor.config.*`, `0` capacitor deps in `package.json` |
| **An offline app shell** | ⛔ **Absent, and nobody has named it** | no `apps/erp/public/`, no service worker, no manifest. §5.2 |

⭐ **One field is missing and it is one line.** `MirroredCredential` (`lane.ts:21-27`) declares
`credentialId, employmentId, kind, cardId?, matchToken?` — **no `templates`**. The publisher sends
them, the rules permit them, the terminal subscribes to them, and the type drops them on the floor.
Nothing can load a template into a reader until that field exists.

## 3.2 In v1 — a working system, and the binaries come with it

| Asset | Size | Verdict |
|---|---|---|
| `fingerprint-token.ts` · `-core.ts` · `-arm.ts` · `-pool.ts` | 9 + 59 + 36 + 58 = **162 lines** | **Port.** Pure logic, no Capacitor import |
| their tests | 13 + 87 + 46 + 70 = **216 lines** | **Port with them** |
| `fingerprint.ts` (the Capacitor↔ZKTeco binding) | 49 lines | Port, re-pointed at v2's plugin |
| `FingerprintPlugin.java` | 289 lines | **Port — see §8.1, it is not stale** |
| ⭐ **ZKTeco SDK, vendored** | `zkandroidcore.jar` · `zkandroidfingerservice.jar` · `zkandroidfpreader.jar` (**136 KB**) + `.so` for `arm64-v8a` and `armeabi-v7a` | **Copy.** No vendor download, no licence negotiation — Ian already owns these and they ship in a repo he controls |
| `.github/workflows/build-apk.yml` | **65 lines**, `workflow_dispatch`, keystore from secrets | **Port** |
| `.github/workflows/generate-keystore.yml` | exists | ⭐ **This is why slice D is cheap** — the keystore is minted by a workflow, not by Ian installing a JDK |
| `public/sw.js` | 79 lines, `shareat-offline-v2` | **Port — v2 has no equivalent, §5.2** |
| `src/lib/offline/*` | 483 lines | ⚠️ **Mostly NOT needed — see §8.2** |
| the 1,070-line clock screen | — | ⛔ **Not a comparator and not a port.** 94% of it serves methods used 0 times |

## 3.3 The sibling systems — checked, because the skill says to check *every* repo

⛔ The skill's own recorded failure is checking only the incumbent. Swept `POS`, `CUSTOMER`,
`Shareat Website` as well as `ERP-rebuild`: **the fingerprint stack exists only in `ERP-rebuild`.**
Nothing else in the business captures a biometric, so there is no second implementation to prefer
and no live data elsewhere to sample.

---

# 4. INDUSTRY AND OPEN SOURCE

**There is no maintained Capacitor plugin for ZKTeco USB readers.** Searched; the ecosystem is
Flutter and native:

- [`Mamasodikov/zk_finger_10`](https://github.com/Mamasodikov/zk_finger_10) — Flutter
- [`amorenew/flutter_zkteco_fingerprint`](https://github.com/amorenew/flutter_zkteco_fingerprint) — Flutter
- [`Brian1011/zkteco_flutter_fingerprint_scanner`](https://github.com/Brian1011/zkteco_flutter_fingerprint_scanner) — Flutter
- [`futuremeng/ZKFinger-SDK_Android`](https://github.com/futuremeng/ZKFinger-SDK_Android) — a mirror of the vendor SDK, the same one v1 vendors
- [`aqasemi/pyzkfp`](https://github.com/aqasemi/pyzkfp) — Python, desktop

⚠️ **And the Capacitor biometric plugins that DO exist solve a different problem.**
`capacitor-native-biometric` and friends wrap Android's `BiometricPrompt` — *"unlock with the
device owner's finger"*. That is 1:1 authentication against the phone's own enrolled user. What a
time clock needs is **1:N identification against a roster, from an external USB sensor**, which
`BiometricPrompt` cannot express at all. Adopting one would not be a shortcut; it would be a
different feature.

> ⭐ **So the open-source verdict is: the best available asset IS v1's plugin**, because it is the
> only Capacitor-targeted wrapper over this vendor's SDK in existence, it was written for this
> business's own hardware, and Ian owns it. Adopting a Flutter plugin would mean rewriting the
> terminal in Flutter — trading 289 lines of Java for the whole app.

⚠️ **Licence, named rather than assumed:** the three `zkandroid*.jar` files and the `.so` files are
**proprietary ZKTeco binaries**, redistributed inside a private repo. Copying them into
`shareat-system` is the same posture v1 already takes and they never leave Ian's own repos. **It is
his call to confirm**, and it is the only licence question here.

---

# 5. SLICE ORDER — WHERE I DISAGREE WITH THE BRIEFING

The briefing proposed **A → B → C → D → E → F**. I propose **A → B → S → D → C → E → F**, on two
grounds.

## 5.1 ⭐ D (the APK pipeline) belongs BEFORE C (the native plugin)

**Sort the slices by what Ian personally has to supply, because that is the real dependency graph:**

| Slice | Needs from Ian | Can it be built without him? |
|---|---|---|
| A — portable logic | **nothing** | yes |
| B — Capacitor shell | nothing to build; any Android device to *prove* | yes |
| S — offline shell | **nothing** | yes |
| D — signed APK pipeline | **a keystore secret** — minted by a workflow v1 already has | yes, blocked only at the final run |
| C — native plugin | **a device AND a ZKTeco dongle AND an arm CPU** | no |
| E — wire into enrolment + clock | needs C proven | no |
| F — reader-present rule | needs a decision (§8.3) | partly |

⛔ **C cannot be tested in an emulator, and that is a hard fact, not a preference.** v1 ships `.so`
for `arm64-v8a` and `armeabi-v7a` only — **there is no x86/x86_64 ABI**, so the standard Android
emulator cannot load the ZKTeco native library at all. Slice C's only possible test surface is a
**real arm tablet with a real dongle**.

> **Therefore: the way code reaches that tablet must exist BEFORE the code that needs the tablet.**
> With D done, slice C's inner loop is *push → workflow_dispatch → install → try the dongle*. With D
> last, slice C is developed against a device it has no supported way to reach, and whoever holds
> it needs a local Android Studio toolchain nobody has specified. **D costs a keystore Ian can mint
> without owning a reader; C is blocked on hardware. Do the unblocked one first.**

## 5.2 ⛔ A SLICE NOBODY HAS NAMED: the offline shell (S)

**v1's APK is not a bundled app. It is a webview pointing at a URL.** `capacitor.config.ts`:

```ts
webDir: 'out',                       // deliberately EMPTY — build-apk.yml does `mkdir -p out`
server: { url: 'https://erp.shareat.net' },
```

⭐ **That is good news for slice B** — a Next.js App Router app with Server Actions *cannot* be
statically exported, so the online-webview shape is not a shortcut, it is the only shape available,
and v1 already proved it in production.

⛔ **But it creates a failure v2 is not protected against.** v2's clock page is "offline-capable by
construction" in the sense that it uses the Firestore client SDK, whose IndexedDB persistence keeps
working with no network — **once the page is loaded**. A webview whose `server.url` is unreachable
never loads the page at all.

> **So: a tablet that reboots, or whose app is relaunched, while the shop's internet is down shows
> an error page and cannot take a single punch — with the entire offline punch queue sitting
> unused behind a document that never rendered.** That is precisely the condition the offline design
> exists for.

**v1 solves this and v2 has nothing.** v1 ships `public/sw.js` (79 lines, cache `shareat-offline-v2`)
plus `ServiceWorkerRegister.tsx`. v2 has **no `apps/erp/public/` directory at all**, no service
worker, no manifest — verified by `ls` and by grep.

⚠️ **This is the one place where "it works on my desk" is guaranteed**, because a developer's
machine is always online at launch. It is a slice, it is small, and it must not be discovered in a
shop.

---

# 6. THE SLICES

Each carries: goal · scope paths · contract · invariants with citations · tests · out of scope ·
done-when · **what it needs from Ian**.

## SLICE A — the portable logic

**Goal.** Token derivation, match-core, the re-arm state machine and the reader pool, running and
tested in v2, with no hardware and no Android. ⭐ **This is the slice that converts "weeks of
unknown" into "tested logic waiting for a device."**

**Scope.** Create `packages/domain/src/attendance/fingerprint/{token,core,arm,pool}.ts` and their
tests. ⚠️ **`packages/domain`, not `apps/erp`** — RULES §1 rule 13: an app may never be imported
from, and enrolment (a server path) and the clock terminal (a client path) both need this logic.
One line changed in `apps/erp/src/lib/terminal/lane.ts`: `MirroredCredential` gains
`templates?: string[]`.

**Contract.** ⭐⭐ **CORRECTED 2026-09-14 BY THE ORCHESTRATOR, ON LANE B'S SPEC REVIEW, BEFORE ANY
CODE WAS WRITTEN. The original contract said `deriveMatchToken(templates)` and that was a blocking
defect** — see §Slice A's token ruling below.

`generateMatchToken()` → a fresh random token, **no arguments** ·
`mintUniqueToken(isTaken)` → the retry-until-store-unique loop, with the uniqueness check
**injected** · `buildReaderEntries(credentials)` → what gets loaded into the sensor ·
`planArm(state, event)` → the re-arm decision · `poolFor(mode, credentials)` → `loggedOutPool` /
`soloPool`.

### ⛔ The token ruling — why it is minted, never derived

**v1 is `generateFingerprintMatchToken(): string { return randomBytes(16).toString('hex'); }`** —
no template argument, nothing computed from template content, minted fresh on every re-enrolment and
checked for store-uniqueness against other users before being accepted
(`attendance-fingerprint.actions.ts:71`, in a loop of up to 12 candidates). Its own comment states
the property: *"M5: allocate a FRESH store-unique token on every (re-)enroll so a leaked or
device-cached token is invalidated by re-enrollment."*

⛔⛔ **A CONTENT-DERIVED TOKEN WOULD BE AN UNROTATABLE CREDENTIAL, AND THAT IS THE WHOLE ARGUMENT.**
Hashing the templates makes the token a function of the finger — and **a person cannot rotate a
finger.** A leaked or device-cached token could then never be invalidated for the rest of that
person's employment, because the only input that would change it is one they cannot change. M5
exists precisely because the credential must be rotatable while the biometric behind it is not.
**Deriving the token silently deletes that property, and no grep finds it: the coupling is a premise
in a comment** — bible §13 row 207, now with a fourth instance.

⚠️ **The uniqueness loop stays out of the pure module's data layer but NOT out of the module.**
`mintUniqueToken(isTaken)` takes an injected `(token) => Promise<boolean>`, so the algorithm — how
many attempts, what happens when all of them collide — is portable, testable with a fake checker,
and needs no database. ⛔ **Slice A must decide and test the all-candidates-collided case**; v1 draws
12 and the spec never said what happens on 13.

⭐ **Web Crypto (`globalThis.crypto.getRandomValues`), never node's `crypto` module.** Lane B's call
and it is right: `packages/domain` is consumed by the enrolment server path *and* the clock client
path, so a node-only import is the exact mirror of Invariant 5's browser-only ban. v1's own file
header warns *"never import this from a client bundle"* — v2 has no such escape, so the primitive
must work in both.

**Invariants.**
1. A token minted here matches what `resolveScan` compares against — `resolveScan` in `lane.ts`
   does plain string equality on `matchToken`, so any string resolves. ✅ **Citation verified intact
   by lane B, 2026-09-14** — one of the few line references in this repo that had not drifted.
2. ⭐ **CORRECTED.** A re-enrolment produces a **different** token, because each mint is fresh
   randomness — **not** because anything is re-derived from template content. `attendance-credentials.ts`'s
   comment says *"Rotated on every re-enrolment"* and **never claims the token is computed from the
   templates**; the original invariant's conclusion was right and its stated reason was wrong, which
   is the half the next person would have built on.
3. 1–2 templates, never more — the CHECK at `attendance-credentials.ts:134-136`.
4. **No face path exists in any of these files** — bible §5.3, *"never mirrored, never cached, never bundled"*.
5. Nothing here imports Capacitor, `navigator`, or anything browser-only.

**Tests.** v1's 216 lines carried across and made to pass. ⭐ **Plus one v1 does not have:** a token
derived by this code resolves through `resolveScan` against a `MirroredCredential` — the seam
between the imported half and the half v2 already had, which is exactly where a port breaks.

**Out of scope.** USB, Capacitor, the clock screen.

**Done when.** Typecheck · unit green · **every exported function has a caller or an explicit
"slice E wires this" note in the task doc** (DEF-129/135/136/137/147). ⚠️ Slice A legitimately ships
with no production caller; say so loudly rather than letting it look wired.

**Needs from Ian.** ⭐ **Nothing.**

## SLICE B — the Capacitor shell

**Goal.** v2 installs and runs as an Android APK. No fingerprint code in it at all.

**Scope.** `capacitor.config.ts` at the repo root, `android/` scaffolding, Capacitor deps.
⛔ **`appId` must NOT be `com.shareat.erp`.** That is v1's, and an install would **replace the v1
clock app on the tablet** — or fail outright on a signature mismatch. Proposing `com.shareat.erp2`
so both can sit on one device through the parallel run. **This is a one-way decision: the appId is
the identity Play and the device use for updates, and changing it later means an uninstall.**

**Contract.** `server.url` points at `erp2.shareat.net`. `webDir` empty, as v1.

**Invariants.**
1. The APK is a webview shell; no static export is attempted (App Router + Server Actions forbid it).
2. ⛔ `appId` differs from v1's, so v1 and v2 coexist on one tablet.
3. Nothing in `apps/` or `packages/` imports Capacitor yet.

**Tests.** ⛔ **A green test proves the least here, as the briefing says.** The done-when is an
install.

**Done when.** ⭐ **An APK is installed on a real Android tablet, alongside v1's app, and reaches
v2's `/sign-in` over the network.** Not "the project compiles."

**Needs from Ian.** An Android tablet to install on (any; no dongle). **A ruling on the appId.**

## SLICE S — the offline shell ⭐ NEW, see §5.2

**Goal.** The terminal boots with no network.

**Scope.** `apps/erp/public/sw.js` + `manifest.webmanifest`, a registration component, ported from
v1's 79-line worker.

**Contract.** Cache-first for the clock route's shell; never cache anything under `/api` or a
Server Action endpoint.

**Invariants.**
1. ⛔ **No authenticated data is ever cached** — the shell only, never a response carrying roster,
   credentials or punches. Bible §5.3's exfiltration lesson applies to a cache as much as a bundle.
2. A cache version bump evicts the old one — v1's `shareat-offline-` prefix convention.
3. The service worker never registers outside the terminal context.

**Tests.** Unit: the worker's route-matching rejects `/api` and Server Action paths. ⛔ The real
proof is manual and is in done-when.

**Done when.** ⭐ **A tablet in aeroplane mode, freshly relaunched, reaches the clock screen and
records a punch that syncs when the network returns.** ⚠️ This must be done on the device, not in
devtools — "offline" in devtools does not simulate a cold app launch.

**Needs from Ian.** The same tablet as B.

## SLICE D — the signed APK pipeline

**Goal.** A repeatable, signed, in-place-updatable APK from CI.

**Scope.** `.github/workflows/build-apk.yml` ported from v1's 65 lines. ⛔ **`.github/` is lane A's
territory today — this slice must be scheduled against that, not merged into it blindly.**

**Contract.** `workflow_dispatch`. Keystore decoded from repo secrets; **fail loudly if the secret
is absent rather than emitting a debug-signed APK**, which is v1's own stated rule and is what makes
in-place updates work.

**Invariants.**
1. Every build is signed with the **same** key, or tablets cannot update without an uninstall.
2. ⛔ The keystore never appears in the repo, in a log, or in an artifact name.
3. Builds run in CI, never on either droplet — RULES §1 rule 11.

**Tests.** A successful `workflow_dispatch` run producing an installable artifact.

**Done when.** ⭐ **Ian installs a CI-built signed APK over the slice-B one without uninstalling.**
In-place update is the assertion, not "the workflow went green."

**Needs from Ian.** ⭐ **A keystore secret — and v1's `generate-keystore.yml` mints it, so this is a
workflow run and a secret paste, not a toolchain install.** This is the cheapest thing on the list
that only he can do, which is the whole argument of §5.1.

## SLICE C — the native reader plugin

**Goal.** The dongle produces a template in v2.

**Scope.** `android/app/src/main/java/<pkg>/FingerprintPlugin.java` ported from v1's 289 lines ·
the three `zkandroid*.jar` · `jniLibs/{arm64-v8a,armeabi-v7a}/*.so` · the JS binding.

**Contract.** `isAvailable()` · `acquire()` / `release()` · a capture event carrying a base64
template. USB permission prompted, not assumed.

**Invariants.**
1. ⛔ **APK-only.** Every entry point guards on `Capacitor.isNativePlatform()` and is unreachable in
   a browser — v1's own rule, `fingerprint.ts:3-6`.
2. The sensor is released on pause/background, or the next app to want it gets nothing.
3. ⛔ **A template never leaves the device except as an enrolment the server stores** — no logging,
   no telemetry, no crash-reporter attachment.

**Tests.** ⛔ **Automated tests prove almost nothing here** and the done-when says so.

**Done when.** ⭐ **On a real arm tablet with a real ZKTeco dongle: a finger produces a template,
the sensor survives ten consecutive captures, and unplugging mid-capture surfaces an error rather
than hanging.** ⚠️ **An emulator cannot do this** — no x86 ABI ships (§5.1).

**Needs from Ian.** **A tablet AND a ZKTeco dongle, physically.** Confirmation that re-vendoring
the ZKTeco jars is fine (§4).

## SLICE E — wire capture into enrolment and the clock

**Goal.** Retire the paste-only form; arm the reader on the clock screen.

**Scope.** `apps/erp/src/app/staff/[employmentId]/credentials/page.tsx` — currently labelled
*"Enrol a fingerprint — not a working capture flow"* (`:155`) — and `apps/erp/src/app/clock/page.tsx`.

**Contract.** Enrolment captures 1–2 templates from the reader, derives the token via slice A, and
writes through the existing T-203 path. The clock screen arms the reader and feeds captures into the
**existing** `resolveScan`.

**Invariants.**
1. ⭐ **The punch path does not change.** `writePunch`, the cooldown, the derived intent and the
   un-awaited `acknowledged` are untouched — `lane.ts:186-207`.
2. The paste-only form is **removed**, not hidden; DEF-133's justification (*"no capture device
   exists in this stack"*) has expired and must not be left standing as a fallback.
3. ⛔ A punch still carries the credential, never the employment — `lane.ts:160-162`, landmine #22.

**Tests.** Integration: enrolment writes 1–2 templates and a token that `resolveScan` then matches.

**Done when.** A real finger, enrolled on a real device, clocks in on a real terminal.

**Needs from Ian.** The device and dongle from C.

## SLICE F — the reader-present rule, designed v2-native

**Goal.** v1's anti-buddy-punching control: *staff on a reader-equipped device clock by finger
ONLY; admins and managers keep every method.*

⛔ **AND HERE IS THE PROBLEM THE BRIEFING'S PHRASING HIDES.** The instruction was to gate on *"the
terminal's registered capability via `packages/domain/src/attendance/terminals.ts`, where v2 is
already ahead of v1."* **v2 is ahead on device claims, but there is no such capability.** Every
column on `clock_terminals` is listed in `packages/db/schema/clock-terminals.ts:39-72`:
`id, org_id, store_id, label, firebase_uid, provisioned_by, provisioned_at, activated_at,
last_seen_at, revoked_at, revoked_by, revoke_reason, created_at, updated_at`. **Nothing records
whether a reader is attached.**

What v2 *does* have is `attendance_config.credential_fingerprint` (`:278`), enforced server-side at
ingest by `ingestor.ts:418`. ⛔ **But that is per STORE, and the rule is inherently per DEVICE** — a
branch may have one tablet with a dongle and one without, which is exactly the case the rule exists
for.

**So slice F needs a migration**, and that is new scope the briefing did not price:
`clock_terminals.has_fingerprint_reader`, set at provisioning or self-declared by the device at
activation and then **stored and hard-enforced** — the v2-native shape, versus v1's client-side
detection which a modified client can simply lie about.

⚠️ **I am flagging this rather than designing it**, because it needs a ruling: *self-declared at
activation* (cheap, and the device genuinely knows) versus *set by a human at provisioning*
(auditable, and cannot be lied about). ⭐ **Recommend self-declared-then-locked**: the device
reports it once at activation, the server records it, and it never changes without a re-provision —
which gets the device's knowledge without letting it re-assert.

**Needs from Ian.** A ruling on the above. **This slice also needs its own migration index from
system32-85.**

## SLICE G — the fingerprint rate limit ⭐ NEW WORK, NOT A PORT

⛔ **v1 has no fingerprint rate limit — its throttle key covers passcode and face only.** Do not
port the hole. v2 now has a working model to copy from: **T-303's `pin_attempt_throttle`**, already
shipped, already org-scoped, already enforced before the expensive work.

⚠️ **Sequencing:** this is cheap but it is not free, and it should land with E rather than after it
— the window where capture works and nothing limits it is the window nobody will remember to close.

**Needs from Ian.** Nothing. **Needs a migration index** if it takes its own table rather than
extending T-303's.

---

# 7. OUT OF SCOPE — each with a reason

| Excluded | Why |
|---|---|
| **Face recognition** | 2.1% of real sessions (15 of 703), and bible §5.3 permanently excludes face templates from the mirror — *"never mirrored, never cached, never bundled"*, after v1's 2026-07-04 exfiltration finding. ⛔ **Do not re-propose** |
| **NFC / QR / passcode capture** | **0 of 703 sessions in five weeks.** The scan box already accepts anything that types |
| **Porting v1's 1,070-line clock screen** | It is 1,070 lines *because* of the four methods above. v2 extends its own 501-line screen |
| **v1's nonce/ticket design** | Considered and deliberately abandoned in v1 |
| **v1's `src/lib/offline/*` TTL + bundle machinery** | §8.2 — Firestore's own persistence already does it |
| **Relaxing `biometricMirror`'s terminal-only rule** | Non-negotiable, bible §5.3 |
| **An x86 ABI for emulator testing** | v1 ships none; adding one means a vendor build nobody has |

---

# 8. THE TWO QUESTIONS, ANSWERED

## 8.1 ⭐ Can `FingerprintPlugin.java` be trusted, or is C a rewrite? — **PORT. There is no year of drift.**

The premise is that v1's plugin has aged. **Measured, and it has not:**

| | v1, today | v2, today |
|---|---|---|
| Capacitor | **8.3.0** (`@capacitor/core`, `/android`, `/cli` all `^8.3.0`) | none yet |
| `compileSdk` / `targetSdk` | **36 / 36** (Android 16) | — |
| `minSdk` | 24 | — |
| Next.js | `^16.1.6` | **`^16.1.6` — identical** |

The plugin imports only the **stable** `com.getcapacitor` surface — `Plugin`, `PluginCall`,
`PluginMethod`, `@CapacitorPlugin`, `JSObject`, `JSArray` — which has been unchanged in shape across
Capacitor 4→8, plus Android's own `UsbManager`/`UsbDevice` and ZKTeco's SDK classes.

> **Verdict: slice C is a PORT.** The real risks are not API drift, they are:
> 1. ⛔ **the `appId` collision** (§Slice B) — the sharpest one, because it silently replaces v1's
>    clock app on a tablet Ian is still running the business on;
> 2. **arm-only ABIs**, which forbid emulator testing and set C's done-when;
> 3. the vendor jars' redistribution, which is Ian's to confirm.
>
> ⚠️ **Budget C as "port + re-verify on hardware", not "rewrite informed by".** If the dongle model
> in the shops differs from what the vendored `.so` supports, that is discovered in an afternoon on
> the device — which is another reason D comes first.

## 8.2 ⭐ How much of v1's 483-line offline bundle must be re-derived? — **Far less than the line count. Most of it is already built, differently.**

v1's offline half is a **hand-rolled IndexedDB cache**: `db.ts` (25), `credential-cache.ts` (98,
with TTL, refresh-at-half-life and eviction-proofing), `bundle.ts` (79), `punch-queue.ts` (46),
`sync-engine.ts` (40), `offline-clock-device.ts` (79), `useOnlineStatus.ts` (14).

**v2 replaced that architecture before this task existed:**

| v1 file | v2 equivalent | Port? |
|---|---|---|
| `db.ts`, `credential-cache.ts`, `bundle.ts` — cache, TTL, refresh, eviction | **Firestore client persistence** + `biometricMirror` subscription (`lane.ts:140`) | ⛔ **No.** Re-deriving a TTL cache on top of a database that already has one is two caches that will disagree |
| `punch-queue.ts`, `sync-engine.ts` | **`writePunch`** (`lane.ts:208`) — offline write to IndexedDB, idempotent by document id, `acknowledged` split off deliberately | ⛔ **No**, and v2's is better reasoned: its comment records a real failure v1's design invites |
| `useOnlineStatus.ts` | trivial, if a screen needs it | maybe, 14 lines |
| **the templates themselves** | publisher already sends them (`publisher.ts:187`); **`MirroredCredential` drops them** | ⭐ **One field.** The whole "offline credential bundle" question reduces to `templates?: string[]` on `lane.ts:21-27` |

> **Answer: ~1 line of data plumbing plus the reader pool from slice A, not 483 lines.** The
> orchestrator's suspicion — *"much less than the line count suggests"* — is right, and the reason
> is that v2 chose Firestore-with-persistence where v1 hand-rolled a cache.
>
> ⛔ **The one thing v2 genuinely lacks is NOT in those 483 lines** — it is the service worker that
> lets the webview boot at all without a network. §5.2.

---

# 9. ⚠️ WHAT I DID NOT VERIFY

- **Nothing was run.** No code written, no build, no install, no device. Static reading and the
  golden corpus only.
- **The 94% is from a captured corpus, not live production.** 703 sessions, 3 stores (v1 has seven),
  2026-08-01 → 2026-09-04. ⚠️ It is a real measurement of a real window, not a claim about today —
  and I could not query production from here.
- **Whether the dongles in the shops match the vendored `.so`.** v1 ships `libzkfinger10`,
  `libzkalg12`, `libzksensorcore`, `libslkidcap` — consistent with ZK9500/SLK20R-class readers.
  **Nobody has named the actual model.** Worth asking Ian before slice C, not during it.
- **Whether `erp2.shareat.net` can serve a webview at all** — DEF-341 says it is not in the Firebase
  authorised-domain list. Email/password does not check it; **a webview shell might.** Flagging as a
  possible slice-B blocker I could not test.
- **v1's `sw.js` correctness.** I read its size and cache convention, not its logic.
- **How many staff work across branches** — relevant to slice F's per-device rule, unmeasured.
