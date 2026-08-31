# T-194 — A day that credits nothing must pay nothing

> **Status:** specced 2026-08-31 · fixes **DEF-111** · chosen by Ian from the item-1 assessment
> **Depends on:** T-189 (`computePay`, `payableDays`, the freeze), T-157 (`computeDay`'s three bands)
> **Blocks:** nothing. ⭐ **Deliberately ahead of T-195** — this is wrong money going out *today*,
> in both `shortShiftHalfDayOt` states, and it does not need the review screen to be correct.
> **Evidence:** the live golden corpus, 560 sessions, 3 stores, 2026-08-01→29, replayed through
> `computeDay` → `computePay` on 2026-08-31.

---

## 1. ⛔ The defect, in one line

`unitsFor` reads **only `isHalfDay`**, so a day the attendance engine credited **zero minutes** is
paid a **full daily rate**.

```ts
// packages/domain/src/payroll/compute.ts:133
function unitsFor(day: DayInput): number {
  return day.isHalfDay ? 0.5 : 1;   // ⛔ a zero-minute day is "not a half day", so it is a FULL one
}
```

`compute-day.ts:557-576` could not be more explicit about what it intends:

```
// ⛔ Below the half-day bar there is NO DAY. Ian, 2026-08-29 — see MINIMUM_CREDITABLE_MINUTES.
const worked = computedMinutes;
computedMinutes = 0;
```

It sets the minutes to zero, leaves `isHalfDay` **false**, and routes the time to
`pendingOtMinutes`. `resolveStatus` then marks the day `computed` — which is in
`PAYABLE_DAY_STATUSES` — so the day reaches the run, and the run pays it in full.

### 1.1 Measured, not reasoned

Replaying the live corpus through v2's own code:

```
FLAG OFF: 560 sessions → 560.0 days paid → zeroMinuteDays = 31
FLAG ON:  560 sessions → 508.5 days paid → zeroMinuteDays = 31
```

⛔ **31 of 560 sessions (5.5%) credit zero minutes and every one is paid a whole day.** Three of
them are sessions of **under five minutes** — a tap in and a tap out. At an illustrative ₱500 daily
rate that is ₱15,500 a month across three stores.

⚠️ **The flag does not touch this branch.** `shortShiftHalfDayOt` gates the *5h-to-required* band;
this is the band *below* 5h, which is unconditional. Fixing this is correct whatever Ian decides
about the flag, which is why it goes first.

### 1.2 ⭐ It is DEF-088 defeated one layer downstream

DEF-088 is the anti-fraud rule: *credit far exceeding presence is never auto-payable.* T-157
implemented it — `MINIMUM_CREDITABLE_MINUTES = 60`, `MAX_CREDIT_TO_PRESENCE_RATIO = 2`, three
bands, and a `claimedMinutes > 0` guard that raises `implausible_span`.

For a sub-five-minute session the claim is **zero**, so the guard is silent (correctly — there is
nothing being claimed), the day is `computed`, and payroll pays ₱500 for one minute of presence.
**Attendance closed the door; payroll left the window open.**

⭐ This is the **third** occurrence of the DEF-109 pattern in Phase 5 — *a comment addressed to a
future module is only as good as that module reading it*. The register now carries all three.

### 1.3 Why no test caught it

There is no test. `compute.test.ts` covers `daysWorked` for a full day, a half day, a mid-period
raise and an empty period — **the zero-minute day was never a case anyone wrote.** Unlike DEF-109,
no test asserts the wrong behaviour; there is simply nothing to correct, only something to add.

---

## 2. ⛔ The consequence that makes this more than a null-guard

Returning `0` units and letting the run proceed would **destroy the pending overtime**.

`postPayRun` freezes `slip.dayIds` — every day that entered the slip — and both `adjudicate.ts` and
`adjustments.ts` refuse to touch a frozen day. So a zero-minute day paid at ₱0 and frozen can
**never** have its overtime approved afterwards. The time would be silently gone, which is the
opposite of what the pending status exists to do.

⭐ **A zero-minute day with no overtime decision is a day nobody has settled**, and the codebase
already has the right shape for that: `needs_review`. `payableDays` excludes it and
`needsReviewCount` counts it, *"a run that silently skipped a day nobody had settled would look
identical to a run where nobody worked."* The same reasoning applies here word for word.

### 2.1 The three cases, decided

| The day | Basic | Overtime | Frozen? |
|---|---|---|---|
| `computedMinutes = 0`, **no** `overtime_approved` decision | — | — | ⛔ **held back.** Not paid, **not frozen**, counted and surfaced. Pays in a later run once a manager decides |
| `computedMinutes = 0`, **has** an `overtime_approved` decision | **0** units | approved minutes, at the OT rate | ✅ paid and frozen |
| `computedMinutes > 0` | unchanged (`0.5` / `1`) | unchanged | unchanged |

⭐ Row 2 is the design working as Ian specified it — *"1><5 hour record as unverified OT to be
accepted by manager"*. The person is paid for the stint through the overtime line and no basic day,
which is exactly the intent. It pays *more per hour* than basic because the OT multiplier applies;
that is a known consequence of Ian's model, not a defect.

⚠️ Row 1 is **held, not refused**. Nothing is lost — the day stays unfrozen and payable, and the
next run picks it up. That is the difference between deferring money and destroying it.

---

## 3. ⭐ Deliberately NOT in scope, each with a reason

| Not built | Why |
|---|---|
| ⛔ **A configurable half-day fraction** | I raised Frappe HR's setting (*"if the value is set as 0.75, three-fourth salary"*) as the industry pattern, and on the evidence it is **gold-plating here**: v1 hardcodes 0.5, no store has ever wanted anything else, and the 0.5 is a *locked decision with a documented reason* (the 5h block is 4 work + 1 paid break against 9h's 8 + 1). Adding a knob nobody will turn is the exact scope creep the assessment skill exists to stop. **Revisit when one store asks** |
| ⛔ **Pro-rating basic pay to hours** | Forbidden by the locked v1 decision quoted in `compute.ts:125-131` — *"⛔ Do not 'correct' this back to hours"* — because it double-pays the break. The half day stays a fraction of the **daily rate**, never of the hours |
| ⛔ **Flag-off short-day behaviour** (5h–required) | ⚠️ **A named divergence, recorded not fixed.** v1 with the flag off *pro-rates to actual hours*; v2 with the flag off pays a **full day**. v2 matches neither v1's flag-off nor its flag-on. It is unreachable in practice — **all three live stores run the flag ON** — and changing it is a policy decision that belongs with the flag itself, in T-195's wake. See §6 |
| ⛔ **Filtering in the SQL** | A day excluded by `payableDays` is invisible to the run and therefore never frozen *and* never counted. The hold must be explicit and surfaced, not a `where` clause. T-158: *"a rule buried in a query is a rule the next screen forgets"* |
| ⛔ **Any change to the freeze door** | Migration `0106` opened one narrow door for voiding a mis-posted run. This task needs no second door — it avoids the problem by not freezing an unsettled day in the first place |

---

## 4. The files you may touch

| File | Change |
|---|---|
| `packages/domain/src/payroll/compute.ts` | `unitsFor` returns `0` when `computedMinutes === 0`. **Defence in depth** — §5 keeps such days out of the run, and this makes the arithmetic right even if one ever arrives |
| `packages/domain/src/payroll/index.ts` | `previewPayRun`: partition the zero-minute days; hold the undecided ones; add `heldZeroCreditDays` to `PayRunPreview`. `postPayRun` inherits the partition, so `slip.dayIds` never contains a held day |
| `packages/domain/src/payroll/compute.test.ts` | The unit cases — §7 |
| `packages/domain/tests/integration/payroll.test.ts` | The end-to-end cases — §7 |
| `apps/erp/src/app/payroll/page.tsx` | One banner beside the existing `unapprovedOtMinutes` one |
| `apps/erp/src/app/payroll/lib.ts` | Only if the preview type is re-declared there |

⛔ **No migration.** No schema changes. Nothing in `packages/db/schema/`.

---

## 5. Implementation notes

`unitsFor` becomes:

```ts
function unitsFor(day: DayInput): number {
  // ⛔ DEF-111. `isHalfDay` is FALSE on a zero-credit day — the attendance engine says "there is
  // NO DAY" by zeroing the minutes, not by setting the half-day flag — so reading the flag alone
  // pays a full daily rate for a five-minute session. Never infer the day from the flag.
  if (day.computedMinutes <= 0) return 0;
  return day.isHalfDay ? 0.5 : 1;
}
```

In `previewPayRun`, partition **before** the per-employment loop, using the row the query already
returns (`approvedOtMinutes` is `null` when nobody has decided):

- **held** ⇐ `computedMinutes === 0 && approvedOtMinutes === null`
- everything else flows on unchanged.

⚠️ `approvedOtMinutes === 0` is a **decision of zero** and is *not* held — a manager who looked at
a four-hour stint and approved nothing has settled that day. The run pays it ₱0 and freezes it.
That distinction is already load-bearing in DEF-109's fix; do not collapse it to a falsy check.

---

## 6. ⚠️ For the record — the divergence this task does NOT close

| | short day, 5h against a 9h requirement |
|---|---|
| v1, flag **on** | half day + remainder as pending OT |
| v1, flag **off** | **pro-rated to actual hours** |
| v2, flag **on** | half day + remainder as pending OT ✅ matches |
| v2, flag **off** | ⚠️ **a full day** — matches neither |

All three operating stores run the flag **on**, so v2's flag-off branch is unreachable in practice
today. It is recorded here so that whoever turns the flag *off* for a store finds this paragraph
before they find the payroll.

---

## 7. Tests — written first, and failing for the right reason

**Unit** (`compute.test.ts`):

1. ⭐ A zero-minute day with `isHalfDay: false` contributes **0** to `daysWorked` and **₱0** basic.
   *This is the DEF-111 case and must fail before the fix.*
2. A zero-minute day **with** approved overtime pays the overtime and **no** basic.
3. A half day is still `0.5` — the locked decision is untouched.
4. A full day is still `1`.
5. ⚠️ A **one-minute** day is still `1` — **not** `0`. ⛔ *Corrected while writing the tests: the
   first draft of this section said `0`, which `<= 0` cannot produce and which would have been a
   second copy of `MINIMUM_CREDITABLE_MINUTES` living in payroll.* Attendance owns the bands;
   payroll only refuses to invent a day out of nothing. The test asserts this so nobody "tidies"
   the guard into a threshold later.

**Integration** (`payroll.test.ts`, real Postgres):

6. ⭐ A run over a period containing one zero-credit day with no OT decision: the day is **not**
   on the payslip, **not** frozen (`frozen_at is null` asserted after the post), and
   `heldZeroCreditDays === 1`.
7. The **same day**, after an `overtime_approved` adjustment, is paid by the **next** run and
   frozen by it. *This is the one that proves nothing was destroyed.*
8. A zero-credit day with `approvedOtMinutes = 0` (a decision of zero) **is** paid at ₱0 and
   **is** frozen — it is settled, not undecided.
9. The trial balance still ties after a run containing a held day.

---

## 8. Done when

- [ ] The five unit cases and four integration cases pass, and cases 1 and 6 were seen **failing
      first** for the stated reason.
- [ ] `npm run typecheck` — 0 errors.
- [ ] `npm run test` — 856 + new, no regressions.
- [ ] `npm run test:integration` — 1731 + new, against real Postgres.
- [ ] ⭐ **Smoketested on 9008 in a browser**: a period containing a zero-credit day previews with
      the banner visible, and the figures move. A green build is blind to whether anyone can see it.
- [ ] `npm run build` clean, **dev server stopped first**.
- [ ] Self-reviewed line by line.
- [ ] `DEF-111` marked fixed in the register, with the closing test named.
- [ ] `docs/ROADMAP.html` updated.
