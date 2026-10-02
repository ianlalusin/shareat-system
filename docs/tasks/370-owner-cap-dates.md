# T-370: owner drawing cap after payroll (and its concurrency, DEF-516), real calendar dates, and a semi-monthly pay cycle refused on save — DEF-108, DEF-494, DEF-409

**Status:** **S1 DONE (`42da29b`), S2 DONE (`85eb34e`); S3b DONE 2026-10-02 (A3, DEF-553 payout half); S3 DONE 2026-10-02 (DEF-409, migration 0178, A4 canonical gap); S1 screen test (owner cap) still unmet: needs payroll seeding; monthly-floor question open** — APPROVED 2026-09-30 (orchestrator, after independent Opus review) — review changes 1–11 applied in place. Spec by the Opus planner, 2026-09-30. **Model:** Sonnet, tester then
builder, per slice.
**Census:** `docs/plans/money-defects-2026-09-30.md` (batch E). DEF-409 was added by Ian's ruling of 2026-09-30:
*"refuse on save: semi-monthly needs exactly two pay days ≤16 days apart."*
**Migration:** one, in S3 only: **0178** (orchestrator, 2026-10-02 — S3 lands before T-372 S6, which moves to 0179). Follow ADR-012 §5.
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
  - ⛔ **Integer centavos via `@shareat/core/money` (`toCentavos` / `fromCentavos`), never `Number`.** The existing
    `Number(row.total).toFixed(2)` return is replaced by `fromCentavos`.
  - `packages/domain/src/shared/allocate-oldest-first.ts` is not reused: it is keyed on a nullable DUE DATE for AP/AR
    items and lives in domain (unreachable from a repo); this pool is keyed on posting order.
- **R3a (DEF-516, folded in): the cap read is serialised.** `recordDrawing` reads `drawnInWindow` with no lock
  (`owners/index.ts:289`, via `judgeDrawingLimit`), so two concurrent drawings both pass the cap.
  - Before the cap read, lock the owner row with a new repo `lockOwnerForUpdate(tx, orgId, ownerId)`
    (`select … from owners where … for update`).
  - The app role keeps UPDATE on `owners`: the repo already updates it (`owners.ts:104`) and 0170 does not revoke it.
    The tester asserts `has_table_privilege('shareat_app','owners','UPDATE')`, so a later revoke fails loudly.
  - ⚠️ Two owner rows of one person lock separately. They draw against separate caps, so that is correct.
- **R4 (DEF-108): `closeDrawingMonth` / `closeableMonth` / `owners/lib.ts:78` inherit the change deliberately.** A
  payroll recovery in month M lowers M's ledger amount, exactly as `repayFromOwner` in M already does. No other
  caller changes.
  - Other `1230` credits join the pool too: final pay (`packages/domain/src/payroll/separation.ts:181`) and the
    13th-month payout (`packages/domain/src/payroll/thirteenth-month.ts:198`).
  - ⭐ **Orchestrator ruling (2026-09-30): ACCEPTED.** FIFO re-attribution can move an owner's DERIVED drawn figure
    for an already-closed month, because a later credit re-orders which charge it consumed. It changes no posted
    entry, and `assertMonthOpen` still guards every drawing into a closed month.
- **R5 (DEF-494): fix core and delete the local copy.**
  - `parseBusinessDate` checks `d ≤ daysInMonth(y, m)` using **pure integer arithmetic**:
    - Month lengths come from a table.
    - Leap year = `(y%4===0 && y%100!==0) || y%400===0`.
    - Refuse `y < 1`: Postgres has no year 0 (`'0000-01-01'::date` is 22008).
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
      OR (cardinality(payout_days) = 2 AND coalesce(payout_days[1] <> payout_days[2], false))
    ```

    - Name: `store_attendance_config_semi_monthly_two_days_check`.
    - Superseded rows are history. They governed real days and are never rewritten. The exemption also lets a
      violating live row be retired by the ordinary supersede UPDATE.
    - `coalesce(…, false)` closes the NULL hole: with `ARRAY[10,NULL]` the `<>` is NULL, and a CHECK passes on NULL.
      It also refuses an array whose lower bound is not 1 (`[1]` or `[2]` reads NULL there).
    - **Migration: a plain, validated `ADD CONSTRAINT`, never `NOT VALID`.** Precheck A = 0 gates it and the table is
      tiny, so the validating scan costs nothing. `NOT VALID` would leave violating rows for the next UPDATE to trip on.
    - `payout_mode <> 'fixed_days'`, not `= 'lag'`: a bogus mode must still trip only `payout_mode_check`
      (`constraint-message-lookup.test.ts:237` isolates it that way).
- **R7 (DEF-409): the spacing rule applies to `lag` mode too.**
  - Ian's ruling names the interval. A semi_monthly lag store with cutoff 10 pays 21 days apart
    (Jan 10 → Jan 31), and the detector already flags it.
  - In lag mode this admits only cutoff 15 or 16. The precheck (below) says whether any live store is affected
    before this ships.
  - ⚠️ **A store already out of line is refused on ANY settings save**, even one that changes only an unrelated
    field such as grace minutes, until its cadence is fixed. The rule is judged on the merged row. That is intended:
    the screen shows the sentence, and the admin fixes the cadence in the same save. Leg S7.
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
- **One lane database per slice.** S3's lane DB carries the migration.
- No lane edits a shared test helper. Copy fixtures into each test file.
- Register and bible edits are the orchestrator's, never a lane's.
### S1 — DEF-108 owner cap
- **BUILDER:**
  - `packages/db/src/repo/owners.ts`: `drawnInWindow` per R2/R3, `fifoOwnerOutstanding`, and the comment block
    `:219-231` rewritten.
  - `packages/domain/src/owners/index.ts`: JSDoc at `:357` and `:413-424`. `recordDrawing` calls
    `lockOwnerForUpdate` before `judgeDrawingLimit` (R3a).
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
  - `apps/erp/tests/constraint-messages.test.ts:170` and
    `apps/erp/tests/integration/constraint-message-lookup-mechanism.test.ts:130`: `CONSTRAINT_MESSAGES` goes from 26 to
    27 keys, which widens the `/setup` `WRITTEN_FOR_A_PERSON` allowlist. **This is deliberate:** the new sentence is
    written for a person and names no configuration. Record that in both tests' comments.
  - `apps/erp/tests/integration/t370-settings-attendance-web.test.ts` (new).
- **Contract:** `maxPayoutGapDays(...)` returns an integer number of days, the largest gap between consecutive
  distinct payout dates across 12 months. `supersedeConfig` is unchanged in signature and throws a presentable
  refusal.

## Invariants
1. When no older non-owner `1230` charge is outstanding, a payroll recovery frees the cap exactly as `repayFromOwner`
   of the same amount on the same date would, for both `monthly` and `total` windows. With an older staff charge
   outstanding, FIFO consumes that first (R1) (R2; `owners/index.ts:354-358`).
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
| O1 | Owner with an active role and a monthly limit of 5000. A repayable ₱2000 charge on 2026-01-10. `recoverFromPay` ₱2000 on 01-20. `postPayRun` whose payslip recovers ₱2000, entry 2026-02-05. Assert `drawnInWindow` total = `0.00`, Jan = `2000.00`, Feb = `-2000.00` (the same three numbers a `repayFromOwner` on 02-05 gives, asserted side by side in a twin fixture that does NOT call `recoverFromPay`: after a reclass `1260` is 0, and `assertWithinReceivable` refuses the repayment) | total `2000.00` | restore the `source_id`-only scope |
| O2 | O1, then `voidPayRun`. Total back to `2000.00` | n/a | ignore `reversal_of_entry_id` (the void debit treated as a new staff charge ⇒ owner stays 0) |
| O3 | Reclass ₱1000 on 01-10, staff shortage ₱600 on 01-15 (raw insert, `owners.test.ts:295-306` shape), payroll recovers ₱1000 on 02-05. Owner total `0.00` | `1000.00` | staff-first `min(ownerOrigin, balance)` ⇒ `600.00` |
| O4 | Shortage ₱600 on 01-05, reclass ₱1000 on 01-10, recovery ₱1000. Owner total `600.00` | `1000.00` | owner-first ⇒ `0.00` |
| O5 | Partial recovery ₱500 of a ₱2000 reclass ⇒ `1500.00` | `2000.00` | pool applied as all-or-nothing |
| O6 | One person owns stores A and B. Reclass ₱1000 (A, 01-10), then ₱700 (B, 01-12). Recovery ₱1200. A = `0.00`, B = `500.00`, sum = the person's `1230` balance | A 1000, B 700 | count the whole balance per owner ⇒ A `500`, B `500`, or the sum exceeds the balance |
| O7 (control) | Staff shortage ₱600 only, then recovery ₱600. Owner `0.00` before and after | green | drop the owner-origin filter ⇒ `600.00` before |
| O8 (control) | `recoverFromPay` with no payroll ⇒ still `2000.00` (not freed) | green | counting reclass entries as recoveries |
| U1–U4 | `fifoOwnerOutstanding` unit cases mirroring O3–O6 with literal line arrays, plus a reversal of the reclass itself (credit with `reversalOf` = the reclass) ⇒ `0.00` without touching a staff charge | n/a | same mutants as above |
| C1 | `parseBusinessDate('2026-02-30')`, `'2026-04-31'`, `'2026-02-29'`, `'2100-02-29'`, `'0000-01-01'` each throw `Invalid business date: <v>` | returns | delete the day-of-month check |
| C2 (control) | `'2024-02-29'`, `'2000-02-29'`, `'0004-02-29'`, `'0001-01-01'`, `'2026-02-28'`, `'2026-12-31'`, `'2026-01-31'` parse to themselves | green | leap rule without the `%400` clause (`2000-02-29` refused) or `Date.UTC` round-trip on `'0004-02-29'` (add it as a control) |
| C3 | T-360 D3 and D13 (`t360-attendance-shiftday-parse.test.ts:186,385`) stay green **after step 4 is deleted**. Run them before and after, and record both | green | delete step 3's catch |
| P1 | `maxPayoutGapDays` literal table: semi 15 / fixed `[10,25]` ⇒ 16. Fixed `[10]` ⇒ 31. Fixed `[10,20]` ⇒ 21. Lag cutoff 15 ⇒ 16. Lag cutoff 10 ⇒ 21. Monthly lag ⇒ 31. Fixed `[15,30]` cutoff 15 ⇒ 31 by hand-trace (Jan 16–31 and Feb 16–28 both pay Feb 28; Jan 15 → Feb 15 is 31); the tester records the measured value | n/a | off-by-one in the month roll |
| P2 | T-332's `listFindings` legs stay green with the moved function (the B1 detail still carries the measured number) | green | the detector keeps a private copy |
| S1 | `supersedeConfig` semi_monthly / fixed_days / `[10]` ⇒ `userMessage === SEMI_MONTHLY_TWO_DAYS`. Live row unchanged and no new row | saves | remove the count check (the gap check alone would fire with the gap sentence instead: assert the exact sentence) |
| S2 | `[10,10]` passed directly (bypassing `parseIntList`) ⇒ the same sentence | saves | check `cardinality` only, not distinctness |
| S3 | `[10,27]` ⇒ `semiMonthlyGap(17)` | saves | `<` instead of `≤` against 16 |
| S4 | Lag mode, cutoff 10 ⇒ `semiMonthlyGap(21)` | saves | gate the gap check on `fixed_days` only |
| S5 | Merged-row: live row fixed_days `[10,25]`, monthly. A change of only `payrollPeriodType: 'semi_monthly'` with `payoutDays: [10]` ⇒ refused. The check runs on the merged row | saves | validate `changes` instead of the merged row |
| S6 (controls) | `[10,25]`, `[5,20]`, `[16,31]`, and lag cutoff 15 all save. `monthly` + `[10]` saves (out of the rule) | green | any over-refusal |
| D1 | Raw insert of live semi_monthly / fixed_days / `[10]`, and again with `ARRAY[10,NULL]`, each ⇒ 23514 on `store_attendance_config_semi_monthly_two_days_check`. `errorMessage` ⇒ the mapped sentence | inserts | drop the CHECK |
| D2 (controls) | The same row with `superseded_at` set inserts. A bogus `payout_mode` still reports `payout_mode_check`. The existing `fixed_days_needed_check` row still isolates | green | `= 'lag'` form of the CHECK |
| W1 | `updateAttendanceConfigAction` with `payoutDays = "10, 2 5"` redirects with `error` = `SEMI_MONTHLY_TWO_DAYS` | `ok` | action pre-filters |
| W2 (control) | `"10,25"` ⇒ `ok` banner | green | none |
| S7 | A live row made non-compliant by raw insert (lag, cutoff 10, which the CHECK allows). `supersedeConfig` changing only `lateGraceMinutes` ⇒ `semiMonthlyGap(21)`; nothing written | saves | judge only the changed fields |
| S7c (control) | The same store and save, plus `semiMonthlyCutoffDay: 15` ⇒ saves | n/a | none |
| X1 | DEF-516, two connections. Monthly cap 5000, ₱3000 already drawn. Both call `recordDrawing` for ₱1500 concurrently (a barrier holds A's transaction open after its cap read). Exactly one commits; the other is refused with the limit sentence; drawn = `4500.00` | both commit (`6000.00`) | remove `lockOwnerForUpdate` |
| X1c (control) | The same, sequential: ₱1500 then ₱500 both commit. `has_table_privilege('shareat_app','owners','UPDATE')` is true | green | revoke UPDATE ⇒ 42501 |

Record every "Today" column by running the leg red first on the unmodified tree.

## Production precheck — READ-ONLY, gates the S3 deploy (orchestrator or Ian runs it; nothing is written)
Run it on `159.223.46.224` (the `shareat-erp` database), **never** on `159.223.78.207`. No build on the droplet.

```sql
BEGIN READ ONLY;
-- A. Live rows the new CHECK would refuse. MUST be 0 rows, or the migration fails at deploy.
select s.name, s.is_active, c.store_id, c.effective_from, c.semi_monthly_cutoff_day, c.payout_days
  from store_attendance_config c join stores s on s.id = c.store_id
 where c.superseded_at is null and c.payroll_period_type = 'semi_monthly' and c.payout_mode = 'fixed_days'
   and not (cardinality(c.payout_days) = 2 and coalesce(c.payout_days[1] <> c.payout_days[2], false));
-- B. Every live semi_monthly cadence, to run through maxPayoutGapDays offline (R7: lag stores with cutoff ≠ 15/16).
select s.name, s.is_active, c.semi_monthly_cutoff_day, c.payout_mode, c.payout_lag_days, c.payout_days
  from store_attendance_config c join stores s on s.id = c.store_id
 where c.superseded_at is null and c.payroll_period_type = 'semi_monthly';
-- C. Superseded rows that would have violated (information only: exempt by design).
select count(*) from store_attendance_config
 where superseded_at is not null and payroll_period_type = 'semi_monthly' and payout_mode = 'fixed_days'
   and not (cardinality(payout_days) = 2 and coalesce(payout_days[1] <> payout_days[2], false));
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
  should it use, and which cutoff for a lag-mode store? R7 refuses a semi-monthly lag cutoff other than 15 or 16,
  and until a listed store is fixed, EVERY settings save for it is refused (R7, leg S7).

## Amendment A1 — Ian's Q1 (2026-09-30, orchestrator)
**Q1 → ok.** Oldest-debt-first attribution across the person's 1230 ledger stands; a voided pay run restores the cap it freed.

## Amendment A2 — business-date range (2026-09-30, orchestrator, after the S2 audit)
The S2 audit measured that the date helpers are only correct inside a bounded range: below 1582 `zoneOffsetMs`
reads ICU's Julian-calendar parts as proleptic Gregorian (`businessDayRange('0004-02-29').start` lands on the 29th
at 15:56Z, day wrong), and `9999-12-31` rolls `addDays` into year 10000, where `toISOString()` switches to expanded
years and `shiftDayRange` throws a raw `RangeError` with no sentence. **Ruling: `parseBusinessDate` accepts years
1900–2999 only** (the refusal sentence is the existing semantic-branch one). C2's `0004-02-29` / `0001-01-01`
controls become refusals; new controls `1900-01-01` and `2999-12-31` parse, `1899-12-31` and `3000-01-01` refuse.
D2 asserts the full `.start` instant, not only its year. `reports/cash-flow.ts` also parses `toDate` (page.tsx:44 and
export/route.ts:11 pass it raw today — same class as DEF-514).

## Amendment A3 — Ian's 15/30 ruling (2026-10-01)
**Ruling (Ian, chat, Open Questions page):** SUPPORT a semi-monthly store paying on the 15th and the 30th. The second
half (16th–end) is paid on the 30th — or the month's last day in February — even when the half ends on the 31st (the
31st is paid with it). This closes the payout half of DEF-553 (`payoutDateFor`, `payroll/periods.ts:157-172`, "on or
after the end", rolls a day-30 payday of a 31-day month to the NEXT month's 30th: Jan 16–31 and Feb 16–28 both pay
Feb 28, Mar 16–31 and Apr 16–30 both pay Apr 30; the store goes 31 days between paydays).

**Slice: S3b — its own slice and commit, landing BEFORE S3's builder commit, same lane.** Not folded into S3 because:
it is a different defect (DEF-553, not DEF-409); it changes a shipped payday a person reads on `/payroll`, so it must
be revertable on its own; and S3 carries a migration and a deploy precheck that S3b does not. It goes first so that
S3's P1 table and S6 controls are written once against the final rule (see "S3 edits" below), not pinned to 31 and
re-pinned.

### R10 — the rule (the narrowest one that makes 15/30 pay inside its own month)
In `fixed_days` mode only, after `wanted` is chosen (`periods.ts:159`), and before the two-candidate loop:

> **If `wanted === 30`, the period ends on day 31, and the period starts on or before day 30, the payday is the 30th
> of the period's own month.** Otherwise the existing "on or after the end" loop runs unchanged.

- This is the ONLY case in which a payday falls before its period ends: same month, by exactly one day, and only the
  31st is not yet worked on payday. The period itself does not change: `derivePeriods` is untouched, the half still
  runs 16–31, and the 31st's attendance belongs to it (`tilesTheMonth` stays true).
- February and 30-day months need no new code: 30 already clamps to the 28th/29th (`:168`) and that date equals the
  period end, so the loop returns it in-month today. April 16–30 pays Apr 30 today and after.
- The start guard exists because `derivePeriods` is pure and clamps a cutoff to `last − 1` (`:78`): a cutoff of 30
  in a 31-day month gives a 31–31 period, and day 30 is BEFORE that period starts, so it keeps today's roll. The DB
  holds the cutoff to 1–27 (`attendance-config.ts:316-320`), so this is reachable only from a pure caller.
- **It is keyed on the day, not the period type**, because `payoutDateFor` has no period type and the old behaviour
  is equally wrong elsewhere: monthly `[30]` pays January AND February on Feb 28 and then nothing until Apr 30
  (61 days); a weekly store's last window 29–31 with day 30 rolls a month. Both now pay on the 30th. Ian ruled for
  semi-monthly; see "Still Ian's" below.
- **Does NOT change:** lag mode (any cutoff, any lag); `payoutDays` of 1–29 (a 29 in a 31-day month still rolls to
  next month's 29th — not generalised to "within N days of the end"); day 31 (clamps to month end = period end,
  already in-month); day 30 for any period ending on or before the 30th; first periods (they end at the cutoff,
  never on the 31st); the cutoff's meaning; `derivePeriods`, `periodForDate`, `tilesTheMonth`; `[15,31]` (pays the
  15th and the month's last day, as today).
- Update the docblock table row (`:138`) to: *"the next occurrence of this period's day, on or after the end — except
  day 30 for a period ending on the 31st, which pays on the 30th (Ian, 2026-10-01, A3)."*

### Callers (all read-only consumers; none needs an edit for S3b)
| Caller | Effect |
|---|---|
| `apps/erp/src/app/payroll/page.tsx:209` (`payable …` label, via `payroll/lib.ts:19`) | Shows 01-30 instead of 02-28 for a [15,30] store's Jan 16–31 run. Display only |
| `packages/domain/src/findings/index.ts:128-129` (`payoutIntervalFindings`) | A [15,30] store's measured gap drops 31 → 16. S3 replaces this loop with `maxPayoutGapDays`; the window-edge half of DEF-553 (12-month window, 46 vs 31) stays S3's (13 months + in-window filter), unchanged by S3b |
| `maxPayoutGapDays` (S3, R8) and `supersedeConfig`'s gap refusal (S3) | `[15,30]` measures 16 ⇒ ACCEPTED on save. Invariant 6 holds: it is also silent in the detector |
| `apps/erp/src/app/attendance/lib.ts:66`, `payroll/lib.ts:88` | `derivePeriods` only — unaffected |
| `postPayRun` (`payroll/index.ts:415`) | Not a caller: the entry is dated `input.entryDate ?? input.periodEnd`. No pay-run row stores a payout date, so no posted run pins the old behaviour and nothing is backfilled |

### Posting impact — none
`payoutDateFor` is on no posting path. `postPayRun` posts salaries expense / `1230` recovery / money account at
`entryDate ?? periodEnd` (`payroll/index.ts:415,454-472`); `docs/POSTING-PATTERNS.md` has no pay-run pattern
beyond `salary_advance.repayment` (`:310-324`), which this does not touch. Consequence to state, not to build: a
16–31 run is still computed from attendance through the 31st and dated the 31st, so the cash a store hands over on
the 30th lands in the ledger one day later, and a run posted ON the 30th would see no attendance for the 31st (no
guard refuses posting before `periodEnd` today). That is operational, not S3b's — see "Still Ian's".

### v1 (requirements only)
v1's staff payroll has no fixed payday at all (lag is "v1's only model", `periods.ts:132-146`); its slicer payout
refuses a payout date before the work period ends (`ERP-rebuild src/lib/inventory/slicer-payment.ts:269-276`).
R10 is a deliberate, ruled departure from that "never before the end" requirement: one day, day 30 only.

### BUILDER
- `packages/domain/src/payroll/periods.ts` — R10 in `payoutDateFor` + the docblock row. Nothing else.

### TESTER (red first on the unmodified tree; record "Today")
New `packages/domain/tests/t370-s3b-payday-30.test.ts` (pure unit):

| Leg | Setup → assertion (target) | Today | Mutant that must turn it red |
|---|---|---|---|
| B1 | `semi(15)`, `fixed([15,30])`, 2026: Jan ⇒ `[01-15, 01-30]`, Feb ⇒ `[02-15, 02-28]`, Mar ⇒ `[03-15, 03-30]`, Apr ⇒ `[04-15, 04-30]` | Jan/Mar second = 02-28 / 04-30 | restore "on or after the end" |
| B2 | Same, 2028 (leap): Feb ⇒ `[02-15, 02-29]` | green | clamp to 28 regardless of leap |
| B3 | Same config, 12 months from Jan 2026: 24 DISTINCT paydays (no two periods share a date), every gap ≤ 16, max exactly 16 | fewer distinct, max 31 | restore the old loop |
| B4 | The 31st is in the 30th's run: the Jan second period is `01-16..01-31` and its payday is `01-30`; `tilesTheMonth` true for all 12 months | payday 02-28 | "fix" by ending the period on the 30th (moves the 31st to the next run) |
| B5 (controls) | `[10,25]`: Aug second ⇒ `09-25` (✎ tester, 2026-10-01: index 1 is 25). Monthly `fixed([10])` Jan ⇒ `02-10`. `[15,31]` Jan ⇒ `01-31`, Feb ⇒ `02-28`. `[15,29]` Jan second ⇒ `02-28` (29 clamps to Feb's last day, rolled — unchanged). Apr `[15,30]` second ⇒ `04-30`. Lag 0 Jan second ⇒ `01-31` | green | widen to "wanted ≥ 29" or "≤ 2 days before the end" |
| B6 | Pure `semi(30)` 2026-01 (periods 1–30, 31–31), `fixed([15,30])`: second payday ⇒ `02-28` (never before its period STARTS) | green | drop the start guard ⇒ `01-30` |
| B7 | Monthly `fixed([30])`: Jan ⇒ `01-30`, Feb ⇒ `02-28`, Mar ⇒ `03-30`; 12 distinct paydays in 12 months | Jan ⇒ 02-28 (collision) | gate R10 on `semi_monthly` |
| B8 | Weekly `fixed([5,5,5,5,30])`, Aug 2026 window 29–31 (index 4) ⇒ `08-30` | `09-30` | same as B7 |

### S3 edits (S3's tester owns them; S3 is not built yet, so nothing green is reversed)
- `packages/domain/tests/t370-max-payout-gap.test.ts:69-73` — the `[15,30]` row: `expected: 31` → **16**; drop the
  "for Ian to rule" note (ruled). Its P1 sanity leg turns red until S3b lands (the reference loop calls the real
  `payoutDateFor`) — expected; record it. Spec P1's "Fixed `[15,30]` cutoff 15 ⇒ 31" now reads ⇒ 16.
- `packages/domain/tests/integration/t370-semi-monthly-refusal.test.ts` — S6 controls gain `[15,30]` (saves), and an
  Invariant-6 leg: a live `[15,30]` store raises no `payoutIntervalTooLong` in `listFindings`.
- No other test pins the old behaviour: `periods.test.ts:150-178` uses `[25,10]`, `[31]`, weekly `[5]` (all
  unchanged); `t332-payday-compliance.test.ts` has no day-30 fixture; no findings test uses 30.

**Migration: none.** No column, CHECK or stored value changes; payout dates are always derived, never stored.

### Still Ian's (non-blocking; defaults stated)
- **Monthly / weekly day 30.** Default: R10 applies to them too (B7/B8), because the old behaviour pays two periods on
  one date. Say so if monthly `[30]` should keep rolling.
- **The 31st on the 30th.** Default: the run is still posted after the 31st closes and dated the 31st (cash one day
  later in the ledger than in hand). If the store must post ON the 30th, the 31st needs a rule (paid at schedule and
  trued up next run, or moved to the next half) — a separate task.

- 2026-10-01, Ian (chat): A3 defaults confirmed — monthly [30] also pays on the 30th; a run paid on the 30th is still posted after the 31st and dated the 31st.

## Amendment A4 — the gap measure is start-independent by construction (2026-10-02, orchestrator via Opus planner)
**Defect (auditor; re-verified on the uncommitted tree with the real functions).** `maxPayoutGapDays(p, o, startYear,
startMonth)` sweeps 12 months from `startMonth` with an in-window filter, so its answer moves with the start month.
- **Left edge.** The month before the window pays its 2nd period INTO the window but is never generated. Cutoff 10 +
  `[10,25]` (truth 16) measures **31** from 2026-10, 2027-01 and 2027-03. A legal store is refused and falsely flagged.
- **Leap February.** A window whose only February is 2028 loses the Feb-28 collision. Cutoff 15 + `[13,29]` (truth 31)
  measures **16** from 2027-03, so it is accepted on save and flagged later. Invariant 6 breaks in both directions.
- Brute force (26,937 configs, starts 2026-01..2028-12): 4,842 semi-monthly configs vary by start, and 56 flip the
  >16 verdict. P1's "reference loop" copies the production loop, so it shares the defect and proves nothing.

### R11 — the rule (supersedes R8's start arguments, R8's two "calls it with … month" bullets, and S3's Contract)
- **Signature:** `maxPayoutGapDays(periodCfg: PeriodConfig, payoutCfg: PayoutConfig): number`. It takes no date.
- **Horizon:** it generates every period's payday for months **2027-11 through 2032-03**, distinct and sorted.
  `periodIndex` resets per month, as today.
- **Pairs:** the answer is the largest gap between consecutive distinct paydays `(a, b)` whose **EARLIER date `a`**
  lies in **2028-01-01..2031-12-31**. `b` may fall in 2032.
- **Why four years suffice.** A payday depends on the calendar only through month lengths. From 2001 to 2099 the
  month-length sequence repeats every 48 months (1,461 days), so the payday sequence repeats with it. Taking one
  repeat's worth of left endpoints sees every gap exactly once. Any one gap depends on at most four consecutive
  months, and 2028-2031 contains every such run of months that occurs in a Gregorian year, 2100 included.
- **Why the horizon is complete.** A payday never falls before its own month starts: fixed and lag paydays are on or
  after the period end, and R10's is the end minus 1, which is the 30th. So every payday before 2032-04-01 is
  generated. The successor of any `a` ≤ 2031-12-31 is ≤ 2032-03-02: January 2032 ends on the 31st, the lag is at
  most 31 (`payout_lag_check`), and fixed days pay by the end of the next month. A payday on or after 2028-01-01
  comes from 2027-11 or later, because October's last period end plus 31 days is 2027-12-01.
- ⛔ **Rejected from the proposal: "BOTH ends in 2028-2031".**
  - It drops the pair that straddles 2031-12 → 2032-01, and that pair's periodic copy, 2027 → 2028.
  - The sweep matches today only because the Dec→Jan gap reappears as Jul→Aug. That is a coincidence of month
    lengths, not a guarantee.
  - Anchoring on `a` counts every gap once and needs no such argument.
- **A store's actual history does not matter (ruled).** The rule judges the cadence: R9's sentence says *"can run N
  days"*, not "did run".
  - `effectiveFrom`, Manila today and past config rows are not inputs.
  - A real span shorter than four years can only show a gap ≤ the canonical one.
- **Verified** on all 26,937 configs: semi-monthly cutoffs 1-27, with `[d]`, every ordered distinct pair and lag
  0-31, plus monthly and weekly. R11 equals an independent truth computed over 2026-2045. The maximum is 60
  (monthly `[29]`).

### Callers (BUILDER: these four files only)
- `packages/domain/src/payroll/periods.ts`: R11, with the frame bounds as private named constants. Replace the
  docblock: the "TWELVE months, do NOT fix back to thirteen" paragraph and the window-independence claim are both
  false now.
- `packages/domain/src/findings/index.ts`: `payoutIntervalFindings` calls `maxPayoutGapDays(periodConfig,
  payoutConfig)`.
  - Drop `manilaToday` from its `Promise.all` and drop the start parse.
  - Rewrite the twelve-month and verdict paragraphs of the docblock (`~:66-87`) as one line pointing to R11.
  - Keep the import only if another function in the file still uses it.
- `packages/domain/src/attendance/config.ts`: drop the `effectiveFrom` start parse (`:125`) and call the
  two-argument form. **Merge the duplicate `@shareat/db` import at `:10-11` into one.**
- `apps/erp/src/app/settings/attendance/page.tsx:220`: the hint becomes exactly
  *"Comma-separated day-of-month, required when payout mode is fixed_days. Semi-monthly: two different days, never
  more than 16 days from one payday to the next (the cutoff day changes this), e.g. 10,25 with cutoff 15."*
  - "15–16 days apart" was not the rule. `[13,29]` with cutoff 15 is 16 days apart, yet it runs 31.
  - The real rule is a ceiling on every gap, and the cutoff moves those gaps.
- **Unchanged:**
  - `packages/db/src/repo/findings.ts` and `constraint-messages.ts`.
  - Migration **0178** and its CHECK, which tests two distinct days only and never reads the gap function.
  - `t332-payday-compliance.test.ts`, where only a comment names the function.
  - Precheck B, which now runs through the two-argument form.

### TESTER: `packages/domain/tests/t370-max-payout-gap.test.ts`, `packages/domain/tests/integration/t370-semi-monthly-refusal.test.ts`
`t370-settings-attendance-web.test.ts` is untouched: no test asserts the hint, which is copy only (smoketest step 1
screenshots it).

| Leg | Setup → assertion (target) | Mutant that must turn it red |
|---|---|---|
| T0 | Delete `reference()` and both "every start month" loops. Add `truth(p, o)`, written in the test and NOT a copy of the production loop. It takes paydays for months 2025-11..2046-03 from `derivePeriods`/`payoutDateFor`, distinct and sorted, and returns the largest gap over pairs whose earlier date is in 2026-01-01..2045-12-31. That span holds five leap Februaries and is not phase-aligned to 2028. Sanity check: `truth` reproduces every P1 literal | n/a (it guards the oracle) |
| G1 sweep | Configs: semi-monthly cutoffs 1-27 × every ordered pair `[a,b]` (a≠b, 1-31), and × lag 0-31. Also monthly and weekly, each with `[d]` and with lag 0-31. Assert `maxPayoutGapDays === truth` and name the first mismatch. Memoise `truth` per (cutoff, month, periodIndex, day). This is valid because only `wanted` is read, so `payoutDateFor(period, fixed([d]), 0)` stands for index i of `[a,b]`; say so in a comment. Use `{ timeout: 180_000 }` and record the runtime | (m1) generate from 2028-01, with no earlier months · (m2) restore the 12-month window from 2026-01 · (m4) frame 2029-01..2031-12, which has no leap February |
| P1 | The existing literal table, called without a start, with each row also `=== truth`. Add three rows: cutoff 10 `[10,25]` ⇒ **16**; cutoff 15 `[13,29]` ⇒ **31**; cutoff 15 `[10,27]` ⇒ 17 | off-by-one month roll · m1 turns the cutoff-10 row red · m4 turns the `[13,29]` row red |
| A1 | `expectTypeOf(maxPayoutGapDays).parameters.toEqualTypeOf<[PeriodConfig, PayoutConfig]>()` | keep the start parameters, even as defaulted ones (`.length` would not catch that) |
| N1 | Integration. Cutoff 10 with `[10,25]` **saves** at effectiveFrom 2026-10-15, 2027-01-15 and 2027-03-15, the auditor's failing months. Use one store per month, or chain the saves in date order. A raw-inserted live row with the same config raises no `payoutIntervalTooLong` | m1 / m2 ⇒ refused with `semiMonthlyGap(31)` |
| N2 | Integration. Cutoff 15 with `[13,29]` is refused with `semiMonthlyGap(31)` at effectiveFrom **`YYYY-MM-15` for every month from 2026-01 to 2028-12**: 36 saves on one store. The seed takes effect 2026-01-01, so the 15th is always after it. Afterwards the store's row count is unchanged. A raw-inserted live row with the same config raises `payoutIntervalTooLong` with 31 in its detail | m4 ⇒ the 2027-03-15 save succeeds |

N1 is N2's positive control. Record "Today" for G1, N1 and N2 red on the uncommitted 4-argument tree before the
builder lands. For that run only, call it with (2026, 10) and (2027, 3).
