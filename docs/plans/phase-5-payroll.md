# Phase 5 — Payroll

> Written 2026-08-31. **Live v1 probed read-only before anything was planned** — 126 staff
> documents and every payroll-adjacent collection across all 7 stores.
> Locked decisions live in `PROJECT_BIBLE.md` §13 rows 90 and 108, §16.6 and §16.7.

---

## 1. ⛔ The discovery that reframes this phase

v1's payroll is **three shipped slices, ~4,200 lines, a verified PH-2024 tax engine, a GL posting
path, a late-charge policy and a read-cost cache with its own snapshot-version landmine.**

It has produced **zero payslips.**

```
store                    staff   payroll runs   payslips
  SharEat Lipa              35             0          0
  SharEat Malvar            16             0          0
  SharEat Davao             12             0          0
  SharEat Banay-Banay       13             0          0
  TEST                      50             0          0
                          ----          ----       ----
                           126             0          0
```

⛔ **`payrollRuns` does not exist as a collection on any store.** Not empty — never written to. The
path is confirmed against `payroll.actions.ts`'s own `runsColPath`.

### 1.1 And the statutory engine has no fuel at all

| Staff field | filled, of 126 |
|---|---:|
| `sssNumber` | **0** |
| `philhealthNumber` | **0** |
| `pagibigNumber` | **0** |
| `tin` | **0** |
| `hourlyRate` | 1 (0.8%) |
| `dailyRate` | 43 (34%) |
| `payType` | 51 (40.5%) — and the only value ever used is **`daily`** |

⛔ **Not one employee has a single statutory number.** SSS brackets, PhilHealth floors, Pag-IBIG
caps and BIR graduated withholding are all unusable until somebody types in an SSS number.

### 1.2 What IS used, heavily

```
salaryAdvances               614      ⭐ the real staff-money process
attendanceSessions           507      the clock, used every day
overtimeRecords               87
staffInfractions              52
salaryAdvanceStaffBalances    31
staffPayrollDeductions        13
payrollPeriodCache             3      someone previewed, three times
payrollRuns                    0
```

⭐ **Staff are paid — just not through the ERP.** The 614 advances are the trace of it: money goes
out against `1230` all the time, and no payslip ever settles it. **v2 already models advances**
(`cash_requests`, `1230 Advances to employees`, party-bearing).

---

## 2. ⭐ What this phase must and must not do

| Verdict | Why |
|---|---|
| ⛔ **Do NOT port v1's payroll as built** | It is the largest never-used feature in the system. Porting 4,200 lines to serve a process that has produced zero payslips is the most expensive possible mistake this project could make |
| ⛔ **Do NOT port the period cache** | ⭐ It exists to solve **375 billed Firestore reads per page load**. Postgres does not have that problem. Porting it would import `PAYROLL_SNAPSHOT_VERSION` — a landmine whose own memory says *"forget to bump it and every store keeps being served pay computed by the OLD rules: no error, no visual difference, wrong money"* — to fix a cost that no longer exists |
| ⛔ **Do NOT port the statutory engine yet** | Zero staff have a statutory number. It is a machine with no fuel. §5 records exactly where it lives and what triggers the port |
| ✅ **Build the smallest thing that actually pays somebody** | Rate → attendance → payslip → posted journal → advance netted. That is T-189 |
| ✅ **Book the EMPLOYER share when statutory lands** | Bible §16.7 defect #1: v1 marks it *"out of scope"* in code, so a legally mandated cost is missing from every period. `6110` / `6120` / `6130` already exist |

⭐ **Everything the phase posts to already exists in the chart**, provisioned in Phase 1 and never
used: `6100` salaries · `6110`/`6120`/`6130` employer shares · `6140` 13th month · `6150` additions ·
`6160` benefits · `2210`/`2220`/`2230`/`2240` statutory payables · `1230` advances.

---

## 3. ⭐ The seam is already cut

The attendance lane left this deliberately, and the schema says so in as many words:

```
frozenAt            timestamp
frozenByPayRunId    uuid      "The column lands now; Phase 5 sets it, which is why the FK is
                               deliberately absent until the pay-run table exists."
```

And the guard is **already live** — `adjudicate.ts` and `adjustments.ts` both refuse to recompute a
frozen day, naming the pay run. `PAYABLE_DAY_STATUSES` (`computed`, `verified`) is exported so
nobody re-derives it. ⭐ **T-189 attaches the FK and becomes the first thing that sets the column.**

---

## 4. The slices

| # | Task | State |
|---|---|---|
| **T-189** | **Pay rates and the pay run** — effective-dated daily rate, compute from `attendance_days`, net advances against `1230`, post, freeze the days | ⬅ **first** |
| T-190 | Statutory contributions and withholding — ⛔ **gated on §5's trigger** | specced when triggered |
| T-191 | 13th-month pay — bible row 90, a confirmed **ADD**; `6140` already exists | after T-189 |
| T-192 | Separation, final pay and clearance — bible row 90, a confirmed **ADD** | after T-191 |
| T-193 | Statutory remittance — settling `2210`–`2240`. ⚠️ Bible §16.7 defect #2: the generic payment action would **double-count** already-withheld employee contributions as fresh OPEX | after T-190 |

### 4.1 Deliberately out of the whole phase

| Not built | Why |
|---|---|
| The period cache | §2 — a Firestore read-cost artifact |
| `hourly` pay type | 1 rate across 126 staff. ⚠️ The rate table stores a **basis** so hourly is representable, but no hourly-specific compute path is written until someone is paid that way |
| MWE premium exemption (RA 9504) | v1 lists it as deferred too; it needs statutory first |
| Employer-share **remittance** timing / penalties | Bible §16.5 requirements 3–4. Belongs with T-193, not before |

---

## 5. ⛔ The statutory trigger — write it down so nobody guesses

> ⚠️ **Superseded by bible row 354 (Ian, 2026-10-16):** start T-190 now from the official 2026 tables; do not wait for the first SSS number. See `docs/tasks/190-payroll-statutory.md`.

**Port `ERP-rebuild/src/lib/payroll/statutory.ts` when, and not before, the first employment
carries a real SSS number.** It is 196 lines, pure, isomorphic, 14 tests, and carries its own
sources in a header comment — SSS 4.5% of MSC (₱500 brackets, floor ₱4,000 / ceiling ₱30,000),
PhilHealth 2.5% (floor ₱10,000 / ceiling ₱100,000), Pag-IBIG 2% capped at a ₱10,000 fund salary
(max ₱200), BIR RR 11-2018 graduated withholding per frequency. `TAX_TABLE_VERSION = 'PH-2024'`.

⚠️ **Review the rates against the current year before porting** — the header says SSS changes
almost yearly. Porting a 2024 table in 2027 without checking is worse than not porting it.

⭐ **A `statutory_ids` gap is what blocks it, not a schema gap.** T-189 adds the columns so the
numbers *can* be captured; the engine follows the data.

---

## 6. What "done" looks like for the phase

1. A payslip exists, posted, that a staff member could be shown.
2. `attendance_days` are frozen by the run that paid them, and recomputation refuses.
3. An advance drawn against `1230` is netted by the run that follows it, and `1230` goes to zero.
4. ⭐ **The trial balance still ties**, and `6100` finally has entries in it.
