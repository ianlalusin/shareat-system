# Phase 4 — Attendance, biometrics, and the hot lane

| | |
|---|---|
| **Status** | Planned 2026-08-29 (Opus planner, session `ianla-f9`, lane B) |
| **Governed by** | `PROJECT_BIBLE.md` **§5** (the two-lane contract — the binding one), §4.2, §7.1, §10, §12 rows 14–23 |
| **Research** | `docs/discovery/05-offline-and-biometrics.md` and `docs/discovery/15-capabilities-people.md` — both pre-date this plan, so §3.6 is satisfied without a new pass |
| **Prerequisite** | T-138 (identity + sessions) — **shipped.** `resolveActor` is what makes a punch attributable |
| **Exit gate** | *A terminal clocks in with the network pulled and reconciles cleanly on reconnect* |
| **Lane** | Runs parallel to the accounting sequence. Migrations **0070–0089**, test database **`shareat_test_b`** |

---

## 0. The finding this plan opens with

⛔ **The Phase 0 offline spike does not exist. Phase 4's technical risk was never retired, and
the roadmap says it was.**

Bible §10 places attendance at Phase 4 on an explicit argument: *"its real risk is technical, and
technical risk is retired by a **spike in Phase 0**, not by building the whole module early."*
`docs/ROADMAP.html:555` marks Phase 0 **complete**, with an exit gate reading *"the spike proves an
offline write survives and reconciles."*

Searched, and absent in every direction:

| Looked for | Result |
|---|---|
| `firebase.json`, `firestore.rules`, emulator config | **None anywhere in the repo** |
| A Firestore **client** SDK dependency (`firebase`) | **None.** Only `firebase-admin` — server-side, for the ETL reader and Storage brokering |
| `packages/domain/sync/` — the publisher/ingestor home `CLAUDE.md` documents | **Does not exist** |
| A spike task under `docs/tasks/` | **None.** The list runs 101 → 152 with no Phase-0 spike |
| A commit mentioning the spike | **None** in 281 commits. `9a03ad4` is T-114a, the ETL *reader* — a different thing |

**Logged as DEF-085** (section E — Shareat System itself). It is a planning defect, not a code one:
a phase was marked complete against a gate that nothing satisfied, and the phase that depends on it
is this one.

**Consequence for this plan, and it is the whole shape of Wave 0.** Every downstream task —
publisher, ingestor, rules, terminal — rests on a contract (bible §5.2: *"the clock terminal reads
and writes Firestore via the **client SDK**, never via Server Actions"*) that has never been run
once in this codebase. **T-153 is that spike, restored to the front of Phase 4 where it now has to
live.** It is time-boxed and disposable exactly as the bible specified, and Wave 3 is not specced
until it reports.

> ⚠️ **I am not amending `ROADMAP.html` or the bible** — §14, and Ian's lane constraint. Phase 0's
> status is Ian's to correct. The register row is the record.

---

## 1. Objective

Put a punch in Postgres that survives the network being pulled, and adjudicate it on the server
with the full ruleset — so Phase 5 has hours it can pay against, and so the one architectural claim
this project is built on (**Postgres owns the truth, Firebase owns the edge**) is finally load-bearing
rather than aspirational.

Phase 4 **posts nothing to the ledger.** That is what makes it a parallel track: money enters only
through payroll, in Phase 5, which is the back half of this same lane.

### What "done" means here

Not feature parity with v1's attendance module. **The gate is one sentence and it is physical:**
unplug the network at a terminal, clock somebody in, plug it back in, and the day adjudicates
correctly with no manual repair. Everything in this plan either serves that sentence or is a
capability `docs/CAPABILITY-GAPS.md` assigned to Phase 4 and nobody else.

---

## 2. What Phase 4 owns, including two things the roadmap line does not say

The roadmap names four deliverables: *punch model, server-side adjudication, Lane A publisher,
Lane B ingestor, offline clock terminal.* `docs/CAPABILITY-GAPS.md:152-153` assigns two more here,
and they are load-bearing rather than optional:

| # | Deliverable | Source |
|---|---|---|
| 1 | **Staff master record + position taxonomy** | GAPS row: *"load-bearing for 4 and 5; previously unowned."* Attendance needs someone to punch against; payroll needs a rate to pay. Discovery 15 §"no home in the plan" #1–2 |
| 2 | Punch model — raw facts, append-only | Roadmap; bible §4.2 rule 9 names attendance punches explicitly |
| 3 | Server-side adjudication — the span-based day judgment | Roadmap; discovery 15 §3, the densest business logic in the domain |
| 4 | Lane A publisher (mirror) + Lane B ingestor (inbox) | Roadmap; bible §5.1 |
| 5 | Offline clock terminal | Roadmap; the exit gate |
| 6 | Credential enrolment + the biometric mirror | Bible §5.3 hot-set items 2 and 5 |
| 7 | **Absentee / leave tracking** | GAPS row: assigned to Phase 4, *"independent monthly and yearly caps, no phase"* |

**Not Phase 4, and named so nobody folds them in:** overtime approval, late-policy *money*, statutory
deductions, pay runs, the slicer stream, 13th month, separation pay — all Phase 5 · infractions and
performance — Phase 7 · the APK shell — §7 below.

---

## 3. The patterns, named before the design (bible §0.2)

Boring and standard, all four, and all four are the textbook answer to the exact problem:

| Problem | The industry pattern | Why not something else |
|---|---|---|
| Publish a Postgres row to Firestore **atomically with the transaction that changed it** | **Transactional outbox** — the write and the outbox row commit together; a relay drains it | A post-commit hook or a dual write can lose the publish when the process dies between the two. Bible §15.4 already forbids dual-write; the outbox is the sanctioned way to keep that promise |
| Accept the same offline event twice without double-counting | **Idempotent consumer / inbox** with a `UNIQUE` idempotency key | Bible §4.2 rule 10 states this outright: *"Idempotency keys are UNIQUE constraints... This replaces debounce/throttle guesswork."* v1 uses an 8-second timer **and** a marker doc; the timer is the part that caused a production incident |
| A day's pay is derived from facts that must stay auditable | **Append-only fact table + derived projection.** Punches are immutable; the adjudicated day is recomputable from them | Not event sourcing — bible §15.10 draws that line explicitly. One fact table and one derived table, not an event store |
| Config that must not retroactively move a past day's pay | **Effective-dated reference data**, referenced by id from the row it governed | The alternative is snapshotting ~20 config values onto every day row. Same guarantee, twenty times the width, and it drifts. The repo already uses supersede-don't-update for `person_roles` and `person_grants` |
| A device that authenticates to Firestore as *itself*, with no plaintext secret | **Firebase Auth custom token minted for a device principal** | Bible §5.3: the device credential must **not** be plaintext in `localStorage` (v1 stores `{id, secret}` in the clear). A custom token lets the SDK hold the refresh material in its own storage, and makes the rule expressible as `request.auth.token.deviceId` instead of a lookup |

---

## 4. The three design decisions that shape everything downstream

### 4.1 ⭐ v1 conflates three different things in one document. v2 splits them, and that is the point

`AttendanceSessionPlain` (`ERP-rebuild/src/types/attendance-session.ts`) carries, in one Firestore
document: the **raw taps** (`rawClockIn`, `rawClockOut`, `rawTapIds`), the **computation**
(`computedHours`, `nightDiffHours`, `isHalfDay`, `shiftStartHour`), and the **manager's overlay**
(`payrollInMode`, `earlyOutApproved`, the half-day override). Its own comments admit the strain —
the overlay fields carry a paragraph explaining they *"NEVER touch rawClockIn / rawClockOut /
computedHours"*, which is a convention held by comment, not by structure.

v2 splits them into three tables with three different mutability rules:

| | Table | Mutability | Why |
|---|---|---|---|
| **Fact** | `attendance_punches` | **Append-only.** No UPDATE, no DELETE, enforced by trigger | Bible §4.2 rule 9 names attendance punches. A correction is a compensating punch |
| **Decision** | `attendance_adjustments` | Append-and-supersede, attributed to a verified actor | The manager's Late/Next-in call, early-out approval, half-day override. **An input to the computation, not a patch on its output** |
| **Derived** | `attendance_days` | Recomputable from the two above, frozen once payroll consumes it | Bible §4.2 rule 7. *"Recompute from truth"* becomes real — v1 cannot do it, because the overlay lives inside the thing it would overwrite |

⭐ **This is what makes the payslip guarantee mechanical rather than aspirational.** Discovery 15
"Intent worth preserving" #6: *a payslip must never disagree with what was actually recorded, even
if today's config has since changed.* v1 achieves it by storing `payrollComputedHours` and reading
the stored value. v2 achieves it because the day row names the `attendance_config_id` it was computed
under, so recomputing is deterministic and re-deriving a March day in June gives March's answer.

### 4.2 ⛔ "Session" is already taken twice. The attendance day is not called a session

`docs/GLOSSARY.md:80` — **`session` ⚠️** means *a group of diners at a table*, and the glossary
already warns *"When you mean authentication, say auth session explicitly"* because
`packages/db/schema/sessions.ts` took the second meaning. v1's `attendanceSessions` would be the
**third**.

**Names, fixed here:** `attendance_punches` (the fact) · `attendance_days` (the adjudicated day) ·
**shift day** (the 05:00→05:00 Manila calendar) — never "session", in a table name, a type, a
variable, or a screen label. T-155 adds all three to the glossary.

### 4.3 The shift day starts at 05:00, and it is a different calendar from the financial day

`ERP-rebuild/src/lib/attendance/shift-day.ts`, verbatim: *"A shift day runs 05:00 → 05:00 PHT, not
midnight → midnight: a closing staffer who taps out at 01:30 belongs to the day they started."* v1
is explicit that this is **not** the financial `dayKey`, which is midnight-based, and it named
`sessionDate` differently for exactly that reason.

⭐ **And `packages/core/src/datetime.ts` already told us where to put it.** Its own header:

> *"If a module needs a different cut-off (a sales day that closes at 4am, say), that belongs in
> **that module as an explicit, named rule** — not as a quiet change to this function."*

So the shift-day calendar lands in `packages/domain/src/attendance/shift-day.ts`, **built on** core's
primitives rather than reimplementing them — which honours that instruction and bible §12 landmine 26
(*"v1 had FOUR coexisting date idioms… There is exactly one here. Do not add a second"*) at the same
time. Adding a 05:00 variant beside `toBusinessDate` in core is exactly how the two get swapped in a
payroll query a year from now. T-155 builds it, with a unit test pinning the case that separates
them: a 01:30 punch lands on the **previous** shift day and the **current** financial day.

---

## 5. Open decisions — Ian's, with a recommendation each

### ✅ D1 — DECIDED 2026-08-29. **Fingerprint, face and card. No PIN.**

Ian: *"in v2 only fingerprint face and card will be mode of attendance no pin"*, and the offline
recommendation below is accepted.

⚠️ **Recorded because I first read this backwards.** My initial reading of *"turn off biometrics by
pin"* was "turn off biometrics, use PIN"; it means **turn off the PIN that stands in for
biometrics**. The correction matters and it is written down rather than quietly fixed, because the
two readings put the biometric mirror on opposite sides of the scope line.

| Mode | In v2 | Offline? |
|---|---|---|
| **Fingerprint** | ✅ | Yes — but the on-device match is a native plugin, so it needs the APK (D2) |
| **Face** | ✅ | ⛔ **Never.** Online-only, permanently — bible §5.3, the 2026-07-04 exfiltration fix. *Do not re-propose* |
| **Card** (NFC tap / QR badge) | ✅ | **Yes, in a plain browser.** ⭐ Therefore **the offline path that meets the exit gate today** |
| **PIN** | ⛔ **Removed** | — |

**What follows, and it is most of Wave 3–4's shape:**

1. ⭐ **The biometric mirror is IN scope** — hot-set item 2 (fingerprint templates + matchToken)
   stays, with bible §5.3's non-negotiable access control: *readable only by a provisioned device
   identity, never by an ordinary staff or manager account*, and the credential **not** plaintext in
   `localStorage`. T-153 proved the device-principal design works (§6, finding 3).
2. ⭐ **Card is the exit gate's credential.** Fingerprint cannot meet it until the APK lands, and
   face never will. A QR badge decoded client-side against the mirrored roster clears it with no
   native code — which is why D1's recommendation mattered.
3. ⛔ **PIN is made UNREPRESENTABLE, not merely disabled.** `attendance_punches.method` drops `pin`
   from its CHECK, and `store_attendance_config` drops `credential_passcode` — there is no switch to
   leave in the wrong position (bible §12: *"must make each one structurally impossible, not merely
   avoided by care"*). A `pin` credential still exists in `person_credentials` for **signing in to
   the app**; that is a different act from clocking in, and only the latter is closed.
4. ⚠️ **NEEDS A BIBLE AMENDMENT, and I may not make it.** §5.3's hot set is **closed** and its item 1
   is *"Active local-user roster (name, position, staffId)"* — **a card id is not in it.** Resolving
   a card offline requires mirroring one. That is an addition to a closed list, which §5.3 says
   requires an amendment, and §14 plus this lane's constraints reserve that for Ian. **Reported, not
   done.** Until it is made, the offline card path cannot be built.

> Anti-buddy-punch, if the bearer risk bites: a card is a bearer credential, and a photo of a badge
> punches. A photo captured at the punch is the standard mitigation and is cheap. **Not built** —
> named so it is a decision rather than an oversight.

### 🅿️ D2 — PARKED 2026-08-29, leaning YES

Ian: *"park the decision for now but im leaning forward to yes"*.

The Capacitor APK and its native ZK9500 plugin are **not** built in Phase 4. Nothing here forecloses
it: the fingerprint mode, its config kill switch and hot-set item 2 all exist, so the APK lights up
an already-modelled path rather than adding one.

⚠️ **The consequence while it is parked:** a store with no card issued and no APK has **no offline
attendance at all.** That is not a regression — it is v1's position too — but it means the card
rollout is a prerequisite for the exit gate, not an alternative to it.

### ✅ D3 — the 72-hour ceiling: dissolved, no decision needed

`MAX_QUEUE_AGE_MS = 72h` (`offline-replay.ts:7`). Past it, v1 rejects a punch and **dead-letters it
into an IndexedDB store with no reader** — landmine #14, and discovery 05 §6: *"no admin/manager UI
was found anywhere in the app that reads dead-lettered punches."*

⭐ **The two-lane model dissolves it.** In v2 the event lives in Firestore, never in a private device
store, so it is never unreachable and refusing it gains nothing. **Built as specced:** the ingest
always accepts, and 72 hours became a `late_event_arrival` anomaly for a manager to confirm. Same
constant, opposite consequence — a flag instead of a cliff.

### ✅ D4 — DECIDED 2026-08-29. Capture, and **improve rather than merely match**

Ian: *"yes use available data to model v2 improve what can be improved"*.

⭐ **This re-frames the golden master.** It is not a parity straitjacket — it is a way to understand
what v1 actually produced, and every divergence is a candidate improvement rather than a defect in
v2. Bible §1.3 already allows this (*"a v1-vs-v2 difference is a **finding**, not a failure"*); Ian's
answer makes it the default posture.

Counted 2026-08-29 (count-only, zero document reads): **624 attendance sessions** — Lipa 483,
Malvar 115, Banay-Banay 26, Davao 0. ⚠️ Smaller than it might be because May–July attendance was
purged in v1 (2,660 documents).

### ✅ D5 — DEF-086: **fix it, do not port the hole**

Ian, on the undertime-grace defect: *"about payroll its not yet implemented in v1 lots of work to do
so we do it right and implement in full in v2"*.

So v2 does **not** pin v1's behaviour. The hour-flooring of the paid end is the artifact — it is what
makes `undertimeGraceMinutes` under 60 unable to fire, and it is why `earlyOutGraceMinutes` had to be
invented to patch it. **v2 pays real minutes**, and both graces then mean what their names say.
Detail and the closing tests in DEF-086's disposition.

---

## 6. The task sequence

### Wave 0 — retire the risk Phase 0 was supposed to retire

> **Nothing downstream is specced until this reports.** Specifying a publisher, an ingestor, a
> ruleset and an offline terminal against a contract that has never been executed once would be
> writing fiction, and bible §3.4a is explicit that a spec is a hypothesis.

| # | Task |
|---|---|
| **T-153** ✅ | **The Firestore two-lane spike** — emulator, client SDK, a 50-line deny-by-default ruleset, a toy mirror doc and a toy inbox event. **Time-boxed and disposable.** Proves: an offline write survives a reload, replays on reconnect, and a client cannot write a mirror doc or update an inbox event |

> ### ✅ **T-153 ran 2026-08-29. The contract HOLDS — 14/14 green.** Findings in `spike/firestore-two-lane/README.md`
>
> All four gate assertions passed, and all four refusals were **watched failing** against a
> permissive ruleset first. **Bible §5.2 is correct as written:** the client SDK's offline
> persistence and automatic replay do make v1's hand-rolled `punch-queue.ts` + `sync-engine.ts`
> genuinely replaceable. **Waves 3 and 4 may now be specced.**
>
> Nothing structural changed. Four constraints on *how*, which their tasks must carry:
>
> | Finding | Lands in |
> |---|---|
> | ⛔ **Rules are not filters.** An unconstrained `list` over `/inbox` is refused outright — every terminal query must carry `where('deviceId','==',…)`, matching the rule exactly | T-159 (rules + composite index), T-163 (every query) |
> | ⭐ **The persistent store is keyed `firestore/{firebaseAppName}/{projectId}/main`.** Renaming the app **orphans every unsynced punch**, silently. *This cost the spike two false negatives before it was found* | T-163 — a pinned constant with the warning attached |
> | ✅ **`request.auth.token.deviceId` works from a custom token** — the device-principal design (§3 row 5) is sound. But a device **must sign in while online**; it cannot start authenticating offline | T-159 — provisioning is not complete until a round trip succeeds |
> | 📏 **127 KB gzipped** (470 KB minified) for `app` + `auth` + the Firestore surface a terminal needs. Acceptable, and it *replaces* v1's queue rather than adding to it | T-163's first-load budget |
>
> ⚠️ **The honest limit:** the suite runs in Node with `fake-indexeddb` and a `localStorage` shim.
> **The terminal is a browser**, so the same four assertions must be re-run in a real one — for
> quota, eviction, the multi-tab lease, and WebView storage policy. **That is the one that could
> actually lose a punch**, and it is in T-163's definition of done, not deferred to goodwill.

### Wave 1 — the people spine (load-bearing for Phase 5, and unowned until now)

| # | Task |
|---|---|
| **T-154** ✅ | `positions` (canonical + store-defined) and `employments` (person × store × position × employment status, effective-dated). The staff master record `docs/CAPABILITY-GAPS.md:152` assigns here |
| **T-155** ✅ | The **shift-day calendar** in `packages/domain/src/attendance/` (§4.3), the glossary entries (§4.2), and `store_attendance_config` as **effective-dated** rows (§3, row 4) carrying v1's constants verbatim |

### Wave 2 — the punch model and the adjudication

| # | Task |
|---|---|
| **T-156** ✅ | `attendance_punches` — append-only, `UNIQUE (client_punch_id)`, immutability by trigger. The Lane B landing table, and the ingestor's target |
| **T-157** ✅ | ⭐ **The adjudication engine** — span-based start anchor, hours, breaks, night differential, holidays. The densest task in the phase; discovery 15 §3 and the three v1 source files it names are required reading |
| **T-158** ✅ | `attendance_adjustments` — the manager's Late/Next-in, early-out and half-day decisions as attributed inputs, plus verify/void, plus the *"is this decision even worth asking"* materiality gate |

> ### ✅ **Waves 0–2 built 2026-08-29.** 110 new tests, all green
>
> | | |
> |---|---|
> | T-153 | The spike. Contract holds, 14/14 |
> | T-154 | Positions, employments, roster. 21 tests |
> | T-155 | Shift day + effective-dated config. 16 unit (4 timezones) + 22 integration |
> | T-156 | The append-only punch. 19 tests |
> | T-157 | The adjudication engine. 36 unit incl. a property test + 14 integration |
> | T-158 | Manager decisions, C1, the deputy. 20 tests |
>
> Lane gates: `typecheck` clean · integration **45 files / 1269 tests green** on `shareat_test_b` ·
> unit 660 passed with **4 failures inherited** at base commit `e0c14f0` and untouched by this lane
> (three TOC-freshness checks on files this lane may not amend, one ETL capture test that reads the
> real `.env.local` and depends on gitignored `secrets/`).
>
> ✅ **T-157b closed the last of it (2026-08-29).** The golden master ran against 550 real v1
> sessions — **0 untriaged**, 109 identical, and a new **class D of 41 sessions that exists only
> because Lipa's stored grid is stale (DEF-087)**. The span-based Tier 1/Tier 2 anchor was deleted
> and replaced with nearest-hour on Ian's decision, once the research pass established that v1
> attendance **has never paid anybody** — `payrollRuns` and `payrollStaffPayouts` are zero, ever.
>
> ⭐ **Two findings came out of building, not auditing:** **DEF-086** (v1's
> `undertimeGraceMinutes` under 60 minutes can never fire, silently) and half of **DEF-081**
> (`tests/golden/` matched no vitest glob, so a test placed there would never have run).

### Wave 3 — the hot lane *(✅ unblocked — T-153 reported, Wave 2 has landed)*

> ⛔ **One clause of it is blocked, and it is on the critical path to the exit gate.** D1 makes
> **card** the only offline mode that works in a browser (face is online-only forever; fingerprint
> needs the APK, which D2 parks). Resolving a card offline means mirroring a **card id** — and
> bible §5.3's hot set is a **closed list** whose item 1 is *"Active local-user roster (name,
> position, staffId)"*. **A card id is not in it.** §5.3 says an addition requires an amendment and
> §14 reserves that for Ian. Everything else in Wave 3 proceeds without it.

| # | Task |
|---|---|
| T-159 | Firestore rules + device-principal provisioning (custom tokens, §3 row 5) — **now unblocked** |
| T-160 | Lane A publisher — transactional outbox → mirror, the six hot-set entities and nothing else |
| T-161 | Lane B ingestor — inbox → `attendance_punches`, with quarantine |
| T-162 | **The quarantine screen** — landmine #14 says it is first-class and alertable, not a banner saying *"tell a manager"* |

### Wave 4 — the terminal *(specced when Wave 3 lands)*

| # | Task |
|---|---|
| T-163 | The offline clock terminal — a client-SDK-only route, with a test that **fails the build** if a Server Action is imported on that path (bible §5.2 calls that a defect; a rule nothing enforces is a comment) |
| T-164 | Credential enrolment + the biometric mirror — device-identity read only, face permanently excluded |

### Wave 5 — the rest of what Phase 4 owns

| # | Task |
|---|---|
| T-165 | Absentee / leave tracking with independent monthly and yearly caps (`CAPABILITY-GAPS.md:153`) |
| T-166 | Missed clock-out sweep, on-shift roster, current-day punch feed (hot-set item 4) |

---

## 7. Invariants this phase must not break

Carried from discovery 15 "Intent worth preserving", each with its citation. **These are business
decisions, not tuning knobs** — a v2 rewrite that matches today's outputs without re-deriving them
has not preserved them.

1. ⛔ **Do not build a per-staff scheduled-start field.** Proposed and **rejected by Ian on
   2026-08-04**, re-affirmed 2026-08-20: schedules follow forecast demand, so a fixed expected start
   *"would not remove false lateness, it would manufacture a more confident kind of it"*
   (`shift-boundaries.ts:472-490`).
2. **Moving the start anchor forward never reduces a day's guaranteed paid hours**
   (`shift-boundaries.ts:192-198`). Only the lateness label and the pending-OT remainder move.
3. **One resolver for "what does this day pay."** v1 had three hand-duplicated copies and two real
   bugs came out of the drift (`workday.ts:1-18`). Do not reintroduce parallel computations.
4. **The inverted-window guard (C1).** A Late decision plus an early-out approval must not produce a
   paid window ending before it starts (`workday.ts:126-165`).
5. **Grace constants are per-store business decisions and default to 0** so shipping a fix never
   retroactively moves anyone's pay (`attendance-config.ts`, and the `earlyOutGraceMinutes`
   rationale at `shift-boundaries.ts:104-113`).
6. **A replayed clock-out never promotes a `needs_review` day to payable**
   (`attendance-clock.actions.ts:309-314`).
7. **The per-method kill switch is re-checked on every punch, replays included** — and in v2 it is
   **cached at the terminal** (hot-set item 3), which is landmine #15 and a bug fix, not a port.
8. **A punch is never authorized by a bearer token alone** (landmine #22). The device holds a
   principal; the server re-verifies on ingest.

---

## 8. Risks

| | |
|---|---|
| ~~The spike fails, or reveals the client SDK cannot do what §5.2 assumes~~ | ✅ **Retired 2026-08-29.** It held. The residual is that the proof is a Node shim, not a browser — carried into T-163's gate |
| **T-157 is a rewrite of the hardest logic in v1** | Three files, thousands of lines of hard-won judgment, and its comments carry more decisions than any other module. Mitigation: golden-master it — replay real v1 sessions and diff the hours (bible §15.2) |
| **Two calendars, one repo** | The 05:00 shift day beside the midnight financial day. Mitigation: §4.3's naming and a test that pins the 01:30 case |
| **Phase 5 pulling forward** | Payroll is the back half of this lane and it depends on T-157's output. **It does not start until the gate is met** — Ian's constraint, and the right one: paying against hours that cannot survive a network outage is the wrong order |
| **Lane collision** | Peers work `shareat_test` and migrations 0061–0069. This lane is `shareat_test_b` and 0070–0089, verified: 1173 integration tests green in isolation on 2026-08-29 |
