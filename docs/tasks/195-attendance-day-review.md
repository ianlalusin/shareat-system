# T-195 — The attendance day review screen

> **Status:** ✅ **BUILT AND COMMITTED 2026-08-31** (`d448402`). DEF-113 fixed, and DEF-115 found by building it. `recordAdjustment` had no caller outside tests; the review screen was overwritten by a task-number collision.
> Specced 2026-08-31 · fixes **DEF-113** · chosen by Ian from the item-1 assessment
> **⭐ This task has been promised four times under a number that no longer means it.** T-154,
> T-156, T-157 and T-158 all name **T-166** as "the review screen"; the inventory lane shipped
> **T-166 as *Deliveries and receiving***. The screen was not descoped — it was **overwritten**.
> This spec claims **T-195** for it. Every "see T-166" in an attendance spec means this document.
> **Depends on:** T-157 (`adjudicateRange`), T-158 (`recordAdjustment`, six kinds), T-138
> (`resolveActor` → `sessionId`), T-121 (`manage_attendance`)
> **Blocks:** the `shortShiftHalfDayOt` rollout (DEF-112), and every held day T-194 creates

---

## 1. ⛔ The gap, stated as a fact about the running app

**`recordAdjustment` has no caller outside tests.**

```
$ grep -rn "recordAdjustment" --include=*.ts --include=*.tsx . | grep -v node_modules | grep -v tests
packages/domain/src/attendance/adjustments.ts:45:export async function recordAdjustment(
```

T-158 shipped six adjustment kinds, fully tested. `apps/erp` invokes none of them. There is no
attendance-day screen at all: `/attendance/lane` is the quarantine and health screen, `/clock` is
the punch surface. What that costs, all of it live today:

| Broken | Consequence |
|---|---|
| ⛔ **Overtime can never be approved** | `pendingOtMinutes` can never become money. The live corpus carries **469–513 hours a month** |
| ⛔ **A `needs_review` day can never be resolved** | `payableDays` excludes it *and* `resolveStatus` refuses to promote it on recompute. **Nothing will ever pay that day** |
| ⛔ **T-194's held days pile up** | A zero-credit day is held until somebody decides its overtime. Nobody can |
| ⚠️ No day can be `verified` | The stronger of the two payable statuses is unreachable |
| ⚠️ No half day can be overridden | `half_day_override` is dead |
| ⚠️ No start anchor or early-out can be decided | Ian's 2026-08-20 anchor rule is inert for corrections |

⛔ And `/payroll` already tells the manager to use a screen that does not exist:

```
apps/erp/src/app/payroll/page.tsx:217
  "approve it on the attendance day, then preview again"
```

---

## 2. The requirement is proven, and v1 shows its shape

v1's `operation/attendance/attendance-review-dialog.tsx` is in daily use. Read as a **requirement,
never as design** (§1.2b), it maps almost one-to-one onto v2's six kinds:

| v1 control | v2 adjustment kind |
|---|---|
| "Expected in" dropdown | `start_anchor` |
| "Expected out" dropdown | `early_out_approved` |
| **Verify** button | `verify` |
| **Void** button + reason picker | `void` |
| — | ⭐ `half_day_override` (v2 addition) |
| — | ⭐ `overtime_approved` (v2 addition, T-189e) |

⭐ **One piece of v1's design is worth duplicating verbatim**, and its own comment says why:

> *"The original clock-in is never changed. It is a label."*

The raw taps render **read-only**; the dropdowns state the *decision*, not a rewritten fact. That
is the same principle T-158 built the whole table on — decisions as attributed inputs, never
patches on an output — arrived at independently in both systems.

---

## 3. Scope — two screens, and what each is for

### 3.1 `/attendance` — the queue and the roster

Two lists on one route, because T-158 said *"it has both a queue and a roster to show"*.

**The queue comes first and is the point of the screen.** A day is in it when it is waiting on a
human:

1. `status = 'needs_review'` — nothing will ever pay this until somebody acts.
2. `pendingOtMinutes > 0` with **no live `overtime_approved`** — unpaid, and invisibly so.
3. ⭐ `computedMinutes = 0` with no live `overtime_approved` — T-194's **held** days.
4. `status = 'open'` — an in with no out; a shift still running, or a missed tap.

**The roster** is every day in the range for the store, so a manager can find a day that is not in
the queue. Filter by person and by date range; default range is the current payroll period, because
that is the question a manager actually has.

⚠️ **Each queue row must say WHY it is there.** A queue that shows a list without a reason is the
`needs_review` status all over again — visible, and uninterpretable.

### 3.2 `/attendance/[dayId]` — the decision surface

The house detail-page pattern (`mx-auto`, two columns on a wide screen, stacked on a phone).

**Left — the evidence, all read-only:**
- The raw punches with their times and asserted intent. ⛔ **Never editable.**
- `computeDay`'s `explain[]` lines, verbatim. ⭐ The engine already narrates every decision it
  made; showing that is most of the screen's value and costs nothing.
- The anomalies, and the day's status.

**Right — the decisions**, one control per kind, each showing the live decision if there is one:
- Start anchor · effective out · half-day override · **approved overtime** · verify · void.

⭐ **Every control shows what is live now**, because `recordAdjustment` supersedes rather than
adds, and a manager who cannot see the standing decision will make a second one by accident.

---

## 4. ⛔ Deliberately NOT in scope

| Not built | Why |
|---|---|
| ⛔ **Editing punches** | A day IS its punches. Corrections are adjustments, which is the entire architecture of T-158. The raw tap is a label |
| ⛔ **A missed-clock-out sweep** | Named in T-156 and T-157 as belonging with this screen. It is a **scheduled job**, not a screen, and it wants its own task and its own idempotency argument |
| ⛔ **Bulk approve** | ⚠️ Tempting and wrong for the first cut. Overtime approval is the gate that DEF-109 exists to protect; a "approve all" button on day one rebuilds the auto-pay it was written to stop. Revisit once someone has used the single-day path and can say what is tedious about it |
| ⛔ **Filing an infraction from a late day** | Phase 7, per T-158 |
| ⛔ **Any change to `recordAdjustment`** | It is built, tested and correct. This task is the caller it never had. ⚠️ **If it needs a change, that is a finding — report it, do not widen it here** |
| ⛔ **The `shortShiftHalfDayOt` flip** | Follows this, as a setting, with a settings screen. Not smuggled in |

---

## 5. The files you may touch

| File | Change |
|---|---|
| `packages/db/src/repo/attendance-days.ts` | A `reviewQueue` query and a `listDaysWithPeople` — the existing `listDays` returns rows with no person name |
| `packages/domain/src/attendance/index.ts` (or `review.ts`) | Read-side services: the queue, one day with its punches, explain, anomalies and live decisions |
| `apps/erp/src/app/attendance/page.tsx` · `lib.ts` · `actions.ts` | The queue + roster |
| `apps/erp/src/app/attendance/[dayId]/page.tsx` · `actions.ts` | The decision surface |
| `apps/erp/src/lib/nav.ts` (wherever the nav list lives) | ⚠️ **Add the link.** DEF-107 was two nav entries pointing at routes that did not exist; this is the inverse and just as invisible |
| `packages/domain/tests/integration/attendance-review.test.ts` | New |

⛔ **No migration.** No schema change. Every column this screen needs already exists.

---

## 6. ⚠️ Traps this task will hit

1. ⛔ **`recordAdjustment` re-adjudicates in the same transaction, and re-adjudication derives the
   day from PUNCHES.** A fixture that inserts `attendance_days` directly and then calls the service
   gets its day recomputed to zero. **Integration tests here must seed punches, not days** — the
   opposite of what `payroll.test.ts` does, and for a good reason in each case.
2. ⛔ **A frozen day must refuse every decision**, and the refusal must be *visible* on the screen,
   not an exception. A payroll run has already paid it.
3. ⚠️ **Self-adjudication is already blocked** in `recordAdjustment` (bible §7 rule 6). Do not
   add a second client-side copy — but **do** show why the control is disabled.
4. ⚠️ **`approvedOtMinutes` is capped at what was worked** by payroll, and `null` ≠ `0`. The screen
   must be able to express "approve zero", which is a decision, distinctly from "not decided".
5. ⚠️ **`${INPUT} w-24`** — the class-string trap from the handoff: `w-full` and `w-24` in one
   string, `w-full` wins, the form stacks full-width and every test stays green. **Tests assert
   props, never geometry.** This screen must be looked at, not just built.
6. ⚠️ Ian's standing rule: **phone portrait is the default canvas**, touch-first, no hover-only
   affordances. A manager uses this on a tablet on the floor, not at a desk.

---

## 7. Tests

**Integration** (real Postgres, punches seeded not days):

1. The queue contains a `needs_review` day, and says why.
2. The queue contains a day with unapproved overtime, and says why.
3. ⭐ The queue contains a T-194 **held** zero-credit day, and says why.
4. A day with nothing outstanding is **not** in the queue but **is** in the roster.
5. ⭐ Approving overtime through the action makes the day payable, and `previewPayRun` pays it —
   *the end-to-end proof that DEF-113 is closed.*
6. ⭐ Verifying a `needs_review` day makes it payable — *nothing else in the system can do this.*
7. ⛔ A frozen day refuses every kind, and the screen is told why rather than throwing.
8. ⛔ A person cannot decide their own day (the §7 rule 6 block fires through the action).
9. A second decision of the same kind supersedes the first; the day reflects the second only.

**Browser** — ⭐ not optional, and the point of the task:

10. The queue renders with rows and reasons at **phone width**.
11. A decision made in the browser changes the day, and `/payroll` then pays it.

---

## 8. Done when

- [x] All nine integration cases pass, seeded from punches. **12 written, all green.**
- [x] `npm run typecheck` 0 · `npm run test` 861 · `npm run test:integration` **1751** — all green.
- [x] ⭐ **Smoketested on 9008 in a browser.** The queue rendered T-194's held day carrying **both**
      its reasons; an overtime approval was recorded through the real action; and a **void moved a
      day to `voided`** — the first time either was possible from the running app.
      ⚠️ **Phone width NOT visually confirmed** — the browser harness would not resize the viewport,
      so this is reported as unverified rather than claimed. Desktop verified. The layout uses the
      house responsive pattern (`lg:grid-cols-2`, `overflow-x-auto`, `flex-wrap`) but has not been
      *seen* narrow.
- [x] `npm run build` clean, dev server stopped first; `/attendance` and `/attendance/[dayId]` both
      registered as dynamic routes.
- [x] Self-reviewed line by line.
- [x] **DEF-113 marked fixed**, closing tests named.
- [x] ⛔ **DEF-115 found and fixed while building this** — see §9. It was worse than the gap this
      task was written to close.
- [x] The stale "T-166" references corrected across `docs/`.
- [x] `docs/ROADMAP.html` updated.

---

## 9. ⛔ What building this found — DEF-115

The spec said (§4): *"⛔ Any change to `recordAdjustment` — it is built, tested and correct. If it
needs a change, that is a finding — report it, do not widen it here."*

**It needed a change, and the finding is the most serious defect of the day.**

`recordAdjustment` accepted `kind: 'void'`, demanded a reason, wrote the audit row — and **nothing
anywhere set `attendance_days.status`**. The day stayed `computed`, which is in
`PAYABLE_DAY_STATUSES`, so **a manager could void a day and payroll would pay it in full**. The
same hole inverted for `verify`: `verified` was unreachable, so a `needs_review` day could never be
rescued by anything at all.

⚠️ T-158 §7 promises both outcomes in as many words, and its invariant 11 is *titled* "a voided day
contributes nothing". ⭐ **The cause was the test**: `resolveStatus` read `if (previous ===
'voided') return previous` — a status it could preserve but never produce — and the invariant-11
test asserted only that the adjustment row was written and the punches survived. *The half of the
invariant that involved money lived in the test's name and not in its body.*

**Fixed** by making the decision an input (`DayAdjustments.managerDecision`), which is the
architecture T-158 rests on everywhere else. ⚠️ And a second-order trap caught in the same pass:
`adjudicateRange` — the sweep — calls `adjudicateDay` **without** adjustments, so driving status
from them would have let a sweep **un-void** a discarded day. `adjudicateDay` now loads the live
decisions itself; the parameter survives only as an override, and forgetting it is harmless
instead of destructive.

⛔ **Fourth occurrence of the DEF-109 family** (109, 111, 113, 115): a decision recorded in one
place that the consuming layer never reflects.
