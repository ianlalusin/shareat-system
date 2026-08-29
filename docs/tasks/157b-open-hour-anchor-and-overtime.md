# T-157b — The open-hour anchor, and overtime that is actually paid

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> `/research-evaluate-propose` pass Ian requested. **Both open questions answered by Ian:**
> *"1 nearest hour, 2. 25, for half 50 for whole"*.
> **Supersedes** part of T-157: the span-based Tier 1 / Tier 2 `resolveStartAnchor` is **replaced**.
> **Depends on:** T-155 (config), T-156 (punches), T-157 (the engine and `attendance_days`).
> **Blocks:** Phase 5 — payroll multiplies this task's output by a rate.

## Why this exists, and it is not a refinement

⛔ **v1's attendance has never paid anybody.** Counted live on 2026-08-29 across all four operating
stores:

| v1 collection | Documents, ever |
|---|---|
| `attendanceSessions` | 624 (one month) |
| `overtimeRecords` | 136 |
| `absenteeRecords` | 11 |
| **`payrollRuns`** · **`payrollStaffPayouts`** · **`payroll`** | **0** |

Staff clock in daily, sessions compute, overtime is filed — and **not one peso has ever been paid
from any of it.** Only 35 of 550 sessions were ever verified (6%).

⭐ **This changes what v1 is evidence OF.** Bible §1.2b says read v1 as requirements *because staff
use it daily*. For the punch capture that holds. **For the adjudication rule it does not** — the
span-based Tier 1/Tier 2 anchor T-157 ported is a **failed attempt**, not proven practice, and Ian
names it as the reason the module was never adopted. It is replaced here rather than preserved.

## Goal

A clock-in resolves to the shift hour the staffer was **aiming for**, and time worked past that
shift's end becomes approval-gated overtime in half-hour steps.

## Scope — the exact files this task may touch

**Modify:**
- `packages/domain/src/attendance/compute-day.ts` — the anchor, the OT, the recorded facts
- `packages/domain/src/attendance/compute-day.test.ts`
- `packages/domain/src/attendance/adjudicate.ts` — carry the new fields through
- `packages/db/schema/attendance-days.ts` · `packages/db/src/repo/attendance-days.ts`
- `packages/db/schema/attendance-config.ts` · `packages/db/src/repo/attendance-config.ts`
- `tests/golden/attendance-adjudication.test.ts` — re-triage against the 550-session corpus
- `packages/domain/tests/integration/attendance-adjudication.test.ts`

**Create:** one migration in **0076–0089**.

**Out of bounds:** every other file. In particular `attendance_punches` does not change — the fact
is already right; only its interpretation moves.

## Contract

### 1. ⭐ The anchor: the NEAREST allowed hour

Replaces `resolveStartAnchor`'s Tier 1 / Tier 2 / Gate A / Gate B entirely.

```
d = distance in minutes from the clock-in to the nearest allowed start hour
if d <= anchorWindowMinutes  ->  anchor = that hour
else                         ->  anchor = the clock-in's own floored hour, mode 'unallowed',
                                 and raise the existing `start_not_allowed` anomaly
```

`mode` is `exact` when `d = 0`, `previous` when the punch is **after** the hour, `next` when it is
**before**.

⭐ **Ties go to the EARLIER hour.** A 13:30 punch against `[13, 14]` anchors at 13:00. This is not
arbitrary — it is the same principle Gate B already encoded and which survives its deletion:
*"ties go to the late reading… so the tie-break can never cost the staffer."* The earlier anchor
credits the time they were actually present; the later one would silently discard it.

**Worked, against Ian's own examples:**

| Clock-in | Nearest | `d` | Anchor | Late |
|---|---|---|---|---|
| 14:05 | 14:00 | 5 after | **14:00** | 5 min |
| 13:45 | 14:00 | 15 before | **14:00** | 0 |

### 2. `anchorWindowMinutes` — new config column, default **30**

⚠️ **On a full hourly grid this can never fire, and that is the point.** Measured over all 550 real
sessions: against an hourly grid **0% are more than 30 minutes from an allowed hour** — 30 is the
mathematical maximum when every hour is allowed. The window exists only to catch a **sparse or stale
grid**, and there it is a signal rather than a nuisance.

⛔ **It is already catching one.** Against Lipa's *stored* grid `[9,10,11,15,16,17,18]` — which has
no 12, 13 or 14, though Ian's model says those are allowed starts — **42% of Lipa's and 45% of
Malvar's clock-ins land more than 30 minutes out.** That is DEF-087's operational half showing up as
a number: the staff are not off-schedule, the **config is stale**. The anomaly is advisory, not
blocking, precisely so this surfaces as "fix the config" rather than blocking half a store's pay.

### 3. Late-out overtime — the gap Ian's example 2 exposed

Today the engine caps at `requiredMinutes` and **discards** everything past it. Example 2
(`13:45 → 23:35`) therefore produces `pendingOtMinutes: 0` where Ian expects 30.

```
targetEnd = anchor + requiredMinutes
rawOt     = max(0, actualEnd - targetEnd)
pendingOtMinutes = roundOvertime(rawOt)
```

⛔ It is **`pending`**, never paid here. Ian: *"OT is pending paid when verified"*. The approval gate
is Phase 5; this task records the minutes and stops.

### 4. ⭐ `roundOvertime` — 25 earns the half, 50 earns the whole

Ian, verbatim: *"counted by .5 so .5 , 1 , 1.5 , 2 hour 35 =30 mins 45 = 30 mins 55 = 60 mins or 1
hour"*, then *"25, for half 50 for whole"*.

```
h = floor(M / 60)      r = M % 60
r >= 50  ->  (h + 1) * 60
r >= 25  ->  h * 60 + 30
otherwise->  h * 60
```

| Minutes | Credited | |
|---|---|---|
| 24 | 0 | below the first threshold |
| 25 | 30 | ⭐ the half threshold |
| 35 | 30 | Ian's example |
| 45 | 30 | Ian's example |
| 49 | 30 | |
| **50** | **60** | ⭐ the whole threshold — **v1 gives 30 here** |
| 55 | 60 | Ian's example |
| 85 | 90 | `h=1, r=25` |
| 110 | 120 | `h=1, r=50` |

⚠️ **This is NOT v1's rule.** `ot-rounding.ts` rounds up at 25 minutes into each *half-hour* block,
which yields **30** at 50 minutes. Ian's three examples fit both rules — they only diverge at 46–54
minutes — so the rule was ambiguous until he set the second threshold. v1's is also explicitly
*display-only* and never changed what was filed; this one is the filed figure.

### 5. Record the facts, do not destroy them

⛔ **Today the engine returns `lateMinutes` with `lateGraceMinutes` already subtracted**, so Ian's
*"5 mins late"* is stored as 0 at Lipa (whose grace is exactly 5). The grace belongs to **charging**,
not to **recording** — a manager asking "was he late?" gets a wrong answer, and Phase 5 cannot apply
a different policy to a number that has already been reduced.

| Column | Meaning |
|---|---|
| `lateMinutes` | **Raw.** `max(0, clockIn − anchor)`. Never grace-adjusted |
| `lateChargeableMinutes` | `max(0, lateMinutes − lateGraceMinutes)` — what a policy may charge |
| `earlyOutMinutes` | **New.** `max(0, targetEnd − actualEnd)`. Ian's *"4 mins early out"*, stored nowhere today |

### 6. What does NOT change

- **Whole-day credit still comes from the undertime grace.** Example 1 is a whole day because the
  9-minute shortfall (5 late + 4 early) is inside Lipa's 15-minute `undertimeGraceMinutes` — and
  that only works because of D5's real-minute pay. No new rule is needed; this is already correct.
- `halfDayHours`, `requiredHoursPerShift` (Ian's 9-vs-10 per store), the short-shift rule, night
  differential, breaks, the C1 guard, `implausible_span` (DEF-088) — all unchanged.

## Invariants

1. A punch exactly on an allowed hour anchors there, `mode: 'exact'`, `lateMinutes: 0`.
2. The anchor is always the nearest allowed hour within the window; ties resolve **earlier**.
3. Beyond the window the anchor is the punch's own hour and `start_not_allowed` is raised — and that
   anomaly is **advisory, never blocking**, so a stale grid cannot stop a store being paid.
4. `roundOvertime` matches the nine-row table in §4 exactly, including 50 → 60.
5. Overtime is always `pending`; nothing in this task pays it.
6. `lateMinutes` is raw; `lateChargeableMinutes` is the grace-adjusted one. Both stored.
7. `earlyOutMinutes` is recorded even when the day is credited in full.
8. Ian's two examples produce, exactly: 14:05→22:56 ⇒ anchor 14:00, 9h, late 5, earlyOut 4, OT 0 ·
   13:45→23:35 ⇒ anchor 14:00, 9h, late 0, earlyOut 0, OT 30.
9. Every duration remains an integer minute.
10. ⭐ **The golden master is re-triaged and every new divergence class is named.** 550 real sessions;
    a rule change of this size that moves nothing would be more suspicious than one that moves
    something.

## Tests

Unit on `computeDay` (`TZ`-pinned), integration on `adjudicateDay`, and the golden master.

⭐ **Ian's two examples become named acceptance tests, verbatim** — they are the clearest statement
of the requirement that exists, and they belong in the suite rather than in a chat log.

Required unit cases: the nine `roundOvertime` rows · a tie at :30 · a punch exactly on the hour · a
punch outside the window on a sparse grid · OT of 24 minutes (nothing) · OT spanning more than an
hour · late recorded raw while chargeable is graced · early-out recorded on a full day.

⚠️ **The property test for T-157's invariant 1 goes with the tiers it tested** — *"moving the anchor
forward never reduces guaranteed paid hours"* was a property of a two-candidate choice that no
longer exists. Replaced by invariants 1–3, which are properties of the new rule. **Deleting a
property test is worth a sentence in the report, not a silent removal.**

## Out of scope — each with its reason

**Per-person schedules** — proposed and rejected by Ian 2026-08-04; nothing here reopens it, and the
allowed-hour grid *is* the schedule · **OT approval and payment** — Phase 5 · **Break-time OT** — no
evidence of the need; 1 break log exists in all of v1 · **Changing `lateGraceMinutes` semantics for
charging** — only the *recording* changes · **Fixing Lipa's and Malvar's stored grids** — that is
operational data entry (DEF-087) and Ian's, not a code change · **Fixing v1** — the ₱ leak DEF-088
describes is live in a read-only repo.

## Done when

- [ ] All ten invariants pass; Ian's two examples are named tests and green.
- [ ] Migration hand-written in **0076–0089**, journalled `previous.when + 86400000`.
- [ ] `anchorWindowMinutes`, `lateChargeableMinutes`, `earlyOutMinutes` added; registries untouched
      (no new tables, so no classification or RLS change).
- [ ] Golden master re-triaged over 550 sessions, every class named, **zero untriaged**.
- [ ] ⚠️ **Any session where v2 now pays LESS than v1 is reported to Ian by name**, as before. That
      is the one direction that must not pass on my judgement.
- [ ] `typecheck` · `npm test` · `npm run test:integration` green, real output reported.
