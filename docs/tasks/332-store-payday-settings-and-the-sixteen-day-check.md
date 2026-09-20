# T-332 — the payday settings Ian asked for already exist; what is missing is the row and the check

**Status:** ⭐ **SPECCED 2026-09-20 by the orchestrator (`system32-df`), NOT BUILT.** Ordered by Ian
the same night: *"create a doc on store settings where admin define the date of paydays."*
**Migration slot:** ⛔ **decide at build time — §4.2 turns on whether a backfill is a migration.**
**Depends on:** nothing. ⚠️ **T-187 is its best data source but is NOT a prerequisite** — §5.

> ⛔ **READ THIS FIRST, BECAUSE IT CHANGES THE ORDER.** Ian asked for a screen where an admin
> defines paydays. **That screen exists.** `/settings/attendance` already edits a per-store,
> effective-dated pay cycle, shipped under T-189c/T-189d. Building it again would have been days
> spent re-creating something already in the repo. This task is what is actually missing, and it is
> smaller and more useful. ⭐ **Side with the project, and say plainly that you did** — RULES §4.

---

## 1. What already exists — measured, not assumed

A read-only census (`webapps-17`, 2026-09-20) found the payday model already built:

| Thing | Where |
|---|---|
| The per-store settings mechanism | **`store_attendance_config`** (`packages/db/schema/attendance-config.ts`) — effective-dated, one live row per store. ⛔ **NOT on `stores`**, which has no JSON or settings column |
| The payday policy itself | `payrollPeriodType` (monthly/semi_monthly/weekly) · `semiMonthlyCutoffDay` (CHECK 1..27, default 15) · `payoutMode` (lag/fixed_days) · `payoutLagDays` · `payoutDays` |
| The derivation | `packages/domain/src/payroll/periods.ts` — `derivePeriods`, `tilesTheMonth`, `periodForDate`, `payoutDateFor` |
| The admin screen | **`/settings/attendance`** → `updateAttendanceConfigAction`, capability `manage_store_settings`, store-scope, **admin and manager** |
| The clock | `packages/db/src/repo/sql-time.ts` — `MANILA_TODAY`, Postgres-side. Business dates are `YYYY-MM-DD` strings, never a round-tripped `Date` |

⭐ **So Ian's instruction is already satisfied on its face** — the same shape as row 222's *"turn on
the service charge"*, where the measurement was that there was nothing to turn on.

## 2. ⭐ The measurement that decides this task

Bible row 223 cautions that *"a month with a 31st can stretch a semi-monthly gap to 16-17 days."*
That was a hypothesis. `webapps-17` **ran the repo's own unmodified `derivePeriods` and
`payoutDateFor`** across 2026 (non-leap) and 2028 (leap), on the schema's real defaults
(semi_monthly, cutoff 15, lag, lag-days 0):

| Cadence | Max gap | Verdict against RA 11360's sixteen-day ceiling |
|---|---|---|
| **semi_monthly** (the default) | **exactly 16 days**, in **7 months of every year** — Jan, Mar, May, Jul, Aug, Oct, Dec, always the 15th to the 31st. Never 17. Leap years identical. | ✅ compliant — **with ZERO slack, seven times a year** |
| **monthly** | 28-31 days, every gap, all year | ⛔ **non-compliant every single month**, smallest gap 12 days over |
| **weekly** | 1-7 days | ✅ compliant, nine days of margin |

⭐⭐ **THE FINDING IS BETTER THAN THE HYPOTHESIS AND POINTS SOMEWHERE ELSE.** Row 223 feared an
overshoot. There is none — the model never reaches 17. **The real exposure is that it sits exactly
ON the ceiling seven months a year, so any slip of one day breaks the statute:** a payout landing
on a weekend or a holiday, an admin running payroll a day late, or `payoutLagDays` ever being
bumped off 0.

⛔ **Therefore "the config already guarantees compliance" is the wrong conclusion to draw from
these numbers, and it is the conclusion they superficially support.** Work out the DIRECTION of the
error before its severity: a gap measured too SHORT is the dangerous direction, and a model that
stops at 16 by construction measures nothing about the day it was actually paid.

⚠️ **`fixed_days` mode was NOT measured** — the census was scoped to the defaults and said so.
**Do not read these numbers as covering it.**

## 3. ⛔ DEF-405 — a brand-new store has NO payday policy at all, and the screen shows nothing

Measured tonight against a freshly bootstrapped throwaway database:

```
bootstrap-org --code=SMOKE_ORG ... --store-code=SMK --confirm   -> store created
select count(*) from store_attendance_config                    -> 0
/settings/attendance rendered signed-in                         -> a store picker and NOTHING ELSE
```

`bootstrap-org.ts` creates the organisation, the chart of accounts, 38 expense categories, 12
fiscal periods, the first admin, the store and its default room — **and no attendance config.**
⛔ **Column defaults do not save this: a default needs a ROW, and there is no row.** So the first
store of a new organisation has no pay cycle, `payoutDateFor` has nothing to derive from, and the
screen an admin would use to fix it renders empty because it edits a row that does not exist.
⚠️ **This is the state production is in if `bootstrap-org` is how production's org was made.**
Filed as **DEF-405**.

## 4. Scope

1. ⭐ **`bootstrap-org.ts` creates the live `store_attendance_config` row for the first store**, in
   the same single transaction it already uses, from the schema defaults. ⛔ **And so does whatever
   creates a store through `/admin/stores`** — a store created on day two has the same hole as a
   store created on day one, and fixing only the bootstrap path hides the defect rather than
   closing it. **Find every writer of `stores` before calling this done.**
2. **A backfill for stores that already exist without a config.** Whether that is a migration or a
   one-shot script is the builder's call, **stated in the spec before building** — an applied
   migration is never edited, so this is the decision that cannot be taken back.
3. ⭐ **The detector — the actual point of the task.** A finding, in the shape of those in
   `packages/db/src/repo/findings.ts`, per store, **soft** severity, firing when a store's
   configured cadence cannot satisfy RA 11360. ⛔ **`monthly` is the unambiguous case and §2 proves
   it by measurement** — any store on `payrollPeriodType = 'monthly'` is non-compliant every month.
   **Fire on that outright.** Follow `grniNotAtRest`'s per-store shape, which
   `serviceChargeFloatAgeing` is being regrouped onto under T-187.
4. **A store with NO live config is itself a finding** — the DEF-405 state made visible rather than
   silent, so the backfill can be verified from the app instead of from SQL.

## 5. Out of scope, and the second half that is deliberately not here

- ⛔ **Building a payday settings screen.** It exists. §1.
- ⛔ **Changing `semiMonthlyCutoffDay`'s CHECK, the enum values, or any default.** Ian ruled the
  business runs a 15-day cycle and the default already encodes it.
- ⛔ **Modelling weekends or holidays.** Real, and the thing that turns 16 into 17 — but it is a
  calendar capability this repo does not have, and inventing one inside a compliance detector is
  how a detector acquires a second source of truth about what a working day is.
- ⭐ **THE DETECTOR THIS TASK CANNOT BUILD, NAMED SO NOBODY THINKS IT DID.** §2 shows the exposure
  is the distance between the MODELLED payout date and the REAL one. Nothing in the repo records a
  real payout date today. **T-187 is the first thing that will** — it records the date a store's
  service-charge float was actually discharged. Once T-187 has shipped and produced data, the
  honest detector is *"did the real payout land more than sixteen days after the previous real
  payout"*, and **that is a later task, not this one.** ⛔ Do not stub it here. This task ships the
  config-level check, which is the half that can be true today.

## 6. Done when

Every §9 gate, including **§9.4 in a real browser — which is now possible** (see
`docs/tasks/187-service-charge-distribution.md` §10 and `docs/HANDOFF-TODAY.md`): a signed-in
session can be minted locally against a throwaway database and driven headless.

⛔ **Plus two specific to this task:** a freshly bootstrapped store must come up with a live config
and a populated `/settings/attendance`, **shown on screen, not asserted**; and a store set to
`monthly` must produce the finding while a `semi_monthly` store produces none.
