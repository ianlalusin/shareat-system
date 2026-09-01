# T-191 — 13th-month pay

> **Status:** ✅ **BUILT AND COMMITTED 2026-09-01** (`6a526cf`). Migration `0115`. Smoketested live
> end-to-end (preview → post → void → repayable). ⚠️ **Amended same day by T-192** (`038590f`):
> `preview13thMonthRun` now excludes an employment with a posted separation for the year — see
> `docs/tasks/192-separation-final-pay-clearance.md` §2.3. Handoff item 3, phase-5-payroll.md's
> next slice after T-189. Assessed via `/research-evaluate-propose` first.
> **Depends on:** T-189 (`pay_rates`/`pay_runs`/`payslips`, `postEntry`, `outstandingAdvance`,
> `advanceToRecover` — all reused, none modified). Bible row 90 (confirmed ADD). `6140` provisioned
> in Phase 1, unused since.

---

## 1. Assessment

**Verdict: build it — a genuine ADD, and most of the hard part is already paid for by T-189.**

**Stated reason holds.** Bible row 90: *"Neither exists in the legacy system... both statutory or
near-statutory in PH."* Confirmed by search: v1's source tree has **zero** matches for
`13th`/`thirteenth` outside one AI-generated manual page (`manual-content.generated.ts`) that
references a "13th-month estimate" hint with **no corresponding code anywhere** — a documentation
hallucination, not a feature, logged below. v1 genuinely never built this.

**What already exists, here:** `payslips.basicPay` is *already* stored separately from
`otPay`/`nightDiffPay`/`holidayPay` (T-189's `payslips_gross_identity_check`), which is **exactly**
DOLE's statutory basis for 13th-month pay — "basic salary actually earned," excluding overtime,
premiums and allowances. Absences and short shifts already reduce `basicPay` naturally, because it
is *derived from actual attendance*, not an annualized full-year salary. **The entire proration
problem PD 851 creates is already solved by T-189's existing compute path.** T-191 is therefore not
a new payroll engine — it is *sum what T-189 already posted correctly, divide by 12, pay it out*.

**Industry / legal basis** (Presidential Decree 851, DOLE):

> 13th-month pay = total basic salary actually earned during the calendar year ÷ 12. Payable to
> every rank-and-file employee who worked ≥1 month, whether still employed or separated. Due on or
> before 24 December. Excludes overtime, holiday pay, allowances not integrated into basic salary.

Confirmed via web search (Omni HR, KAMI Workforce, Respicio, DOLE-cited sources) — the formula
matches what `basicPay` already represents column-for-column.

**Open source:** nothing to adopt. This is six lines of aggregation SQL plus a posting call this
codebase already knows how to make; a payroll library would be more integration surface than the
feature itself.

**⛔ A finding that reshapes WHEN this becomes load-bearing, not WHETHER to build it.** ADR-007:
v2 runs as a **pilot** Oct–Dec 2026, then every operational table — `pay_runs`/`payslips` included,
no per-row flag — is **purged** on 1 Jan 2027. ADR-005: 2026 P&L is "legacy-basis and unaudited,
never loaded as real"; v2 is not system-of-record until 2027-01-01. **So calendar-2026's real
13th-month payout cannot be computed from v2 — v2 will have at most three months (Oct–Dec) of
posted payslips for 2026, not the full year, and that data is itself pilot data due to be purged.**
2026's actual payout has to happen outside v2 (v1, or manually), the same way 2026's P&L does.
T-191 must be built **correct for a full calendar year of v2-native data** — which first genuinely
matters for **calendar-year 2027**, due 24 Dec 2027, by which point v2 has been system-of-record
for the whole year. This is a scope note, not a blocker: nothing here needs a partial-year
workaround, because partial-year 2026 was never going to be v2's job. **Flagged to Ian — see §5.**

**Effort against use:** one pair of tables (mirroring `pay_runs`/`payslips`, simpler — no
attendance/rate-per-day fields), two repo queries, two domain functions (preview, post; void
follows the same pattern as `voidPayRun`), one UI page. Real use: once a year, but a **statutory**
once-a-year with a real penalty for missing it (DOLE inspection, employee complaints) — the
"expected utilisation" question industry guidance answers for us: it must exist, correctly, by
the time it is needed, not be judged on frequency the way a settings screen is.

---

## 2. Design

### 2.1 Why NOT `pay_runs` / `payslips`

Reuse was the first instinct and it does not fit, for reasons worth stating rather than
discovering mid-build:

- `pay_runs`' overlap guard is a GiST **EXCLUDE on date range** — built to stop two regular
  periods double-paying the same attendance days. A 13th-month "period" (the whole calendar year)
  would nest inside every regular period already posted for that year, tripping a guard that
  exists to catch a completely different mistake.
- `payslips` requires a `pay_rate_id` FK and carries `daysWorked`/`minutesWorked`/OT/ND/holiday
  minutes — none of which a 13th-month payout has an honest answer for. It is not computed from
  one rate × days; it is a sum across however many rates were in force across the year.
- Forcing the fit would be the exact landmine the bible names repeatedly: a table bent to a shape
  it was not built for, with fields set to fake values to satisfy CHECKs that mean something real
  for regular payroll and nothing for this.

A **separate, smaller pair** — `thirteenth_month_runs` / `thirteenth_month_payouts` — mirrors the
posting *pattern* (run → payout → journal entry, one row per employment) without inheriting fields
that do not apply.

### 2.2 Schema

```
thirteenth_month_runs
  id, org_id, store_id, year (integer), status (draft|posted|voided),
  money_account_id, posted_at, posted_by, voided_at, voided_by, void_reason,
  notes, created_by, created_at

  unique (store_id, year) WHERE status = 'posted'   -- one posted run per store per year;
                                                      -- a voided one frees the year to re-run,
                                                      -- same shape as pay_runs allowing a re-run
                                                      -- after void.
  check year between 2020 and 2100                   -- sanity bound, not a business rule

thirteenth_month_payouts
  id, run_id, org_id, employment_id, person_id,
  basic_pay_earned (numeric)   -- the sum this was computed from, kept for audit
  gross_pay (numeric)          -- basic_pay_earned / 12
  advance_recovered (numeric) default 0
  net_pay (numeric)
  journal_entry_id (uuid, nullable)
  created_at

  unique (run_id, employment_id)
  check gross_pay >= 0, net_pay >= 0, net_pay = gross_pay - advance_recovered,
  check advance_recovered <= gross_pay
```

No `pay_rate_id`, no attendance minutes — there is nothing here that pretends to be a rate × days
computation.

### 2.3 Domain — `packages/domain/src/payroll/thirteenth-month.ts`

`THIRTEENTH_MONTH_ACCOUNT = '6140'` alongside the existing `SALARIES_ACCOUNT` /
`PAYROLL_ADVANCE_ACCOUNT` constants.

- **`basicPayEarnedInYear(tx, orgId, employmentId, year)`** (new repo query) — sums
  `payslips.basic_pay` joined to `pay_runs` where `pay_runs.status = 'posted'` and
  `pay_runs.period_end` falls within `[year-01-01, year-12-31]`. Voided runs excluded — a voided
  payslip's basic pay never actually happened economically.
- **`preview13thMonthRun(tx, actor, { storeId, year })`** — for every employment at the store
  (`employmentsForStore`, already includes ended employments — 13th-month is owed to staff who
  left mid-year too, unlike T-192's separate final-pay bundling), computes
  `basicPayEarnedInYear / 12`, nets `advanceToRecover(gross, outstandingAdvance(...))` exactly as
  `previewPayRun` does. Employments with zero basic pay for the year are excluded from the
  payout list (nothing earned, nothing owed) — mirrors `previewPayRun`'s "only people who worked."
- **`post13thMonthRun(tx, actor, { storeId, year, moneyAccountId, notes? })`** — same shape as
  `postPayRun`: insert the run, one payout + one `postEntry` per employment
  (`Dr 6140 gross / Cr 1230 advance recovered / Cr money account net`), mark posted. Same
  self-dealing block (`postPayRun`'s exact reasoning — "an admin paying themselves is precisely
  the case the block exists for"). Gated on `run_payroll` (already store-scoped, admin-only,
  self-dealing-aware — bible's capability matrix, no new capability needed).
- **`void13thMonthRun(tx, actor, { runId, reason })`** — mirrors `voidPayRun`: reverse each
  payout's journal entry, mark the run voided. No day-freeze/unfreeze step — 13th-month payouts
  never freeze attendance days.

### 2.4 UI — `apps/erp/src/app/payroll/thirteenth-month/`

A separate page from `/payroll`, not a section bolted onto it — the input shape is a **year**, not
a period, and the existing page's period-picker machinery does not apply. Mirrors `/payroll`'s own
preview → post → void pattern at a smaller scale: store picker, year input, preview table
(person, basic pay earned, gross, advance recovered, net), post button, then posted runs listed
with void.

---

## 3. Files

| File | Change |
|---|---|
| `packages/db/schema/thirteenth-month.ts` | New. `thirteenthMonthRuns`, `thirteenthMonthPayouts` |
| `packages/db/migrations/0115_t191_thirteenth_month_pay.sql` | New |
| `packages/db/src/repo/thirteenth-month.ts` | New. `basicPayEarnedInYear`, run/payout CRUD mirroring `payroll.ts`'s shape |
| `packages/domain/src/payroll/thirteenth-month.ts` | New. `preview13thMonthRun`, `post13thMonthRun`, `void13thMonthRun` |
| `packages/domain/src/payroll/index.ts` | Add `export * from './thirteenth-month'` |
| `apps/erp/src/app/payroll/thirteenth-month/page.tsx`, `lib.ts`, `actions.ts` | New |
| `packages/domain/tests/integration/thirteenth-month.test.ts` | New — the correctness suite |
| `docs/DEFECTS-REGISTER.md` | New row, section D or E depending on classification — the "13th-month estimate" manual text with no backing code |

---

## 4. Tests (integration, real Postgres — mirrors `payroll.test.ts`'s fixture)

1. ⭐ Basic pay summed correctly across **multiple posted regular runs** within the year, gross =
   sum / 12.
2. ⛔ A **voided** regular run's basic pay is **excluded** from the sum.
3. ⛔ Payslips from **another year** are excluded (year-boundary correctness — the one place a
   date-range bug would silently misprice).
4. An employment with **no payslips that year** is excluded from the payout list entirely, not
   paid ₱0.
5. Advance netting: `advanceRecovered` capped at gross, `netPay = gross - advanceRecovered`, same
   identity as `payslips_net_identity_check`.
6. ⛔ Self-dealing: the poster's own employment is refused, same message shape as `postPayRun`.
7. ⛔ Double-post: a second `post13thMonthRun` for the same `(storeId, year)` is refused while the
   first is still posted.
8. Void: reverses the journal entries, frees the `(storeId, year)` to be posted again.
9. An **ended** employment (resigned mid-year) with posted payslips still appears in the payout
   list — 13th-month is owed regardless of separation, unlike T-192's own final-pay workflow.

---

## 5. Do not decide alone — Ian's

| Question | The recommendation on the table |
|---|---|
| **2026's real 13th-month payout** | Not v2's job — see §1's finding. v2 will have Oct–Dec 2026 posted at most, and that data is pilot data purged 1 Jan 2027. Calendar-2026's actual statutory payout (due 24 Dec 2026) needs to happen through v1 or manually. **Flagging so nobody runs T-191 against 2026 expecting a real figure** |

---

## 6. Deliberately out of scope

| Not done | Why |
|---|---|
| T-192, separation/final-pay bundling | Handoff item 3 names T-191 only. Separate task, separate workflow — this ships the annual capability T-192 can later call, not the departure event itself |
| Tax withholding on the 13th-month amount | T-190 (statutory) is gated on data that does not exist — 0 of 126 staff have a TIN. Posting the gross, unwithheld, matches T-189's own current behavior (no statutory engine yet) |
| Pro-ration UI / manual override of the computed amount | The computation already self-prorates via actual `basicPay` earned — a manual override would be a second, competing source of truth for a number the database can derive correctly |
| A "preview only, current year" convenience default | The UI takes an explicit year input; a business running 13th-month pay is not the case to optimise for one fewer keystroke on |
