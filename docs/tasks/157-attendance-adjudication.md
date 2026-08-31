# T-157 — The adjudication engine: what a day actually pays

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> **Depends on:** T-155 (`ShiftDay`, config), T-156 (`attendance_punches`).
> **Blocks:** T-158, T-195 (⚠️ specced as "T-166", a number the inventory lane took for Deliveries), and **all of Phase 5** — payroll multiplies this task's output by a rate.
> ⚠️ **This is the highest-risk task in the phase.** It is a re-derivation of the densest business
> logic in v1, and discovery 15 §3 says so directly: *"read `shift-boundaries.ts`, `workday.ts` and
> `session-hours.ts` **in full** before touching any of it in v2; the doc comments in these three
> files carry more real business decisions than any other attendance code."*
> **Read those three files before writing a line.** They are not long, and the spec below is a map
> of them, not a substitute.

## What this task produces

One row per person per shift day in `attendance_days`, derived from that day's punches and the
config in force **on that day** (T-155 §B.4 `getConfigForShiftDay`), recomputable at any time,
frozen once payroll consumes it.

## ⛔ The one invariant that outranks everything else here

`shift-boundaries.ts:192-198`, and it is stated as a property that any future change must preserve
rather than as a description of what the code happens to do:

> **"Moving the anchor forward NEVER reduces a day's guaranteed paid hours."**
> *Tier 1 — both anchors cap at `required`, so pay is identical and only the lateness (an artifact
> of which start we assumed) disappears. Tier 2 — both credit `halfDayHours`, so pay is again
> identical; only the pending, approval-gated OT remainder shrinks.*

⭐ **Re-derive this, do not merely match today's outputs.** A reimplementation that produces the same
numbers on the test corpus but does not hold this property will diverge the first time a store
changes `requiredHoursPerShift`. Discovery 15 "Intent worth preserving" #2 makes the same point.

## The rules, in the order they must be applied

⚠️ **The order is itself a business decision, twice over.** Getting it right is most of this task.

| # | Step | Source | The trap |
|---|---|---|---|
| 1 | **Pair** the day's punches — first `in`, last `out`. Middle punches are audit only (except breaks, step 8) | `shift-pairer.ts` | Superseded punches (T-156 §5) are excluded. A day with only one punch is `missing_out`, not a zero-hour day |
| 2 | **Grace-adjust the end.** An out within `earlyOutGraceMinutes` of the next hour rounds **up** to it | `shift-boundaries.ts:104-134` | ⭐ Because the end is **floored to the hour**, letting a closer go at 23:45 otherwise costs the whole remaining 45 minutes, not the 15 actually lost. Default 0, so shipping it moves nobody's pay |
| 3 | **Resolve the start anchor** — Tier 1 / Tier 2, §2 below | `shift-boundaries.ts:203-284` | The heart of the task |
| 4 | `rawHours = endHour − anchorHour`; **cap at `requiredHoursPerShift`** | `session-hours.ts:107-109` | Staying longer does not auto-pay; the excess becomes pending OT (Phase 5) |
| 5 | ⛔ **Undertime grace — BEFORE the short-shift rule** | `session-hours.ts:112-129` | v1's comment is explicit: run it after, *"a 8h50m day against a 9h requirement would already have been demoted to a 5h half day, and 'forgive 10 minutes' would then have to UNDO a half day — the two rules would be fighting over the same session"* |
| 6 | **Short-shift half-day + OT remainder** (opt-in, `shortShiftHalfDayOt`) | `session-hours.ts:131-144` | Below `halfDayHours` there is **no** half day and **no** OT — it pro-rates to actual hours |
| 7 | **Night differential** over `[anchor, anchor + computedHours]`, within the configured window | `session-hours.ts:35-44` | Measured over the **paid** window, not the raw span. The window is config, not the hardcoded 22–06 v1 shipped while the settings UI *"lied about controlling it"* |
| 8 | **Breaks:** only minutes **over** the paid allowance are deducted | `session-hours.ts:177-207` | Discovery 15 §1: *"Staff get a paid break allowance; only the EXCESS over that allowance costs them pay."* An unclosed break is an anomaly, not a zero-length break |
| 9 | **Holiday hours** — the day's paid hours, if the shift day is a PH holiday | `session-hours.ts:161` | Phase 5 applies the premium; this task only records the hours and the type |

## 2. The start anchor — the rule Ian set on 2026-08-20

`shift-boundaries.ts:191-198`, verbatim:

> *"**always try the next start first**, judge whether the hours are covered from there, and only
> fall back to the prior start — and record the lateness — when they are not."*
>
> - **Tier 1 (full day)** — the next start still delivers `requiredHoursPerShift` ⇒ anchor there,
>   **not late**.
> - **Tier 2 (half day)** — the day is short from the preceding anchor too, and its span sits closer
>   to `halfDayHours` than to the required hours ⇒ anchor at the next start as a clean half day.
> - **otherwise** — the preceding allowed start, and record the lateness.

The two gates on Tier 2, both of which exist because they were needed:

- ⛔ **Gate A — the preceding anchor must be genuinely short.** Without it *"a day that is FULL from
  the preceding start (14:15→22:50 pays 9h from 14:00) would still clear the lower half-day bar from
  the next start (8h ≥ 5h) and get **demoted to a half day purely to shed a late mark**"*
  (`shift-boundaries.ts:` Gate A comment). ⭐ Undertime the store has already forgiven does not count
  as shortness either.
- **Gate B — the delivered span decides which shift was worked.** Ian: *"if the hour covered is 6, 7,
  8, decide by which it is closer to."* ⭐ **Ties go to the late reading**, deliberately: it keeps
  today's behaviour and preserves the larger OT remainder, *"so the tie-break can never cost the
  staffer."*

Two more properties that fall out and must be preserved:

- A punch landing **exactly** on an allowed start is `mode: 'exact'` and is never reinterpreted —
  which is also what keeps a manager's explicit Late/Next-in decision (T-158) authoritative, since
  its chosen start is always exactly an allowed one.
- Tier 2 exists **only because the short-shift rule does.** With `shortShiftHalfDayOt` off, a short
  day pays its raw hours and moving the anchor forward *would* cut pay — violating the §1 invariant.
  The code checks this; so must the reimplementation.

## 3. ⭐ Integer minutes, not float hours — the one deliberate divergence from v1

v1 computes in **fractional hours as JavaScript floats**, and the consequence is visible in its own
source: `EPS = 1e-9` appears in `resolveStartAnchor`, `1e-6` in the undertime check, with comments
explaining that *"the hours arrive here as floats, so an exactly-on-the-limit shortfall must not be
refused by a representation artifact."*

**v2 computes in integer minutes throughout**, converting to hours only for display and for the
`numeric` columns payroll reads.

- Bible §6 bans floats for money; **hours are money one multiplication away**, and the same argument
  applies with the same force.
- Every `EPS` disappears. An epsilon is not a business rule — it is an apology for the number type,
  and each one is a place where "exactly 5 hours" might not be.
- ⚠️ **This can change outputs at exact boundaries**, which is precisely what the golden master in
  §6 exists to surface. **A divergence found there is a finding to report, not a number to match.**
  Bible §1.3: where v1 and correct behaviour disagree, the divergence is recorded.

## 4. `attendance_days` — the derived row

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | |
| `orgId` / `storeId` / `employmentId` / `personId` | `uuid not null` | |
| `shiftDay` | `date not null` | `unique (employment_id, shift_day)` — **one row per person per day** |
| `attendanceConfigId` | `uuid not null` → `store_attendance_config` | ⭐ **The historical-integrity link.** Recomputing in June gives March's answer |
| `firstInPunchId` / `lastOutPunchId` | `uuid null` → `attendance_punches` | The evidence, not a copy of it |
| `anchorMinute` | `integer null` | Minutes from the shift day's 05:00 start |
| `anchorMode` | `text not null` CHECK `('exact','previous','next','unallowed')` | v1's `startAnchorMode` |
| `endMinute` | `integer null` | Grace-adjusted |
| `computedMinutes` | `integer not null default 0` | ⭐ **After** every step in §1 |
| `isHalfDay` | `boolean not null default false` | |
| `cappedAtRequired` | `boolean not null default false` | |
| `lateMinutes` | `integer not null default 0` | Recorded always; whether it costs money is Phase 5 |
| `undertimeForgivenMinutes` | `integer not null default 0` | |
| `breakMinutes` / `allowableBreakMinutes` / `breakOverMinutes` | `integer not null default 0` | |
| `nightDiffMinutes` | `integer not null default 0` | |
| `isHoliday` / `holidayType` / `holidayMinutes` | | `holidayType` CHECK `('regular','special_non_working','special_working')` |
| `pendingOtMinutes` | `integer not null default 0` | The short-shift / late-out remainder. ⛔ **Recorded, never paid here** — the approval gate is Phase 5 |
| `status` | `text not null` CHECK | §5 |
| `anomalies` | `text[] not null default '{}'` | §5 |
| `computedAt` / `computedFromPunchCount` | | Cheap staleness detection |
| `frozenAt` / `frozenByPayRunId` | `timestamptz` / `uuid` null | §5. The column lands now; Phase 5 sets it |
| `createdAt` / `updatedAt` | | |

⭐ **Every duration is an integer minute count.** `numeric` hours appear only where payroll reads
them, and are derived at that boundary.

## 5. Status, anomalies, and the two things a recompute must never do

**Statuses:** `open` (an in with no out yet) · `computed` · `needs_review` · `verified` · `voided`.

⚠️ v1's `SessionStatus` also has `auto_paired`, `half_day` and `edited` — **three values that encode
*facts about the computation* inside the *status*.** `half_day` duplicates `isHalfDay`; `edited`
duplicates "an adjustment row exists"; `auto_paired` means "computed and nothing was wrong." That is
landmine #12 (*two switches governed one behaviour*) in enum form. **v2's status answers one
question: how much can this day be trusted for pay.**

**Anomalies** (`text[]`, from a closed vocabulary): `missing_in` · `missing_out` · `no_punches` ·
`overlapping` · `start_not_allowed` · `break_not_closed` · `late_event_arrival` (T-156 §3 — the punch
arrived more than 72h after it occurred).

⛔ **Two rules a recompute must hold, and both closed real bugs in v1:**

1. **A recompute never promotes `needs_review` to payable.** v1: *"if the session being closed was
   already `needs_review` (e.g. manager-flagged missing-out), a replay's clock-out data is written
   but the **status is deliberately kept at `needs_review`** rather than promoted"*
   (`attendance-clock.actions.ts:309-314`), because the promoted status is in payroll's
   `PAYABLE_STATUSES`. A late-arriving offline punch must not silently make a flagged day payable.
2. **A frozen day is never recomputed.** Once `frozen_at` is set, recomputation **refuses** rather
   than overwriting. This is discovery 15 "Intent worth preserving" #6 — the payslip guarantee — and
   it is enforced by a trigger refusing UPDATE of any computed column while `frozen_at is not null`,
   not by the service remembering to check.

## 6. ⭐ Golden-master testing — bible §15.2 calls it "the most important practice here"

A hand-written test suite for this logic will encode my reading of the rules, and my reading is the
thing most likely to be wrong. So:

1. **Capture real v1 sessions.** `npm run capture -- --collection attendanceSessions` for the three
   real stores, pseudonymised through the existing corpus machinery (`packages/etl/`). Each captured
   session carries v1's own inputs (`rawClockIn`, `rawClockOut`, the store's config) **and** its own
   outputs (`computedHours`, `shiftStartHour`, `startAnchorMode`, `isHalfDay`, `nightDiffHours`).
2. **Replay the inputs through v2 and diff the outputs**, into
   `packages/domain/tests/golden/attendance-adjudication.test.ts`.
3. ⭐ **Every divergence is triaged, not suppressed.** Three legitimate outcomes, and the third is
   the one that pays for the whole exercise:
   - v2 is wrong → fix v2.
   - v1 was wrong → **log it in `DEFECTS-REGISTER.md` A–D with `file:line`** and pin v2's behaviour
     with a test naming the row. Bible §1.3: *"Where v1 and correct accounting disagree, practice
     wins — and the divergence is recorded. A v1-vs-v2 difference is a **finding**, not a failure."*
   - The integer-minutes change (§3) moved an exact boundary → record it as expected, with the case.

> ⚠️ **`tests/golden/` is currently an empty directory and sits outside every vitest include glob —
> DEF-081.** A test placed there today **would never run.** ⛔ **Fix the glob as part of this task,
> and prove it by watching a deliberately failing golden test actually fail.** A golden master that
> silently does not execute is worse than none, because it is credited in the definition of done.

## 7. Service layer — one resolver, and only one

```ts
adjudicateDay(tx, { employmentId, shiftDay }): Promise<AttendanceDay>
adjudicateRange(tx, { storeId, from, to }): Promise<AttendanceDay[]>
```

⛔ **One resolver.** Discovery 15 §3: v1 previously had *"three previously-hand-duplicated
computations (clock-out, manager review, Late/Next-in decision)"* whose drift *"had already caused
two real bugs — short-shift OT silently dropped on a review edit; lateness not re-derived after a
correction."* `workday.ts` is v1's own fix for this. **Every caller in v2 — the ingestor, the manager
screen, the payroll preview, the roster — calls `adjudicateDay` and nothing else recomputes.**
Enforced by keeping the arithmetic in one non-exported module with a single entry point.

⭐ **The pure core takes values, not a database.** `computeDay(punches, config, holidays)` is a pure
function; `adjudicateDay` is the thin transactional shell that loads, calls it, and upserts. That is
what makes the golden master possible at all, and it is the same shape `packages/domain/src/ledger/`
already uses.

## Invariants

1. ⛔ Moving the anchor forward never reduces `computedMinutes` — property-tested across generated
   configs and spans, not just fixed cases.
2. Undertime grace applies **before** the short-shift rule; an 8h50m day against 9h with 10 minutes
   forgiven is a **full day**, not a half day.
3. A day full from the preceding anchor is never demoted to a half day (**Gate A**).
4. A Gate B tie resolves to the **late** reading.
5. Only break minutes over the allowance reduce pay.
6. Night-diff minutes are measured over the **paid** window and honour the configured hours.
7. `computedMinutes` never exceeds `requiredHoursPerShift`; the excess is `pendingOtMinutes`.
8. Recomputing a `needs_review` day leaves it `needs_review`.
9. Recomputing a frozen day is **refused**, by trigger.
10. Recomputing an unchanged day is **idempotent** — same output, `updated_at` unchanged.
11. A day computed under config A, then re-computed after a supersede, still uses **A**.
12. `no_punches`, `missing_in`, `missing_out` and `break_not_closed` each produce their anomaly and
    a non-payable status.
13. Every duration column is an integer; no float reaches the database.
14. Golden master: every captured v1 session either matches, or has a triaged, documented divergence.

## Tests

Unit for `computeDay` (pure, `TZ` pinned) · integration for `adjudicateDay` on **`shareat_test_b`** ·
golden as §6.

⭐ **Property-based for invariant 1**, per bible §15.2 and the shape T-111 was supposed to have
(DEF-080 records that it never got them — do not repeat that here): generate a config and a span,
compute at both candidate anchors, assert paid minutes never decrease when the anchor moves forward.

Hand-written cases, minimum: a 14:15 in / 23:45 out against starts `[14,15]` — the case
`shift-boundaries.ts`'s own comment uses · an exact-start punch · a punch before every allowed start
· a store with **no** allowed starts configured · an overnight shift crossing 05:00 · a break under
allowance · a break over allowance · an unclosed break · a night-diff window wrapping midnight · a
holiday · `shortShiftHalfDayOt` off vs on for the same day.

## Out of scope — each with its reason

**The manager's Late/Next-in, early-out and half-day decisions** — T-158. ⭐ This task's engine must
**accept them as inputs** (its signature takes adjustments), but the recording, authorization and
materiality gate are that task's · **The C1 inverted-window guard** — it defends against a
*combination of two adjustments* (`workday.ts:126-165`), so it belongs where the adjustments are
created; noted here so it is not lost · **Overtime approval and any pay figure** — Phase 5. This task
records `pendingOtMinutes` and stops · **The late-policy money and the infraction filing** — Phase 5
and Phase 7 respectively; `latePolicy` is read only to know whether to record minutes · **The missed
clock-out sweep** — see T-195 (⚠️ specced as "T-166"; T-195 §4 declined to build the sweep too — it still wants its own task) · **The holiday calendar's CRUD** — this task consumes a dated list; the
management screen is Phase 7 · **Fixed-mode shift templates** — T-155 Out of scope, and no store runs
fixed mode.

## Done when

- [ ] All fourteen invariants pass, invariant 1 property-based.
- [ ] ⭐ `tests/golden/` **runs** — proven by watching a deliberately failing golden test fail.
      DEF-081 updated to record that half of it is closed.
- [ ] Every golden divergence triaged: fixed, logged as a v1 defect with `file:line`, or documented
      as the expected integer-minutes change.
- [ ] Migration hand-written, **0070–0089**, journal row `previous.when + 86400000`.
- [ ] `attendance_days` classified in `cutover/classification.ts` **and** `rls/registry.ts` —
      ⭐ **own first commit**.
- [ ] `npm run typecheck` · `npm test` · `npm run test:integration` green, real output reported.
- [ ] ⚠️ **Any rule in §1 or §2 that could not be reproduced from v1's source is reported, not
      guessed.** §3.4a — a spec is a hypothesis, and this one is a reading of three dense files.
