# T-189 — Pay rates, and the pay run that finally pays somebody

> **Status:** specced 2026-08-31 · Phase 5 slice 1 · `docs/plans/phase-5-payroll.md`
> **Locked by:** bible §13 row 90, §16.6 (*"a paid payroll period is frozen, blocked by period
> OVERLAP not exact bounds"*, *"attendance pay is judged by span delivered"*), §16.7
> **Live v1 probed read-only 2026-08-31** — 126 staff, 7 stores, every payroll collection

---

## 1. ⭐ Verdict — build the smallest thing that produces a payslip, and refuse the rest

⛔ **v1's payroll has produced zero payslips.** Three shipped slices, ~4,200 lines, a verified
PH-2024 tax engine, a GL path, a late-charge policy, a read cache — and `payrollRuns` does not
exist as a collection on any store. Someone previewed three times.

So the question is not *"how do we port payroll?"* It is **"what is the smallest thing that
actually pays somebody, and what does the evidence say to leave out?"**

**In:** an effective-dated rate, a run that computes from `attendance_days`, nets what the person
already drew against `1230`, posts, and freezes the days it paid.

**Out, each with a number:** statutory (0 of 126 staff have any statutory ID), the hourly compute
path (1 of 126), and the period cache (a Firestore read-cost artifact Postgres does not have).

---

## 2. The evidence that shapes the build

| Fact | Consequence for this task |
|---|---|
| `payrollRuns` — **0 across 7 stores**, collection never created | The port is not the goal. A payslip is |
| `sssNumber` / `philhealthNumber` / `pagibigNumber` / `tin` — **0 of 126** | ⛔ No statutory. The columns land here so the data *can* arrive; the engine follows it (phase plan §5) |
| `payType` — 51 filled, and **every one is `daily`** | Daily is the compute path. `hourly` is *representable* in the rate basis and has no compute path written |
| `hourlyRate` — **1 of 126** | Confirms the above rather than contradicting it |
| `dailyRate` — 43 of 126 | The real input. This is what T-189 must capture |
| `salaryAdvances` — **614** | ⭐ The busiest staff-money process in the business. A run that does not net advances is not a payroll |
| `attendanceSessions` — 507 | The clock is real and daily. v2's `attendance_days` already adjudicates it |

---

## 3. What already exists here

| Exists | Relevance |
|---|---|
| `attendance_days` with `frozenAt` / `frozenByPayRunId` | ⭐ **The seam, cut by T-157 and left for this task**: *"the column lands now; Phase 5 sets it, which is why the FK is deliberately absent until the pay-run table exists"* |
| The freeze guard, already live | `adjudicate.ts` and `adjustments.ts` both refuse to recompute a frozen day, naming the run. Nothing to build — only something to set |
| `PAYABLE_DAY_STATUSES` = `computed`, `verified` | Exported so nobody re-derives it slightly differently |
| `store_attendance_config` | `requiredHoursPerShift`, `nightDiffMultiplier` (1.10), `overtimeMultiplier` (1.25) — the multipliers already configured per store |
| `1230 Advances to employees` | Party-bearing, `party_type='employee'`. Already debited by cash requests, commissary charges and (since T-186) till shortages |
| `6100 Salaries and wages` | Provisioned in Phase 1, `legacyCode: 'expense__salary'`. **Nothing has ever posted to it** |
| `btree_gist`, installed | ⭐ Makes §5.2's overlap constraint enforceable in the database rather than in a service |

---

## 4. ⛔ What is deliberately NOT built, each with its number

| Not built | Number | Why |
|---|---:|---|
| Statutory contributions and WHT | **0 / 126** have any statutory ID | A bracket table with no fuel. Phase plan §5 records the exact trigger and the file to port |
| Employer share (`6110`/`6120`/`6130`) | — | Bible §16.7 defect #1 is real and must be fixed, but it is meaningless before the employee share exists |
| The `hourly` compute path | **1 / 126** | The rate table stores a **basis**, so hourly is representable the day someone needs it. Writing the compute path now is writing for nobody |
| The period cache + `PAYROLL_SNAPSHOT_VERSION` | 375 Firestore reads/page | ⭐ Postgres does not have that problem. Porting it imports a landmine that silently serves **pay computed by the old rules** to fix a cost that no longer exists |
| Late charge (the 6th leg) | per-store policy, default `record_only` | v1's default is ₱0 and it depends on a `next_in` overlay v2 has not ported. ⛔ It changes the balance identity — it must arrive as its own task, not smuggled in |
| 13th month, separation/final pay | confirmed ADDs, bible row 90 | T-191 / T-192. `6140` already exists |

---

## 5. The structure

### 5.1 `pay_rates` — effective-dated, and ⛔ APPEND-ONLY with no `effective_to`

| Column | Notes |
|---|---|
| `id`, `org_id` | |
| `employment_id` → `employments` | ⭐ Not `person_id`. A rate belongs to a **job**, and a rehire is a new employment with a new rate |
| `basis` | `daily` \| `hourly`. ⚠️ Only `daily` has a compute path — §4 |
| `amount` numeric(14,2) | `> 0` |
| `effective_from` date | |
| `note`, `created_by`, `created_at` | |

- **Unique on `(employment_id, effective_from)`** — one rate per job per day it changes.
- ⛔ **There is no `effective_to`, on purpose.** v1 maintains one (`hourlyRateHistory` closes the
  open row) and a stored end date is a second fact that can disagree with the next row's start.
  The rate in force on a date is *the latest row whose `effective_from <= date`*. One fact.
- ⛔ **No UPDATE, no DELETE.** A wrong rate is superseded by a new row, because a payslip already
  posted was computed under the old one and must stay explicable.

### 5.2 `pay_runs` — the period

| Column | Notes |
|---|---|
| `id`, `org_id`, `store_id` | |
| `period_start`, `period_end` date | `period_end >= period_start` |
| `status` | `draft` \| `posted` \| `voided` |
| `money_account_id` → `money_accounts` | Where the net is paid from. ⚠️ Runs through the ordinary overdraft guard — payroll is not exempt from "can this account cover it" |
| `posted_at`, `posted_by`, `voided_at`, `voided_by`, `void_reason` | |
| `created_by`, `created_at` | |

⭐ **The overlap guard is an EXCLUDE constraint, not a unique index:**

```sql
EXCLUDE USING gist (store_id WITH =, daterange(period_start, period_end, '[]') WITH &&)
  WHERE (status = 'posted')
```

⚠️ Bible §16.6 names this exactly: *"a paid payroll period is frozen, blocked by period OVERLAP
not exact bounds — the stricter and correct test."* A unique index on `(store, start, end)` would
happily accept 1–15 August beside 10–20 August and pay the overlap twice.

### 5.3 `payslips` — one per employment per run

| Column | Notes |
|---|---|
| `id`, `run_id` → `pay_runs`, `org_id` | |
| `employment_id`, `person_id` | The person is stored too: ⚠️ an employment can end, and a payslip must stay readable |
| `pay_rate_id` → `pay_rates` | ⭐ **The rate it was computed under.** Same historical-integrity pattern as `attendance_days.attendance_config_id` — re-reading a March payslip in June must give March's answer |
| `days_worked` numeric(6,2) | Half days count 0.5 |
| `minutes_worked`, `ot_minutes`, `night_diff_minutes`, `holiday_minutes` int | Copied from the days that fed it |
| `basic_pay`, `ot_pay`, `night_diff_pay`, `holiday_pay` numeric(14,2) | |
| `gross_pay`, `advance_recovered`, `net_pay` numeric(14,2) | |
| `journal_entry_id` | The entry this payslip posted |

**Two CHECKs, because an identity that lives only in code drifts:**

```sql
gross_pay = basic_pay + ot_pay + night_diff_pay + holiday_pay
net_pay   = gross_pay - advance_recovered      -- and net_pay >= 0
```

⚠️ **The identity gains terms when statutory lands** (`− statutory − withholding`). v1's own
history is the warning: its identity went from 4 legs to 5 to 6, and each time *"anything asserting
the five-leg identity breaks."* Writing it as a CHECK means the migration that adds a term must
also restate the rule, in one place, deliberately.

### 5.4 ⭐ Attaching the FK the attendance lane left open

```sql
ALTER TABLE attendance_days
  ADD CONSTRAINT attendance_days_frozen_by_pay_run_fk
  FOREIGN KEY (frozen_by_pay_run_id) REFERENCES pay_runs(id) ON DELETE restrict;
```

---

## 6. How a payslip is computed

⚠️ **Only `daily` basis. A run refuses an employment whose rate basis is `hourly`, by name**, rather
than guessing an hourly path nobody has exercised.

```
days        = attendance_days in [start, end], store, employment,
              status IN ('computed','verified'), frozen_at IS NULL
daysWorked  = Σ (is_half_day ? 0.5 : 1)
basicPay    = daysWorked × rateInForceOn(day)          ⭐ per DAY, not one rate for the period
hourlyEquiv = rate ÷ requiredHoursPerShift             (store_attendance_config)
otPay       = otMinutes/60        × hourlyEquiv × overtimeMultiplier
nightDiffPay= nightDiffMinutes/60 × hourlyEquiv × (nightDiffMultiplier − 1)   ⭐ an ADD-ON
holidayPay  = holidayMinutes/60   × hourlyEquiv × (holidayMultiplier − 1)     ⭐ an ADD-ON
```

⭐ **Half a day pays half the daily rate — never the hours covered.** A locked v1 decision, and it
was a *fix*: hourly half-days were paying `computedHours × rate`, which paid part of the unpaid
break twice. Do not "correct" it back.

⭐ **The rate is resolved per DAY, not once per period.** A raise mid-period pays the old rate
before it and the new rate after, which is what an effective date means.

⚠️ **Night-diff and holiday are ADD-ONS** (`× (multiplier − 1)`), because the hour is already paid
once inside the daily rate. Paying `× multiplier` would pay the base hour twice — v1 records this
and it is easy to get wrong.

⛔ **`needs_review` days are excluded and COUNTED.** A run that silently skips a day a manager has
not settled looks identical to a run where nobody worked. The count is surfaced.

---

## 7. The posting

Per payslip, one entry, `source_type = 'payrollpayslip'`, `source_id = {payslipId}`:

```
Dr  6100  Salaries and wages              gross
    Cr  1230  Advances to employees              advance_recovered   party = the person
    Cr  <the run's money account>                net
```

Two legs when nothing is owed, three when an advance is netted.

⭐ **The advance is read from `1230`'s own party balance**, never from a projection. v1 records
exactly this trap: *"advance sourced from the AUTHORITATIVE account balance, NOT the projection —
else a failed post rebuild double-recovers next period."*

⛔ **`advance_recovered = min(outstanding advance, gross)`** and never more. Net may reach zero; it
may never go below. A person who owes more than they earned keeps owing the rest.

### 7.1 Void

Reverses each payslip's entry, sets the run `voided`, and ⭐ **clears the freeze on the days it
paid** — `frozen_at` and `frozen_by_pay_run_id` back to null. A voided run did not pay, so those
days must be payable again. ⚠️ This is the one place the freeze is lifted, and it is why the
column pair is nullable rather than a boolean.

---

## 8. Capability

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `set_pay_rate` | store | ✅ | ✅ | **✗** | ✗ | ⛔ **Manager is ✗.** A manager who can set the rate of the staff they roster can raise their own team's cost without anyone approving it. Same reasoning the matrix already records for `set_cash_policy` |
| `run_payroll` | store | ✅ | ✅ | **✗** | ✗ | v1's `postPayrollRunAction` is **ADMIN-only**; that is preserved. Payroll moves more money in one action than anything else in the system |

⛔ **Self-dealing:** a person may not post a run that pays their own employment. Bible §16.6 —
*"three independent self-dealing blocks… preserve all three."* Admins are **not** exempt here,
unlike attendance: an admin paying themselves is the case the block exists for.

---

## 9. Done when

1. A rate can be set, superseded, and read back **as at a date**.
2. ⛔ Two posted runs whose periods **overlap** are refused by the database, not by a service.
3. A run computes from real `attendance_days`, excludes and counts `needs_review`, and pays half a
   day at half the daily rate.
4. A raise mid-period is paid at both rates.
5. An advance is netted from `1230` and the party balance goes to zero; a bigger advance than the
   gross leaves net at zero and the remainder still owed.
6. ⭐ Posting **freezes** the days; re-adjudicating one is refused, naming the run; voiding unfreezes.
7. `run_payroll` denies a manager, and denies an admin paying **their own** employment.
8. ⭐ Driven in a browser: set a rate, preview a run, post it, see the payslip, void it.

## 10. Gates

`typecheck` · `test` · `test:integration` · `build`, and the screens rendered in Chrome on 9008.

---

## 11. ✅ Built — 2026-08-31

| Delivered | Where |
|---|---|
| `pay_rates`, `pay_runs`, `payslips` | migration `0105`, `packages/db/schema/payroll.ts` |
| ⭐ The FK T-157 left open | `attendance_days_frozen_by_pay_run_fk`, in `0105` |
| ⭐ The overlap EXCLUDE guard | `pay_runs_no_overlapping_posted_period`, `btree_gist` |
| Pure compute | `packages/domain/src/payroll/compute.ts` — 16 unit tests |
| Services | `setPayRate` · `previewPayRun` · `postPayRun` · `voidPayRun` |
| Capabilities | `set_pay_rate` and `run_payroll`, both manager-✗ |
| Screen | `/payroll` |
| Tests | 19 integration + 16 unit |

**Verified in a browser, and every figure checks on paper:** 10 attendance days with one half day →
**9.5 days × ₱540 = ₱5,130** basic; 2h OT × (540 ÷ 9) × 1.25 = **₱150**; gross **₱5,280** less a
**₱1,200** advance = **₱4,080 net**. Posted `Dr 6100 / Cr 1230 / Cr 1130`, `1230` went to zero, all
ten days froze, the trial balance stayed at **0.00**, and voiding reversed the entry and unfroze all
ten so the period was payable again.

### 11.1 ⛔ The trigger amendment — migration `0106`

T-157's freeze trigger refuses **every** update on a frozen day, and its message says *"correct it
through payroll."* ⚠️ **Payroll was never given a door.** Without one, voiding a mis-posted run is
impossible and the days are stranded: frozen against a run that no longer pays them, unpayable by
anybody, for ever.

⭐ **The door is as narrow as it can be made** — an update may clear the freeze only if it changes
**nothing else on the row**, compared over every column via `to_jsonb`. A recomputation moves
`computed_minutes`, `status` or `anomalies`, so it is refused exactly as before. T-157's invariant
survives in the sense that matters: **a frozen day cannot be RESTATED**; it can only be released,
whole, by the module that froze it.

### 11.2 What the build changed about the spec

| Changed | Why |
|---|---|
| `pay_runs_posted_shape_check` | Specced as `(status='posted') = (posted_at is not null)`. **A voided run keeps its `posted_at`** — it *was* posted, and erasing when and by whom erases the only record it ever paid anybody. Now `(status='draft') = (posted_at is null)`, plus a pair check |
| The order of the two refusals in `postPayRun` | When the only people who worked have no rate, both "nothing to pay" and "no rate in force" are true. ⚠️ **Naming who has no rate is the half somebody can act on**, so it is checked first |
| `PAYROLL_ADVANCE_ACCOUNT` rather than `STAFF_ADVANCE_ACCOUNT` | ⚠️ The **fourth** module to name `1230`: `cash-requests`, `commissary/discrepancy`, `owners`, and now payroll. They agree on the code and disagree on the name — worth one shared constant one day, and not worth a refactor from inside a payroll task |
| A `FIELD` class without `w-full` | ⚠️ `${INPUT} w-24` put `w-full` and `w-24` in one class string, and `w-full` won — the rate form stacked full-width in a browser while every test stayed green. **A test asserts props, never geometry** |

### 11.3 ⛔ DEF-108 — found by reading a comment, not a failing test

`ownersRepo.drawnInWindow` left a note for exactly this moment: *"when payroll lands, the entry that
nets one of these off must carry the same `source_id`, or the recovered amount will keep consuming
the cap forever."* ⚠️ **Doing as instructed turns out to be impossible** — one entry cannot carry two
`source_id`s, and a payslip may net advances from several origins. Raised as DEF-108 with the fix
that does work (count the NET on `1230` rather than debits scoped by `source_id`), and left for the
owners lane, because the scoping it relaxes is what stopped a ₱600 staff shortage consuming a
drawing limit.

## 12. Gates — 2026-08-31

`typecheck` ✅ · `unit` ✅ · `integration` ✅ · `build` ✅ · `/payroll` driven in Chrome: rate set,
run previewed, posted, payslip read, voided, days unfrozen.

---

## 13. ✅ T-189b — overtime priced two ways, hours in half-hour steps, holiday per type

> **Ian, 2026-08-31:** *"for OT it must be configurable to x1.25 or fix amount, and time must be
> computed by .5 escalation so hours are .5, 1, 1.5, 2 like that, no hanging minutes except for
> computation of late."*
>
> **and:** *"holiday must be configurable too. 1.3, 1.5, 2."*

Migration `0107`. Three changes, and only the first two needed schema.

### 13.1 Overtime: a multiplier, or a flat amount

`store_attendance_config` gains `overtime_mode` (`multiplier` | `fixed`) and
`overtime_fixed_hourly`. ⭐ **`fixed` REPLACES the rate rather than multiplying it** — a flat peso
amount per overtime hour, which is what "or fix amount" means. It is a mode rather than a second
number quietly reinterpreted, because those two things price an hour completely differently.

⛔ **The dangerous combination is unrepresentable**, the same shape T-152 used for the un-remitted
ceiling: `overtime_mode = 'multiplier' OR overtime_fixed_hourly IS NOT NULL`. Without it a store
could switch to `fixed`, and every overtime hour would price at **zero** — no error, no visual
difference, and the people who worked those hours paid nothing.

⭐ **Fixed OT is exempt from the `requiredHoursPerShift > 0` guard**, deliberately: a flat amount
never divides by the shift length, so a misconfigured shift cannot corrupt it and there is no
reason to withhold pay somebody earned because of an unrelated typo.

### 13.2 ⭐ Hours in half-hour steps — and the direction is a DECISION

`steppedHours(minutes) = floor(minutes / 30) / 2`.

| Worked | Paid |
|---:|---:|
| 30 min | 0.5 h |
| 1 h 50 m | **1.5 h** |
| 59 min | 0.5 h |
| 29 min | **nothing** |

⚠️ **The remainder is DROPPED, not rounded up** — *"no hanging minutes"* means the leftover is
discarded, and rounding up would pay for time nobody worked. **This has a consequence worth
stating:** a store whose overtime is habitually 20 minutes will pay none of it. The remedy is to
change how overtime is approved, not to round it up quietly here. ⭐ **The minutes are still
recorded on the payslip even when they pay nothing** — the fact is kept.

Applied to overtime, night differential and holiday alike, because the rule is about *hours*.

⛔ **Late is NOT stepped**, exactly as Ian said. It is the right exception: lateness measures a
person's conduct, and rounding 25 minutes late down to zero would erase the fact.
`attendance_days.lateMinutes` stays an exact integer minute and nothing in `compute.ts` touches it.

### 13.3 ⭐ Holiday: THREE multipliers, not one

`attendance_days.holidayType` already records which kind of holiday a day was — `regular`,
`special_non_working`, `special_working` — so a single configurable number would have thrown that
away and priced a regular holiday the same as a special one. ⚠️ **v1 hardcodes 2.0 / 1.3 and has no
third at all.**

| Setting | Default | Ian's figure |
|---|---:|---|
| `holiday_regular_multiplier` | 2.00 | 2 |
| `holiday_special_non_working_multiplier` | 1.30 | 1.3 |
| `holiday_special_working_multiplier` | 1.50 | 1.5 |

⛔ A CHECK refuses anything below 1: the premium is an **add-on** (`× multiplier − 1`), so a value
under 1 would turn working a holiday into a deduction.

### 13.4 Verified in a browser, with figures that check on paper

With 110 minutes of overtime, a regular holiday and a special non-working day in one period:

```
multiplier mode   OT 1.5h × 60 × 1.25 = 112.50   holiday 540.00 + 162.00   premiums 814.50
fixed mode        OT 1.5h × ₱80       = 120.00   holiday unchanged        premiums 822.00
```

⭐ **The premium settings now render on `/payroll` itself.** They were constants in code; a number
that decides somebody's pay belongs on the screen that spends it, not in a migration.

---

## 14. ✅ T-189c — payroll periods, configured rather than assumed

> **Ian, 2026-08-31:** *"and look how payroll dates are configured in v1, it must be configurable."*

Migration `0108`. `/payroll` was offering a hardcoded 1st-to-15th, which is simply wrong for a
store on monthly or weekly periods.

### 14.1 v1's shape, read at source

```
PayrollConfig {
  periodType          'monthly' | 'semi_monthly' | 'weekly'    default semi_monthly
  semiMonthlyCutoffs  [number, number]                          e.g. [15, 31]
  payoutLagDays       number
}
```

`derivePeriods(config, year, month)` — monthly is one window; weekly is 7-day windows from the 1st
with a short last one; semi-monthly is `1..cutoff` and `cutoff+1..monthEnd`.

### 14.2 ⚠️ One field of v1's is dead, and v2 does not port it

`semiMonthlyCutoffs` is a **pair**, and `derivePeriods` only ever reads `[0]`. The second period
always ends on the last day of the month, computed. **The stored second element is never read** —
so a store can hold a `31` that is silently meaningless in February. v2 stores
`semi_monthly_cutoff_day`, the one number that is actually used.

⭐ This is the third dead field the live data or the source has turned up in three days —
`paymentOptions` on suppliers, `staff.rate` in v1's own memory, and now this.

### 14.3 ⭐ The invariant v1 states and never checks

v1's comment claims *"every mode's periods tile the whole calendar month with no gaps and no
overlaps, and periods never cross a month boundary"* — and three other functions rely on it
(`periodForDate`, `payoutCoversDate`, `periodsOverlap`) with **no test asserting it anywhere**.

`tilesTheMonth()` makes it checkable, and the tests check every mode, in every month, across a
leap year — plus a negative case, so the checker itself cannot be vacuous.

### 14.4 The clamp is in TWO places, deliberately

The CHECK constraint refuses a cutoff outside **1–27**; `derivePeriods` clamps as well. That is not
belt and braces:

- The **database** stops a bad value being *stored*.
- The **function** is pure and may be called with a config assembled anywhere — a test, a future
  importer — and must not produce an inverted period if one reaches it another way.

⚠️ **1–27, not 1–31.** A cutoff of 28 or later makes February's second period empty or inverted; 27
is the last day that leaves a real second period in every month of every year. ⛔ v1 clamps only at
read time, which means a store there can *hold* a value its own code ignores.

### 14.5 One bug the browser caught

The period picker and the two date inputs **both submit**, and the page read only the dates — so
choosing a period looked like it worked and silently did nothing. Precedence is now explicit:
picker, then typed dates, then the store's current period. ⚠️ The dates stay editable underneath,
because a late correction has to be payable even when it does not line up with a configured window.

### 14.6 Verified in a browser, two stores at once

| Store | Periods | Overtime | Payout |
|---|---|---|---|
| Lipa | semi-monthly, cut on the 15th | **₱80.00 / hour, flat** | same day |
| Malvar | **weekly** — Aug 1–7, 8–14, … | ×1.25 | **3 days after** — "payable 2026-08-18" |
