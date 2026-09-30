# T-370: owner drawing cap after payroll, real calendar dates, and a semi-monthly pay cycle refused on save — DEF-108, DEF-494, DEF-409

**Status:** APPROVED-PENDING (orchestrator review). Spec by the Opus planner, 2026-09-30. **Model:** Sonnet, tester then
builder, per slice.
**Census:** `docs/plans/money-defects-2026-09-30.md` (batch E). DEF-409 was added by Ian's ruling of 2026-09-30:
*"refuse on save: semi-monthly needs exactly two pay days ≤16 days apart."*
**Migration:** one, in S3 only. Take the **next free index at build** (0172–0174 are taken). Follow ADR-012 §5.
**Line numbers** were checked at HEAD `72a6102`. None of the BUILDER paths is dirty at that HEAD.

## Goal
1. A payroll run that recovers an owner's salary advance frees that owner's drawing cap, exactly as a cash repayment
   of the same amount on the same date would. An ordinary staff advance still never touches the cap.
2. `parseBusinessDate` refuses a date that does not exist on the calendar (`2026-02-30`, `2026-04-31`,
   `2026-02-29`). A real leap day (`2024-02-29`) still parses.
3. A `semi_monthly` store is refused at save when its pay cycle cannot pay at intervals of 16 days or fewer
   (Labor Code Art. 103). In `fixed_days` mode it must also have exactly two distinct payout days.

## Census, verified at source (corrections marked ⚠️)
- **DEF-108.** `drawnInWindow` (`packages/db/src/repo/owners.ts:204-240`) counts `1230` only where
  `je.source_id = owner.id` (`:231-234`).
  - `recoverFromPay` posts `DR 1230 · CR 1260` with `sourceId: owner.id` (`packages/domain/src/owners/index.ts:450-474`).
  - Payroll credits `1230` with `sourceType: 'payrollpayslip', sourceId: payslipId`
    (`packages/domain/src/payroll/index.ts:458-484`).
  - Payroll recovers the person's whole outstanding `1230`, with no origin allocation (`outstandingAdvance`,
    `:329-348`; `advanceToRecover`, `:283`). So the recovery is invisible to the query, and the cap stays consumed
    forever.
  - Stale doc: the `recoverFromPay` JSDoc (`owners/index.ts:419-421`) says *"v2 has no payroll module yet"*.
  - ⚠️ **Not in the census:** `owners_store_person_key` (`packages/db/schema/owners.ts:127`) makes an owner row per
    (store, person). So one person can hold two owner rows that both reclassify into the one `1230` balance. The
    fix must not count that balance twice.
  - ⚠️ **Not in the census:** reversals carry the original `source_id` and set `reversal_of_entry_id`
    (`packages/domain/src/ledger/reverse-entry.ts:190-191`; `schema/journal*.ts:97`). So `voidPayRun` re-debits
    `1230` under the payslip's id. A reversed recovery must put the cap back.
- **DEF-494.** `parseBusinessDate` (`packages/core/src/datetime.ts:43-52`) checks the format and `1 ≤ d ≤ 31` only.
  - T-360 added a local round-trip in `parseShiftDayInput`, step 4 (`packages/domain/src/attendance/adjustments.ts:95-97`).
  - Every caller was grepped (non-test). Effect of the fix on each:

    | Caller | Input source | Effect of the fix |
    |---|---|---|
    | `packages/db/src/repo/ap.ts:434` (`invoicePhrase`) | DB `date` column | none (always a real date; already in try/catch) |
    | `packages/domain/src/ap/index.ts:791` (`expenseKey`) | DB `date` column | none (try/catch) |
    | `packages/domain/src/sales-days/create.ts:44` (`safeHumanDate`) | caller string, message only | the fallback now shows the raw string instead of a silently normalised date. Improvement |
    | `packages/domain/src/reports/cash-flow.ts:109` | URL `?from=` (`reports/cash-flow/page.tsx:43`, `export/route.ts:18`) | `2026-02-30` used to become opening-as-of `2026-03-01` and then fail in Postgres (22008). Now it throws earlier with `Invalid business date: 2026-02-30`. Still an error page, now a truthful one |
    | `packages/domain/src/attendance/shift-day.ts:81` (`parseShiftDay`) → `attendance/adjudicate.ts:247` | DB `date` column | none |
    | `parseShiftDay` → `attendance/config.ts:82` (`supersedeConfig`) | form `effectiveFrom` (a `type="date"` input) | a hand-posted `2026-02-30` used to reach Postgres (22008 → generic fallback). It now joins the existing malformed-value path |
    | `parseShiftDay` → `attendance/adjustments.ts:91` | hidden input | step 4 becomes dead. **Reuse, don't duplicate:** S2 deletes step 4. T-360 D3/D13 keep asserting the same user sentence through step 3's catch |

  - No production caller relied on the leniency. Only the cash-flow page changes what a user sees, and only for a
    hand-typed impossible date.
  - ⚠️ **A second date idiom exists outside core** (out of scope, logged below):
    - `packages/domain/src/commissary/orders.ts:353` does a regex-only check.
    - `apps/erp/src/app/statutory-discounts/page.tsx:32` has its own `ISO_DATE`.
- **DEF-409.** The census is correct on `page.tsx:214-220`, `periods.ts:158` and `0109_t189d_payout_days.sql:35`.
  - ⚠️ **T-332 already ships the detector.** `payoutIntervalFindings` (`packages/domain/src/findings/index.ts:88-145`)
    derives 12 months of payout dates with `derivePeriods` and `payoutDateFor` and takes the largest gap between
    distinct dates. It compares that gap with `PAY_INTERVAL_MAX_DAYS = 16` (`packages/db/src/repo/findings.ts:2058`,
    module-private).
    - The save-time refusal must **reuse that arithmetic**, not re-derive it.
  - ⚠️ **The screen reaches the one-day state by typo, not only on purpose.** `parseIntList`
    (`apps/erp/src/app/settings/attendance/lib.ts:30-39`) silently drops non-integer tokens and de-duplicates. So
    `10, 2 5` saves as `[10]`, and so does `10,10`.
    - It also **sorts**, so `25,10` cannot be entered at all. The register row's *"so is 25,10"* holds only for
      direct writes.
  - ⚠️ `supersedeConfig` merges `changes` over the live row (`config.ts:110-117`). The rule must be judged on the
    **merged** row.
  - The only writers are `supersedeConfig` and `seedAttendanceConfig`. The seed uses schema defaults (semi_monthly,
    lag 0, cutoff 15), which comply.

## Rulings (planner)
- **R1 (DEF-108): recoveries are attributed oldest-charge-first (FIFO) across the person's whole `1230` ledger.**
  - Payroll does not allocate, so attribution is a convention. FIFO is the one `agedReceivables` in the same file
    already uses (`owners.ts:~250-265`).
  - Each alternative fails a real case:
    - *Staff-first* (`min(ownerOrigin, balance)`) makes a later ₱600 shortage consume the cap again after the owner
      portion was recovered, which is the leak the `source_id` scope was written to stop.
    - *Owner-first* frees the cap with money that repaid a staff debt.
  - Every `1230` credit is real money back (payroll net or cash), so FIFO opens no bypass.
- **R2 (DEF-108): an owner's outstanding advance at instant `t`, `ownerOutstanding(owner, t)`, is computed over the
  person's `1230` lines with `entry_date < t` and `je.status <> 'draft'`:**
  1. **Charges.** Every debit line is a charge. A charge is *owner-origin for owner O* iff `je.source_id = O.id`.
  2. **Reversal credits.** A credit on an entry with `reversal_of_entry_id = X` reduces X's own charge only. It never
     enters the pool.
  3. **Reversal debits.** A debit on a reversal entry (e.g. `voidPayRun` reversing a payslip credit) cancels X's
     credit contribution to the pool. It is not a new charge.
  4. **The pool.** Every other credit joins the pool. The pool is applied to charges oldest first, ordered by
     (`entry_date`, `je.created_at`, `jl.id`).
  5. **Result.** `ownerOutstanding` is the unconsumed remainder of O's owner-origin charges. It is never negative.
  - The window term becomes:
    `drawn(window) = [1260/3200 flows in window, unchanged] + ownerOutstanding(until) − ownerOutstanding(since)`.
    An omitted `since` means 0. An omitted `until` means all lines.
  - This keeps today's numbers identical whenever no non-owner credit exists. The reclass entry still nets to zero
    in its own month.
  - Two owner rows of one person each see only their own charges' remainders, so nothing is double-counted.
- **R3 (DEF-108): the arithmetic lives in the repo.** It is a pure exported helper, `fifoOwnerOutstanding(lines,
  ownerId)`, in `packages/db/src/repo/owners.ts`. It is fed by one query per call that selects that person's `1230`
  lines up to `until`.
  - A repo may not import `@shareat/domain` (ADR-004).
  - A single person's `1230` history is small.
  - The SQL stays in the repo (RULES §5).
- **R4 (DEF-108): `closeDrawingMonth` / `closeableMonth` / `owners/lib.ts:78` inherit the change deliberately.** A
  payroll recovery in month M lowers M's ledger amount, exactly as `repayFromOwner` in M already does. No other
  caller changes.
- **R5 (DEF-494): fix core and delete the local copy.**
  - `parseBusinessDate` checks `d ≤ daysInMonth(y, m)` using **pure integer arithmetic**:
    - Month lengths come from a table.
    - Leap year = `(y%4===0 && y%100!==0) || y%400===0`.
  - **Not** a `Date.UTC` round-trip: `Date.UTC` maps years 0–99 to 1900–1999, so a round-trip would reject
    `0004-02-29` and accept nothing new.
  - The error text stays `Invalid business date: <value>`.
  - T-360's step 4 and its JSDoc sentence are removed from `adjustments.ts`.
- **R6 (DEF-409): what goes where** (RULES §6.3 = bible §15.11, *no layer may be the only one*):

  | Rule | Domain (`supersedeConfig`, refuse on save) | DB CHECK (new) | Detector (T-332, exists) |
  |---|---|---|---|
  | semi_monthly + fixed_days ⇒ exactly two **distinct** days | ✅ own sentence | ✅ `cardinality = 2 AND [1] <> [2]` | ✅ (a collapse shows as a 28+ gap) |
  | every gap between paydays ≤ 16 (any payout mode, cutoff included) | ✅ via the shared gap function | ⛔ cannot: it depends on month lengths, clamping and `derivePeriods`. A SQL copy would be a second source of truth that drifts | ✅ the backstop for direct writes |

  - The CHECK is:

    ```
    superseded_at IS NOT NULL OR payroll_period_type <> 'semi_monthly' OR payout_mode <> 'fixed_days'
      OR (cardinality(payout_days) = 2 AND payout_days[1] <> payout_days[2])
    ```

    - Name: `store_attendance_config_semi_monthly_two_days_check`.
    - Superseded rows are history. They governed real days and are never rewritten. The exemption also lets a
      violating live row be retired by the ordinary supersede UPDATE.
    - `payout_mode <> 'fixed_days'`, not `= 'lag'`: a bogus mode must still trip only `payout_mode_check`
      (`constraint-message-lookup.test.ts:237` isolates it that way).
- **R7 (DEF-409): the spacing rule applies to `lag` mode too.**
  - Ian's ruling names the interval. A semi_monthly lag store with cutoff 10 pays 21 days apart
    (Jan 10 → Jan 31), and the detector already flags it.
  - In lag mode this admits only cutoff 15 or 16. The precheck (below) says whether any live store is affected
    before this ships.
  - `monthly` and `weekly` are **not** refused. That is outside the ruling, and the detector keeps reporting
    `monthly`.
- **R8 (DEF-409): one gap function, two callers.**
  - Extract `maxPayoutGapDays(periodCfg, payoutCfg, startYear, startMonth): number` into
    `packages/domain/src/payroll/periods.ts`, moving the body of `findings/index.ts:102-137`.
  - `payoutIntervalFindings` calls it with Manila today's month.
  - `supersedeConfig` calls it with the `effectiveFrom` month. The window-independence argument at
    `findings/index.ts:95-101` makes the result the same.
  - Export `PAY_INTERVAL_MAX_DAYS` from `findings.ts` and import it. Do not add a second 16.
  - **Invariant:** a config that `supersedeConfig` accepts never fires `payoutIntervalTooLong`.
- **R9 (DEF-409): sentences.** Use `refuse(dev, user)` (`packages/domain/src/shared/refusal`), placed after
  `authorize` and `parseConfigChanges`, on the merged row, before `markSuperseded`.
  - `SEMI_MONTHLY_TWO_DAYS` = `A semi-monthly store pays on exactly two different days of the month. Enter two
    payout days, for example 10,25.`
  - `semiMonthlyGap(n)` = `` `This semi-monthly pay cycle can run ${n} days between paydays. The Labor Code
    (Art. 103) allows at most 16. Change the payout days or the cutoff day, for example payout days 10,25 with
    cutoff 15.` ``
  - The same `SEMI_MONTHLY_TWO_DAYS` text is mapped for the new CHECK in `constraint-messages.ts`.

## Slices — S1, S2 and S3 touch disjoint files and may run in parallel
### S1 — DEF-108 owner cap
- **BUILDER:**
  - `packages/db/src/repo/owners.ts`: `drawnInWindow` per R2/R3, `fifoOwnerOutstanding`, and the comment block
    `:219-231` rewritten.
  - `packages/domain/src/owners/index.ts`: JSDoc only, at `:357` and `:413-424`.
- **TESTER:**
  - `packages/domain/tests/integration/t370-owner-cap-payroll-recovery.test.ts` (new).
  - `packages/db/tests/t370-fifo-owner-outstanding.test.ts` (new, unit, pure helper).
- **Contract:** `drawnInWindow(tx, orgId, owner, window)` keeps its signature and `toFixed(2)` string.
  `fifoOwnerOutstanding(lines: {entryId, reversalOf: string|null, sourceId: string|null, debit: string, credit: string,
  entryDate: string, createdAt: string, lineId: string}[], ownerId): string` (≥ 0).

### S2 — DEF-494 calendar dates
- **BUILDER:**
  - `packages/core/src/datetime.ts` (`parseBusinessDate`, plus a private `daysInMonth`).
  - `packages/domain/src/attendance/adjustments.ts` (delete step 4 and its JSDoc sentence; keep steps 1–3 and both
    sentences).
- **TESTER:** `packages/core/tests/datetime.test.ts` (new).
- **Contract:** `parseBusinessDate(value: string): BusinessDate` is unchanged in type. It throws
  `Invalid business date: <value>` for any date not on the proleptic Gregorian calendar.

### S3 — DEF-409 refuse on save
- **BUILDER:**
  - `packages/domain/src/payroll/periods.ts` (`maxPayoutGapDays`).
  - `packages/domain/src/findings/index.ts` (call it).
  - `packages/db/src/repo/findings.ts` (export the constant).
  - `packages/domain/src/attendance/config.ts` (refusal).
  - `packages/db/schema/attendance-config.ts` (the `check(...)` beside `:327-329`, with a NOTE naming the migration).
  - `packages/db/migrations/NNNN_t370_def409_semi_monthly_two_days.sql` and `migrations/meta/_journal.json` (grid
    `when`).
  - `apps/erp/src/lib/constraint-messages.ts` (map the new name).
  - `apps/erp/src/app/settings/attendance/page.tsx:219` (hint only: *"Semi-monthly: exactly two days, 15–16 days
    apart, e.g. 10,25"*).
- **TESTER:**
  - `packages/domain/tests/integration/t370-semi-monthly-refusal.test.ts` (new).
  - `packages/domain/tests/t370-max-payout-gap.test.ts` (new, unit).
  - `packages/domain/tests/integration/t332-payday-compliance.test.ts`: `insertConfigFixedDaysCollapse` becomes the
    now-legal spacing violation `payout_days = [10,20]`, cutoff 15. Its B1 leg asserts the measured 21. Case 5
    (pure) is unchanged.
  - `apps/erp/tests/integration/constraint-message-lookup.test.ts` (one new row).
  - `apps/erp/tests/integration/t370-settings-attendance-web.test.ts` (new).
- **Contract:** `maxPayoutGapDays(...)` returns an integer number of days, the largest gap between consecutive
  distinct payout dates across 12 months. `supersedeConfig` is unchanged in signature and throws a presentable
  refusal.

## Invariants
1. A payroll recovery frees the cap exactly as `repayFromOwner` of the same amount on the same date would, for both
   `monthly` and `total` windows (R2; `owners/index.ts:354-358`).
2. A staff advance with no owner-origin charge never changes `drawnInWindow` (`owners.test.ts:279`, which stays
   green).
3. `recoverFromPay` alone still frees nothing (`owners.test.ts:534`, which stays green; `owners/index.ts:419`).
4. The ledger is the only source, and nothing is stored or projected (`payroll/index.ts:322-327`, bible §12).
5. One date parser (bible §12 landmine 26; `shift-day.ts:22-26`).
6. For semi_monthly, a save accepted by `supersedeConfig` ⇒ `payoutIntervalTooLong` is silent for that store (R8).
7. There are two 16-day constants for two statutes, never aliased (`findings.ts:2052-2057`).
8. Superseded config rows are never rewritten (R6).

## Tests — red legs assert the TARGET. Every "refused" has a positive control. Every leg names its mutant.

| Leg | Setup → assertion (target) | Today | Mutant that must turn it red |
|---|---|---|---|
| O1 | Owner with an active role and a monthly limit of 5000. A repayable ₱2000 charge on 2026-01-10. `recoverFromPay` ₱2000 on 01-20. `postPayRun` whose payslip recovers ₱2000, entry 2026-02-05. Assert `drawnInWindow` total = `0.00`, Jan = `2000.00`, Feb = `-2000.00` (the same three numbers a `repayFromOwner` on 02-05 gives, asserted side by side in a twin fixture) | total `2000.00` | restore the `source_id`-only scope |
| O2 | O1, then `voidPayRun`. Total back to `2000.00` | n/a | ignore `reversal_of_entry_id` (the void debit treated as a new staff charge ⇒ owner stays 0) |
| O3 | Reclass ₱1000 on 01-10, staff shortage ₱600 on 01-15 (raw insert, `owners.test.ts:295-306` shape), payroll recovers ₱1000 on 02-05. Owner total `0.00` | `1000.00` | staff-first `min(ownerOrigin, balance)` ⇒ `600.00` |
| O4 | Shortage ₱600 on 01-05, reclass ₱1000 on 01-10, recovery ₱1000. Owner total `600.00` | `1000.00` | owner-first ⇒ `0.00` |
| O5 | Partial recovery ₱500 of a ₱2000 reclass ⇒ `1500.00` | `2000.00` | pool applied as all-or-nothing |
| O6 | One person owns stores A and B. Reclass ₱1000 (A, 01-10), then ₱700 (B, 01-12). Recovery ₱1200. A = `0.00`, B = `500.00`, sum = the person's `1230` balance | A 1000, B 700 | count the whole balance per owner ⇒ A `500`, B `500`, or the sum exceeds the balance |
| O7 (control) | Staff shortage ₱600 only, then recovery ₱600. Owner `0.00` before and after | green | drop the owner-origin filter ⇒ `600.00` before |
| O8 (control) | `recoverFromPay` with no payroll ⇒ still `2000.00` (not freed) | green | counting reclass entries as recoveries |
| U1–U4 | `fifoOwnerOutstanding` unit cases mirroring O3–O6 with literal line arrays, plus a reversal of the reclass itself (credit with `reversalOf` = the reclass) ⇒ `0.00` without touching a staff charge | n/a | same mutants as above |
| C1 | `parseBusinessDate('2026-02-30')`, `'2026-04-31'`, `'2026-02-29'`, `'2100-02-29'` each throw `Invalid business date: <v>` | returns | delete the day-of-month check |
| C2 (control) | `'2024-02-29'`, `'2000-02-29'`, `'2026-02-28'`, `'2026-12-31'`, `'2026-01-31'` parse to themselves | green | leap rule without the `%400` clause (`2000-02-29` refused) or `Date.UTC` round-trip on `'0004-02-29'` (add it as a control) |
| C3 | T-360 D3 and D13 (`t360-attendance-shiftday-parse.test.ts:186,385`) stay green **after step 4 is deleted**. Run them before and after, and record both | green | delete step 3's catch |
| P1 | `maxPayoutGapDays` literal table: semi 15 / fixed `[10,25]` ⇒ 16. Fixed `[10]` ⇒ 31. Fixed `[10,20]` ⇒ 21. Lag cutoff 15 ⇒ 16. Lag cutoff 10 ⇒ 21. Monthly lag ⇒ 31 | n/a | off-by-one in the month roll |
| P2 | T-332's `listFindings` legs stay green with the moved function (the B1 detail still carries the measured number) | green | the detector keeps a private copy |
| S1 | `supersedeConfig` semi_monthly / fixed_days / `[10]` ⇒ `userMessage === SEMI_MONTHLY_TWO_DAYS`. Live row unchanged and no new row | saves | remove the count check (the gap check alone would fire with the gap sentence instead: assert the exact sentence) |
| S2 | `[10,10]` passed directly (bypassing `parseIntList`) ⇒ the same sentence | saves | check `cardinality` only, not distinctness |
| S3 | `[10,27]` ⇒ `semiMonthlyGap(17)` | saves | `<` instead of `≤` against 16 |
| S4 | Lag mode, cutoff 10 ⇒ `semiMonthlyGap(21)` | saves | gate the gap check on `fixed_days` only |
| S5 | Merged-row: live row fixed_days `[10,25]`, monthly. A change of only `payrollPeriodType: 'semi_monthly'` with `payoutDays: [10]` ⇒ refused. The check runs on the merged row | saves | validate `changes` instead of the merged row |
| S6 (controls) | `[10,25]`, `[15,30]`, `[16,31]`, and lag cutoff 15 all save. `monthly` + `[10]` saves (out of the rule) | green | any over-refusal |
| D1 | Raw insert of live semi_monthly / fixed_days / `[10]` ⇒ 23514 on `store_attendance_config_semi_monthly_two_days_check`. `errorMessage` ⇒ the mapped sentence | inserts | drop the CHECK |
| D2 (controls) | The same row with `superseded_at` set inserts. A bogus `payout_mode` still reports `payout_mode_check`. The existing `fixed_days_needed_check` row still isolates | green | `= 'lag'` form of the CHECK |
| W1 | `updateAttendanceConfigAction` with `payoutDays = "10, 2 5"` redirects with `error` = `SEMI_MONTHLY_TWO_DAYS` | `ok` | action pre-filters |
| W2 (control) | `"10,25"` ⇒ `ok` banner | green | none |

Record every "Today" column by running the leg red first on the unmodified tree.

## Production precheck — READ-ONLY, gates the S3 deploy (orchestrator or Ian runs it; nothing is written)
Run it on `159.223.46.224` (the `shareat-erp` database), **never** on `159.223.78.207`. No build on the droplet.

```sql
BEGIN READ ONLY;
-- A. Live rows the new CHECK would refuse. MUST be 0 rows, or the migration fails at deploy.
select s.name, s.is_active, c.store_id, c.effective_from, c.semi_monthly_cutoff_day, c.payout_days
  from store_attendance_config c join stores s on s.id = c.store_id
 where c.superseded_at is null and c.payroll_period_type = 'semi_monthly' and c.payout_mode = 'fixed_days'
   and not (cardinality(c.payout_days) = 2 and c.payout_days[1] <> c.payout_days[2]);
-- B. Every live semi_monthly cadence, to run through maxPayoutGapDays offline (R7: lag stores with cutoff ≠ 15/16).
select s.name, s.is_active, c.semi_monthly_cutoff_day, c.payout_mode, c.payout_lag_days, c.payout_days
  from store_attendance_config c join stores s on s.id = c.store_id
 where c.superseded_at is null and c.payroll_period_type = 'semi_monthly';
-- C. Superseded rows that would have violated (information only: exempt by design).
select count(*) from store_attendance_config
 where superseded_at is not null and payroll_period_type = 'semi_monthly' and payout_mode = 'fixed_days'
   and not (cardinality(payout_days) = 2 and payout_days[1] <> payout_days[2]);
ROLLBACK;
```

- The open `payoutIntervalTooLong` findings on `/findings` are a cross-check for B (active stores only).
- If A is not empty, Ian picks the two days per store (Q2). They are saved through `/settings/attendance` before the
  migration ships. There is no data surgery.

## Smoketest on http://localhost:9008 (after S3 and S1; stop the dev server before any build)
1. `/settings/attendance`: semi-monthly, fixed days, payout days `10` → **Save** shows the two-days sentence.
   Reload: the policy is unchanged.
2. Payout days `10,27` shows the 17-day sentence. Lag mode with cutoff `10` shows the 21-day sentence.
3. Positive control: `10,25` with cutoff 15 shows *"Saved. The new policy takes effect from …"*. Then `/findings`
   has no `payoutIntervalTooLong` for that store.
4. `/reports/cash-flow?from=2026-02-30` fails with `Invalid business date`, not the generic database sentence.
   `?from=2024-02-29` renders.
5. On an owner who holds a role:
   1. Record a repayable charge.
   2. Use **Recover from pay** and note the drawn amount on `/owners` (unchanged).
   3. Post a pay run on `/payroll` that covers that person.
   4. `/owners` now shows the drawn amount reduced by the recovered sum.
   5. Void the run: the drawn amount returns.
- Screenshot each step.

## Out of scope (file as DEFs at approval if not already)
- The regex-only date checks at `commissary/orders.ts:353` and `statutory-discounts/page.tsx:32`. They should call
  `parseBusinessDate`.
- `parseIntList` silently dropping tokens and sorting away the order `25,10`. The refusal now catches the collapse
  it causes, but the silent drop remains.
- A `fixed_days` cadence whose cutoff pays periods out of order (cutoff 5, days `[10,25]`). The gaps are ≤ 16, so
  neither the detector nor this task sees it.
- Refusing `monthly` or `weekly` cadences.
- A per-origin allocation inside payroll itself.

## Done when
- Every leg above is recorded red-then-green (controls green throughout). Each mutant was applied, observed red,
  and reverted.
- Precheck A = 0 on production, and B was reviewed, **before** the S3 migration deploys.
- Migration applied on a scratch DB per ADR-012 §5.8. The journal test is green.
- Full gates green: typecheck, lint, unit, integration.
- Smoketest screenshots are attached.
- Register rows DEF-108, DEF-494 and DEF-409 are marked fixed with commit hashes. The DEF-409 row notes the
  `parseIntList` and `25,10` corrections.
- A bible §13 row is added for Ian's DEF-409 ruling and for R1 (FIFO attribution).

## Questions only Ian can answer
- **Q1 (non-blocking; the default is FIFO, per R1).** When payroll recovers part of a person's advances, is the
  oldest debt repaid first, even if the oldest is an owner's reclassified drawing? The alternatives are owner-last
  or owner-first, and each leaks one way (R1).
- **Q2 (blocks S3 deploy only if precheck A or B is non-empty).** For each listed store, which two payout days
  should it use, and which cutoff for a lag-mode store? R7 refuses a semi-monthly lag cutoff other than 15 or 16.

## Amendment A1 — Ian's Q1 (2026-09-30, orchestrator)
**Q1 → ok.** Oldest-debt-first attribution across the person's 1230 ledger stands; a voided pay run restores the cap it freed.
