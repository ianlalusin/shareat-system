# T-201 — the attendance & payroll settings screen

> **Status:** ✅ **BUILT AND COMMITTED 2026-09-01** (`987ec3a`). Smoketested live: save, `/payroll`'s
> summary line picking up the new value, the backdating rejection, and the nullable
> `autoClockOutHour` staying blank. Handoff `docs/HANDOFF-TODAY.md` "Pick up here" item 2.
> Assessed via `/research-evaluate-propose` before writing this — see §1.
> **Depends on:** T-155 (`store_attendance_config` + `supersedeConfig`, both already built and
> integration-tested — this task adds **no new domain code and no migration**), T-189b/c/d (the
> premium/period columns), T-199 (`autoClockOutHour`, `maxShiftHours`).

---

## 1. The verdict, and why

**Build it — small, and 90% already exists.** `packages/domain/src/attendance/config.ts::supersedeConfig`
is fully built: authorized (`manage_store_settings`, itself pre-existing and tested), transactional,
refuses backdating over adjudicated days, integration-tested in
`packages/domain/tests/integration/attendance-config.test.ts`. **Nothing in this task touches the
domain layer or the schema.** The gap is purely a UI: a form that calls a function that already
exists.

**The stated reason** ("all of them need SQL to change") **holds, and it already cost real time**:
T-197 and DEF-119 this week were both single-value policy changes (`shortShiftHalfDayOt`,
`halfDayOnMissingTap`) that needed a full task + migration because there was no self-serve path.
This screen closes that gap for every future change of the same shape.

**What already exists:**
- `supersedeConfig` — the entire write path, done (§ above).
- `store_attendance_config` — every field this task needs is already a column.
- `apps/erp/src/app/payroll/page.tsx` already reads and *displays* `cfg` via
  `premiumSettingsFor` — the read half of this screen, unwired to a write half.
- v1 (`ERP-rebuild/src/app/manager/settings/attendance/attendance-settings-client.tsx`) is a
  working, staff-used reference for field grouping and labels — **read as requirements, not
  design**. ⚠️ v1's night-diff hours are a *cosmetic-only* control (hardcoded in compute, the
  settings UI only appears to change them) — this task must not repeat that; every field here
  must be a real column `supersedeConfig` writes and `computeDay`/`computePay` actually reads.

**Open source:** nothing worth adopting. This is a bespoke form over an in-house effective-dated
config table; v2's house style in `apps/erp` (Server Actions + plain Tailwind, no shadcn) already
fits, matching `/payroll`'s existing rate-form pattern.

**Effort:** one page + one server action + a small parsing helper. No migration.

---

## 2. Design

### 2.1 Route

New `apps/erp/src/app/settings/attendance/page.tsx` — v2's first `/settings` route, one level
above where a future settings index could list other stores' config screens. Not folded into
`/payroll` itself: that page is already dense (preview, rates, runs), and v1's own precedent is a
dedicated settings page, not a section bolted onto payroll.

Nav: add one link from `/payroll` next to the premium-settings summary line ("These were constants
in code until T-189b…") — the line that already tells the reader these numbers are editable
somewhere. Do not add a global nav entry beyond that; scope stays tight per §5.

### 2.2 One form, one `effectiveFrom`, one submit

Mirrors v1's own discipline ("saving is deliberately ONE action for the whole store doc") for the
same reason it holds here: `supersedeConfig` writes **one row**. Splitting the UI into per-field
saves would still resolve to one row per click — no benefit, more surface for a half-saved state.

- A single `<input type="date" name="effectiveFrom">`, defaulting to **tomorrow's shift day**
  (`addShiftDays(toShiftDay(), 1)`), not today — today may already have adjudicated days, and
  defaulting past that avoids the single most likely rejection.
- One submit button. `supersedeConfig` itself decides accept/reject; the page does not
  pre-validate "is this day adjudicated" — that check lives in exactly one place already (bible
  §3: "the database enforces the rules... a second copy is a second source of truth").

### 2.3 Field groups (prefilled from `findLive`, via a new `liveConfigFor(orgId, storeId)` in
`apps/erp/src/app/settings/attendance/lib.ts`, same shape as `premiumSettingsFor`)

| Group | Fields |
|---|---|
| **Shift & capture** | `requiredHoursPerShift`, `halfDayHours`, `allowedShiftStartHours` (comma list, e.g. `9,10,11,14`), `anchorWindowMinutes`, `timeMode`, `defaultWorkHours`, `defaultBreakHours`, `breakEnabled` |
| **Credentials** | `credentialNfc`, `credentialFingerprint`, `credentialFace` |
| **Overtime & premiums** | `overtimeMode` (`multiplier`/`fixed`, toggles `overtimeMultiplier` vs `overtimeFixedHourly`), `shortShiftHalfDayOt`, `nightDiffEnabled` + `nightDiffStartHour`/`nightDiffEndHour`/`nightDiffMultiplier` |
| **Holiday multipliers** | `holidayRegularMultiplier`, `holidaySpecialNonWorkingMultiplier`, `holidaySpecialWorkingMultiplier` |
| **Late policy** | `latePolicy` (toggles `lateChargePerMinute` for `charge_per_minute`, `lateInfractionPoints` for `infraction`), `lateGraceMinutes`, `earlyOutGraceMinutes`, `undertimeGraceMinutes` |
| **Pay periods** | `payrollPeriodType`, `semiMonthlyCutoffDay` (shown only for `semi_monthly`), `payoutMode`, `payoutLagDays` (shown for `lag`), `payoutDays` (comma list, shown for `fixed_days`) |
| **Sweep / terminal** | `autoClockOutHour` (blank = never auto-clears — the nullable-means-chosen distinction from DEF-087 must survive the form: an empty input submits `null`, not `0`), `maxShiftHours` |

Numeric fields are string-backed in the form (own DB columns are `numeric`/`integer` — pass through
as strings/numbers the same way `setPayRateAction` already passes `amount` as a string). Booleans
from checkboxes (`'on'` / absent). Comma-list fields parsed server-side.

### 2.4 Server action — `apps/erp/src/app/settings/attendance/actions.ts`

Follow `apps/erp/src/app/payroll/actions.ts`'s exact shape: `requireActor()`, a `str()`/`num()`
helper, a `parseIntList()` helper (trim, split on comma, `Number`, sort, dedupe — the same
normalisation the DB CHECK already enforces, done here only so a malformed submission gets a
readable error instead of a raw constraint name), try/catch calling —

```ts
await withOrgPrincipal(actor.orgId, (tx) =>
  supersedeConfig(tx, actor, { storeId, effectiveFrom: parseShiftDay(effectiveFrom), changes }),
);
```

— and the same `back({ store, ok/error })` redirect pattern. Extend the existing
`CONSTRAINT_MESSAGES` map (already in `payroll/actions.ts`; **move it to a shared
`apps/erp/src/lib/constraint-messages.ts`** so both pages use one map instead of forking it) with
the `store_attendance_config_*` CHECK names: `charge_rate_check`, `half_day_below_required_check`,
`holiday_multipliers_check`, `fixed_ot_needs_amount_check`, `fixed_days_needed_check`,
`period_type_check`, `cutoff_day_check`, `anchor_window_check`. `AttendanceConfigError`'s own
messages (backdating, adjudicated days) already read fine unprefixed via the existing
`errorMessage()` regex strip — no change needed there.

---

## 3. Files

| File | Change |
|---|---|
| `apps/erp/src/app/settings/attendance/page.tsx` | New. The form, grouped per §2.3 |
| `apps/erp/src/app/settings/attendance/lib.ts` | New. `liveConfigFor`, `listStores` reuse from payroll's lib or a shared `apps/erp/src/lib/stores.ts` if duplication would exceed ~10 lines |
| `apps/erp/src/app/settings/attendance/actions.ts` | New. `updateAttendanceConfigAction`, `parseIntList` |
| `apps/erp/src/lib/constraint-messages.ts` | New — hoisted from `payroll/actions.ts` so both pages share one map |
| `apps/erp/src/app/payroll/actions.ts` | Import `CONSTRAINT_MESSAGES` from the shared file instead of defining it locally |
| `apps/erp/src/app/payroll/page.tsx` | One-line link to `/settings/attendance` next to the existing premium-settings summary |
| `apps/erp/tests/settings-attendance-lib.test.ts` | New. Unit test for `parseIntList` (comma parsing, dedupe, sort, empty → `[]`) |

⛔ **No schema change, no migration.** Everything the form writes is already a column;
`supersedeConfig` is the entire write path.

---

## 4. Tests

Domain-layer correctness (authorization, backdating refusal, adjudicated-day refusal, atomicity)
is **already covered** by `attendance-config.test.ts` — not re-tested here.

1. `parseIntList` unit test (§3) — the one piece of new logic with a pure function shape.
2. **Smoketest in the running app** (bible §9.4, and Ian's standing rule — a green build is blind
   to whether anyone can see the thing): load `/settings/attendance` for a real store, change one
   value in each group, submit, confirm the redirect banner and that `/payroll`'s summary line now
   shows the new value.
3. Smoketest a rejection: submit with `effectiveFrom` on-or-before the live row's `effectiveFrom`
   and confirm the friendly `AttendanceConfigError` text renders, not a raw stack trace.
4. Smoketest the nullable case: clear `autoClockOutHour` and confirm it saves as "never auto-clears"
   (not `0` — DEF-087's exact failure mode, `Number('')` is `0`).

---

## 5. Deliberately out of scope

| Not done | Why |
|---|---|
| `statutoryDeductionsEnabled` / `storeWideDeductions` (v1's `PayForm`) | Not columns in v2's `store_attendance_config` — they belong to a not-yet-built deductions module. Adding UI for fields that don't exist here would be scope invented mid-build |
| T-191, 13th-month pay | Handoff item 3. Genuinely separate: its own accrual/statutory research pass, not a form over an existing table |
| A general `/settings` index page or settings for anything beyond attendance/payroll | One route is being built because one route is needed. A section index is a decision for whenever a second settings screen exists |
| Per-field save / optimistic UI | One row, one submit, matching v1's own discipline and `supersedeConfig`'s shape (§2.2) |
| Client-side re-validation of the DB CHECK constraints | The database enforces the rules (bible §3, "the three that catch people out" #3) — friendly constraint messages via `errorMessage()`, not a second copy of the rule in TypeScript |
