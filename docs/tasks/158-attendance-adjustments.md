# T-158 — Manager adjustments: decisions as attributed inputs, not patches on an output

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> **Depends on:** T-157 (`adjudicateDay` takes adjustments as an input), T-138 (`resolveActor` —
> without it every attribution below is theatre), T-121 (`manage_attendance`).
> **Blocks:** T-166 (the review screen), Phase 5 (a payable day is one a manager has settled).

## The shape, and why it is not v1's

v1 writes the manager's decisions **onto the session document itself** — `payrollInMode`,
`earlyOutApproved`, the half-day override — beside the computed hours they modify. The fields carry a
comment insisting they *"NEVER touch rawClockIn / rawClockOut / computedHours"*, which is a
convention enforced by a paragraph.

Here they are **rows in their own table**, and the adjudication engine reads them as inputs. Three
things follow, none of which v1 can do:

| | |
|---|---|
| **Recompute is real** | T-157 re-derives a day from punches + config + adjustments. With the decision living inside the row being recomputed, it would have to be preserved through its own overwrite |
| **Attribution is verifiable** | Every adjustment names the `sessions.id` it was made under. v1 takes the acting identity as a **client-supplied parameter** (landmine #17) — so *"who approved this"* is currently a value the browser chose |
| **A reversal is a row, not an erasure** | Changing a decision supersedes it. *"Who decided what, when, and who changed it"* stays answerable, which is the question a payroll dispute actually asks |

## Contract

### 1. `attendance_adjustments`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | |
| `orgId` / `storeId` / `employmentId` | `uuid not null` | |
| `shiftDay` | `date not null` | Adjustments attach to the **day**, not to a punch |
| `kind` | `text not null` CHECK | §2 |
| `payload` | see §2 | Typed columns per kind, not a JSON blob |
| `reason` | `text null` | Required for `void` and `half_day_override` |
| `decidedBySessionId` | `uuid not null` → `sessions` | ⛔ **From `resolveActor`, never a parameter** (§7.1) |
| `decidedByPersonId` | `uuid not null` → `persons` | Denormalised from the session **on purpose**: it is who decided, and it must not move if the session is later revoked |
| `supersededByAdjustmentId` | `uuid null` → self | |
| `createdAt` | | |

- `unique (employment_id, shift_day, kind) where superseded_by_adjustment_id is null` — **one live
  decision of each kind per day.**
- ⛔ **Append-only**, same trigger as `attendance_punches` (T-156 §4). A changed decision is a new row
  that supersedes the old one.
- `check (kind not in ('void','half_day_override') or reason is not null)`.

### 2. The five kinds

| Kind | Payload | What it decides | v1 |
|---|---|---|---|
| `start_anchor` | `chosen_anchor_minute integer not null` | The **Late / Next-in** call. Which allowed start the day is paid from | `setAttendancePayrollInModeAction` |
| `early_out_approved` | — | *"I sent them home early; pay them to the scheduled end"* | `setAttendanceEarlyOutApprovedAction` |
| `half_day_override` | `is_half_day boolean not null` | Force a half day on or off when the automatic rule is wrong | `setAttendanceHalfDayAction` |
| `verify` | — | Signed off as correct. **Locks the day for payroll** | `verifyAttendanceSessionAction` |
| `void` | — | The day is discarded (duplicate, erroneous) | `voidAttendanceSessionAction` |

⭐ **`start_anchor` stores the chosen *anchor*, not the mode string.** v1 stores `'late' | 'next_in'`
and re-derives the minute from it at every read. Storing the decided minute makes the decision
self-contained — and T-157's `resolveStartAnchor` already treats an exact allowed start as
authoritative and never second-guesses it, so a stored anchor lands on the `'exact'` branch by
construction.

### 3. ⛔ The C1 inverted-window guard

`workday.ts:126-165`. A `start_anchor` decision plus an `early_out_approved` can combine into a paid
window **whose end is before its start** — which *"would let the pairer silently swap in/out and
fabricate a fictitious shift."*

**Enforced at creation**, because that is where the combination is formed: creating an adjustment
that would invert the window against the day's other live adjustments is **refused**, with the two
conflicting decisions named in the message. Defence in depth, so T-157 also clamps and raises an
anomaly rather than trusting this gate — bible §15.11.

### 4. ⭐ The materiality gate — do not ask a question that cannot change money

`isStartDecisionMaterial` (`shift-boundaries.ts:492-507`) exists because, **measured at one branch,
52% of all flagged sessions were already full shifts regardless of which start they were anchored
to.** Asking anyway produced a wall of meaningless prompts.

```ts
isStartDecisionMaterial(day, config): boolean
```

True only when the two candidate anchors produce **different paid minutes, a different half-day
verdict, or different late minutes under a `latePolicy` that costs something.** The review queue
(T-166) surfaces only material days.

⭐ **This is an operational-load finding, not a technical one** (discovery 15 §8), and it survives
even though the computation around it changed. Keep it as a named, tested function rather than a
filter inlined into a screen — a rule buried in a query is a rule the next screen forgets.

### 5. Authorization — and the delegation v1 has that the phase list does not name

- All five kinds require **`manage_attendance`**, which already exists (`admin ✅ · manager ✅ ·
  staff ✗`). **No new capability.**
- ⛔ **Self-adjudication is blocked.** A person may not create an adjustment on their own employment.
  Admins are exempt, **explicitly and auditably** (bible §7 rule 6).
- ⭐ **The attendance-manager delegation.** v1 lets an admin deputize a trusted non-manager (a senior
  cashier) to resolve flagged attendance *without promoting them to `manager`* —
  `localUser.attendanceManager`, gated at `attendance-access.ts:9-26`. Discovery 15 §1 flags it:
  *"not itself named in the phase description — confirm it survives."*

  **It survives, and it needs no new mechanism:** T-121 built `person_grants` for exactly this —
  *"an admin handing one extra capability to one person without changing their role."* A deputized
  cashier gets a `manage_attendance` grant row. ⭐ **A v1 special case becomes an instance of an
  existing general one**, which is the four-verbs *correct* outcome rather than a port.

### 6. Service layer

```ts
recordAdjustment(tx, actor, input): Promise<AttendanceAdjustment>  // supersedes, guards C1, re-adjudicates
listAdjustments(tx, { employmentId, shiftDay }): Promise<AttendanceAdjustment[]>
```

`recordAdjustment` inserts and calls `adjudicateDay` **in the same transaction**, so the day and its
decisions can never be seen disagreeing. ⛔ It **refuses on a frozen day** (T-157 §5 rule 2) —
adjusting a day a pay run has consumed is the retroactive-pay move the freeze exists to prevent.

### 7. Verify and void

- `verify` moves the day to `verified`. ⚠️ **A day with an anomaly cannot be verified** until the
  anomaly is addressed by another adjustment or a corrective punch — otherwise "verified" means only
  that somebody clicked.
- `void` moves it to `voided`. A voided day contributes nothing to payroll and its punches remain
  (T-156 is append-only; the day is voided, never the evidence).
- Both write an audit row (bible §7 rule 7), as does every kind.

## Invariants

1. One live adjustment per `(employment, shiftDay, kind)`; a second supersedes rather than duplicating.
2. `UPDATE`/`DELETE` refused on every row.
3. `decidedByPersonId` comes from the session, and no service function accepts an actor parameter.
4. A person cannot adjust their own employment; an admin can, and it is audited.
5. A `person_grants` row for `manage_attendance` lets a non-manager adjudicate — and **only** adjudicate.
6. C1: an inverting combination is refused at creation, and clamped with an anomaly if it ever arrives.
7. A day is re-adjudicated in the same transaction as the adjustment.
8. Adjusting a frozen day is refused.
9. A day with an unaddressed anomaly cannot be verified.
10. `isStartDecisionMaterial` is false when both anchors pay identically — asserted with the
    real-shaped case from v1's own comment.
11. A voided day contributes zero payable minutes and its punches are untouched.
12. Superseding a `start_anchor` re-adjudicates to the new anchor, not the old one.

## Tests

Integration on **`shareat_test_b`**. Fixtures: each of the five kinds · superseding one · self-adjudication
(**refused**) · admin self-adjudication (**allowed and audited**) · a granted non-manager (**allowed**)
· a staff-role person (**refused**) · the C1 inverting pair (**refused**) · verify with an outstanding
anomaly (**refused**) · adjusting a frozen day (**refused**) · a material and a non-material day ·
a superseded anchor changing the day's paid minutes.

## Out of scope

**The review UI** — T-166, which has both a queue and a roster to show · **Overtime approval** —
Phase 5, and its self-approval block is a different control on a different object (discovery 15 §4:
*"reject/void are deliberately left open since they only move pay DOWN"* — do not generalise the two
into one guard, per "Intent worth preserving" #5) · **Filing an infraction from a late day** —
Phase 7 · **Any pay consequence** — Phase 5.

## Done when

- [ ] All twelve invariants pass on `shareat_test_b`.
- [ ] Migration hand-written, **0070–0089**, journal row `previous.when + 86400000`.
- [ ] Classified in `cutover/classification.ts` **and** `rls/registry.ts` — ⭐ **own first commit**.
- [ ] The attendance-manager delegation is proven by a test, not assumed from T-121's existence.
- [ ] `npm run typecheck` · `npm test` · `npm run test:integration` green, real output reported.
