# T-225 — The half day that was nearly a full day

> **Status**: ✅ **BUILT 2026-09-06** — specced and built the same day, on Ian's call.
>
> ⛔ **This changes NO arithmetic.** Not one credited minute moves, and that is asserted across all
> 346 corpus sessions rather than claimed. It raises an anomaly on a narrow band of days so a manager
> is told which ones to look at, and uses the override that already existed.
>
> ⚠️ **A second, pre-existing defect was found while surfacing it** — see §3.3. The review screen
> claimed every anomaly blocks verification; that was already untrue before this task.

## 1. Why this exists

`lipa-0359` (2026-09-04) prompted it. Someone clocked in at **06:40:43**, out at **15:06:27**, and
was credited **8 hours** against a 9-hour requirement. Because the day was short,
`shortShiftHalfDayOt` collapsed it to a **5-hour half day** with the remaining **3 hours** raised as
pending overtime.

⚠️ **Calling an 8-hour day a "half day" is plainly wrong**, and nothing told anybody to look at it.

Ian, 2026-09-06: *"for the allowed undertime you are right to point that out … im thinking of
flagging ins like this to confirm if indeed they are halfday or the undertime is permitted."*

## 2. ⭐ What the data said, and how it changed the answer

**Flagging every short day would have been a rubber stamp**, and a rubber-stamped queue is worse
than a rule because it launders a guess as a decision. Measured over the 346 golden-corpus sessions
in the current anchor era:

| Outcome | Sessions |
|---|---|
| Full day (≥ required) | 271 |
| **Collapsed to a half day** | **64** — 18.5%, ~1 in 5 |
| No day at all (under the half day) | 8 |

⭐ **But the rule is right almost every time.** Those 64, by how much of the requirement they worked:

| Worked | Sessions |
|---|---|
| **50–59%** | **45** ← genuinely half days |
| 60–69% | 9 |
| 70–79% | 2 |
| 80–89% | 3 |
| 90–99% | 5 |

The median shortfall is **four hours**. So the collapse is correct for the overwhelming majority and
the problem is a thin tail — which means the flag must be **narrow**, not "every short day".

## 3. Contract — the rule, and why it needs no new number

> A half day is **doubtful** when the day worked **more than the midpoint between the half day and
> the requirement**.

```
midpoint = (policy.halfDayMinutes + required) / 2
doubtful = isHalfDay && workedBeforeCollapse > midpoint
```

⭐ **It configures itself from each store's own settings** — 7h at Lipa (between 5h and 9h), 7.5h at
Malvar (between 5h and 10h) — so it cannot drift when a store is retuned, and there is no magic
constant for a later reader to wonder about. Below the midpoint the day is closer to a half day than
to a full one and "half day" is a fair description; above it, it is not.

**Population: 8 of 346 sessions** — about one a week across two stores, every one of them at
**80–90%** of a full day:

```
lipa-0359    8.00h of 9h  (89%)      malvar-0051  8.00h of 10h (80%)
lipa-0439    8.00h of 9h  (89%)      malvar-0083  9.00h of 10h (90%)
malvar-0015  9.00h of 10h (90%)      malvar-0095  9.00h of 10h (90%)
malvar-0037  9.00h of 10h (90%)      malvar-0124  9.00h of 10h (90%)
```

### 3.1 A new `Anomaly`: `half_day_near_full`

Named for the **condition**, not the remedy, matching every existing member (`missing_in`,
`start_not_allowed`, `implausible_span`). ⛔ Deliberately not `undertime_permitted` or
`needs_approval` — the system does not know whether the undertime was permitted, and a name that
presumes the answer is the bug this task exists to avoid.

### 3.2 ⛔ The default does not change, and that is the point

The day still credits the half day. **The system genuinely does not know whether the undertime was
permitted** — that is the entire premise — so the conservative answer stands until a named human
overrides it.

⭐ **The override already exists and is already honoured**: `adjustments.halfDayOverride`
(`compute-day.ts`), mapped from a manager adjustment in `adjudicate.ts`. **The missing piece was
never the mechanism — it was that nothing told the manager which days to look at.**

### 3.3 ⚠️ Found while wiring it — the screen claimed a rule the code does not have

`/attendance/[dayId]` told managers:

> *"A day with an unresolved anomaly cannot be verified — a sign-off that ignores them records an
> approval nobody actually made."*

⛔ **That was already false before this task.** `BLOCKING_ANOMALIES` in `adjudicate.ts` is an
explicit allowlist of eight, and `start_not_allowed` is deliberately **not** in it — blocking it
would hold a store's pay for DEF-087's stale grid, where it fires on a large share of Lipa's
sessions. So a day could carry an anomaly and verify perfectly well, while the screen said otherwise.

Prose claiming something the code does not do — the shape this project has now filed ten defects
about, found this time by adding a member to the very enum the sentence generalises over.

**Fixed here**: `isBlockingAnomaly()` is exported, blocking items render ⛔, advisory ones render ⚠️
with *"advisory, does not block sign-off"*, and the blocking sentence appears **only when something
actually blocks**. Anomaly codes also gained plain-language labels — a manager reading
`half_day_near_full` learns nothing, and the point of surfacing it is that they act on it.

## 4. ⚠️ Open question for Ian — what "permitted" should PAY

### 4.1 ⛔ First, the fact that makes this urgent — payroll pays in DAY UNITS, not hours

`payroll/compute.ts` `unitsFor()` returns **0.5 for a half day, 1 for a full day**, and the hourly
equivalent is `dailyRate ÷ requiredHoursPerShift` with overtime at `× overtimeMultiplier` (1.25 at
Lipa). So for `lipa-0359`, against a daily rate **D**:

| Outcome | Pay |
|---|---|
| v1 (full day) | **1.00 D** |
| v2, pending OT **approved** | 0.5 D + 3h × (D/9) × 1.25 = **0.92 D** |
| ⛔ v2, **manager does nothing** | **0.50 D** |

⭐ **That bottom row is the real argument for this flag, and it is sharper than "the label is
wrong".** Pending overtime pays *nothing until decided*. So without something telling a manager to
look, **a person who worked 8 of 9 hours is paid half a day** — and the screen that would have shown
them the pending 2h sits behind a day nobody had a reason to open. The flag is what makes "someone
notices" actually happen.

⚠️ And approving the OT lands at **0.92 D for 89% of the hours** — proportionate. The system's
answer is already reasonable *once a human acts*; the defect was that nothing prompted the action.

### 4.2 The question itself

Flagging is settled. What an override should then credit is not, and must not be decided by default:

- **Recommendation: credit the time actually worked.** Permission excuses the absence; it does not
  manufacture the missing hour. In day-units terms that means approving the pending OT (0.92 D)
  rather than flipping the day to a full unit.
- The alternative is to flip `halfDayOverride` to false, paying a **full day (1.00 D) for 8 hours**.
  ⚠️ That is what v1 effectively did — and v1 **paid more than the person was present in 58 of 346
  sessions**, so inheriting it would be inheriting a defect rather than choosing a policy.

**Out of scope until answered.** This task ships the flag; the override's pay semantics are untouched.

## 5. Scope

```
packages/domain/src/attendance/compute-day.ts        the Anomaly value + the midpoint test
packages/domain/src/attendance/compute-day.test.ts   unit tests, watched fail first
tests/golden/attendance-adjudication.test.ts         pins the population at 8 on real data
apps/erp/src/app/attendance/**                       surface it where anomalies already render
```

## 6. Invariants

1. **No credited minute changes.** `computedMinutes` and `pendingOtMinutes` are byte-identical
   before and after this task, for every specimen in the corpus.
2. The anomaly is raised **only** when the day was collapsed to a half day.
3. It is **not** raised at or below the midpoint — a 5h day against a 9h requirement stays silent.
4. It is raised **above** the midpoint, at any store, using that store's own numbers.
5. The existing `halfDayOverride` continues to work and is unaffected.

## 7. Tests

- Unit, watched fail first: a day just above the midpoint raises it; one just below does not; a full
  day does not; a sub-half-day (no day at all) does not.
- ⭐ **A golden-corpus assertion pinning the population at exactly 8**, and asserting invariant 1 by
  comparing every session's credited minutes against the pre-change engine. A flag that quietly moved
  pay would be far worse than no flag.
- The boundary is exercised on **both** store shapes (9h and 10h requirements), because a single
  hard-coded midpoint would pass a one-store test and fail the other.

## Done when

typecheck clean · every test watched fail first · `npm test` green · `npm run test:integration` green
· `npm run build` exit 0 with the dev server stopped · smoketested on 9008 that a flagged day renders
its anomaly · **the corpus population asserted at 8, and invariant 1 proved rather than claimed** ·
self-reviewed · committed with a message explaining *why* · `FOR IAN` naming §4's open question.
