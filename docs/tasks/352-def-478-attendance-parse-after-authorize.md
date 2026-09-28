# T-352: attendance forms parse their fields after `authorize()` (DEF-478)

**Status:** APPROVED 2026-09-28 (orchestrator, after an independent Opus spec audit; amendments M1–M6 at the end bind). **Model:** Sonnet, tester then builder.
**Migration:** none. Every item is domain or action code. The DB CHECKs involved
(`store_attendance_config_fixed_ot_needs_amount_check`, `…_positive_hours_check`, `…_half_day_below_required_check`)
already exist and are not changed.
**Runs after** T-351 (which created `packages/domain/src/shared/whole-number-input.ts`). No path here overlaps T-350 S3's
paths (`audit-log*`, `channel-settlements`, `rls/registry.ts`). One slice at a time per lane.
Line numbers were checked at HEAD `55077ef`.

## Why
DEF-478 (`docs/DEFECTS-REGISTER.md`, row DEF-478): two attendance forms check their fields before they check the actor's
right.
1. `apps/erp/src/app/settings/attendance/actions.ts` parses every field in the ACTION (`int`/`intOrNull`/`dec2`/
   `parseMoneyInput`, `:57-141`, called at `:165-213`), and `parseShiftDay(effectiveFrom)` at `:218`. All of this runs
   before `supersedeConfig`'s `authorize` (`packages/domain/src/attendance/config.ts:72`).
2. `apps/erp/src/app/attendance/[dayId]/actions.ts` `wholeMinutes` (`:35-49`) runs before `recordAdjustment`'s
   `authorize` (`packages/domain/src/attendance/adjustments.ts:53`).

So an actor without the right sees a field sentence instead of the authorization refusal. Nothing is written and nothing
is revealed; the defect is the order. The precedent is `0944455` (settlement gross/net parsed in
`collectSettlementFigureBlockers` after `authorize`) and T-351 R4 / DEF-481 (loans and prepaid: the action passes the
raw string, and the domain parses it after `authorize`).

## Rulings (planner, 2026-09-28)

- **R1: mechanism (a). The domain parses; the action passes raw strings.** Why not (b):
  - The gate already lives in the domain. The action header (`settings/attendance/actions.ts:6-8`) forbids a second
    gate in the action.
  - An "authorize-shaped pre-check" in the action would be exactly that second gate. It would be a second source of
    truth for the capability and would cost an extra query.
  - The input is a flat object, so (a) is proportionate. Its ~22 parsed keys map 1:1 onto columns.
  - The typed callers (domain tests, `mirror-publisher`, `inbox-ingestor`, `attendance-adjudication`) pass values the
    parse accepts unchanged. There is no ETL, cutover or `scripts/` caller: `scripts/backfill-store-attendance-config.ts`
    and `scripts/production-caller-census.mjs` mention `supersedeConfig` only in prose and in a name list.
- **R2: parse order is part of the contract.**
  - `supersedeConfig`: `authorize` → `parseConfigChanges` → `parseShiftDay(effectiveFrom)` → everything else.
  - That is today's order after the gate: the action builds `changes` first (`:165-213`) and parses the date after
    (`:218`).
  - Inside `parseConfigChanges`, fields are parsed in the action's literal order (`:166-212`). When two fields are
    malformed, a holder sees the same first sentence as today.
  - `recordAdjustment`: `authorize` → parse the minute fields → the self-adjudication, frozen and verify checks. A
    holder therefore sees today's minutes sentence in every case where they see it now.
- **R3: every human sentence is byte-identical.** Only the raw (developer) labels change their prefix, from
  `updateAttendanceConfigAction:`/`approveOvertimeAction:` to `supersedeConfig:`/`recordAdjustment:`. No test pins a
  raw prefix: the TESTER greps `apps packages tests` for `updateAttendanceConfigAction:` and `Action: ` + the field keys,
  and records the zero.
- **R4: value checks, not digit runs; every ceiling is stated** (bible §13 row 234).
  - Whole-number settings keep `NO_MAX_CEILING = 99999` where no `max` is given.
  - The two-decimal (`dec2`) fields keep the `numeric(4,2)` ceiling 99.99.
  - Minutes keep 0 to 99999.
  - Money keeps `parseMoneyInput`'s ceiling of 999,999,999,999.99.
  - The minutes and whole-number settings go through T-351's `parseWholeNumberInput`. Only the blank and "not a number"
    sentences, which that helper does not produce, stay local (see B1, B3).
- **R5: Ian's blank rulings hold, unchanged (bible §13 row 235).**
  - A blank minutes box means "not decided" and refuses (DEF-471).
  - A blank whole-number setting refuses by name.
  - A blank auto clock-out hour means "never" (`null`).
  - A blank channel gross/net refuses (not touched here).
  - A blank fixed-OT rate in fixed mode is refused by the mapped DB CHECK `store_attendance_config_fixed_ot_needs_amount_check`.
    That is the sentence `t343-s5-5w-followups.test.ts:522-524` pins.
  - The domain now owns the blank rules, so any future caller inherits them. Blank means `''` after trim. An ABSENT key
    (`undefined`) means "inherit from the live row" and is never defaulted. `attendance-config.test.ts:310-318` relies
    on that: `charge_per_minute` with no charge must still hit the DB CHECK.
- **R6: the action may still SELECT, but it may never REFUSE.**
  - These stay in the action because none of them can throw: the enum casts (`:152-162`), `bool()`, `parseIntList`
    (it drops junk and never refuses, `lib.ts:30-39`), and the mode choice for the fixed-OT rate.
  - The mode choice is `overtimeMode === 'fixed' ? raw : null`. Today a malformed rate in multiplier mode is silently
    discarded, and that stays so.
- **R7: the throw ratchet does not rise.** The new code uses `refuse(...)`, `parseMoneyInput` and
  `parseWholeNumberInput` only, with no `throw new Error(`. `packages/domain/src/attendance` stays at or below 1
  (`tests/unit/t343-throw-ratchet.test.ts:69`).
- **R8: the money-positivity census does not grow.** The moved code compares only local numbers (`n < min`,
  `n > max`), never `Number(…) <op> <literal>` (`shared/money-positivity-census.ts:97,110`).

## BUILDER items

1. **B1. New file `packages/domain/src/attendance/config-input.ts`.**
   - Move `NO_MAX_CEILING`, `wholeNumberSentence`, `DEC2_CEILING` and `dec2` VERBATIM from
     `settings/attendance/actions.ts:37-47,104-141`. Change only the input (a raw `string`, not `FormData`/`key`) and the
     raw prefix (`supersedeConfig: ${key}`). Keep their comments.
   - `int()` becomes `parseConfigWholeNumber(raw: string | number, key, label, min, max?)`:
     - `const v = String(raw).trim()`.
     - Blank: `refuse(\`supersedeConfig: ${key} is blank\`, wholeNumberSentence(label, min, max))`.
     - `!Number.isFinite(Number(v))`: `refuse(…, \`${label} — "${v}" is not a number.\`)`. This must stay FIRST, as the
       comment at `:51-53` says, so that `1,5` keeps the "is not a number" sentence.
     - Otherwise `return parseWholeNumberInput(v, \`supersedeConfig: ${key}\`, label, min, max ?? NO_MAX_CEILING)`. Its
       out-of-range sentence equals today's `wholeNumberSentence(label, min, max, v)` byte for byte (unit `''`).
   - `intOrNull` becomes `parseConfigWholeNumberOrNull`: `null` or blank gives `null`, otherwise
     `parseConfigWholeNumber`. Keep the "auto clock-out only, blank = never" comment (`:78-83`).
   - Money:
     - `overtimeFixedHourly`: `null` or blank gives `null`, otherwise
       `parseMoneyInput(v, 'supersedeConfig: the overtime fixed hourly', 'The overtime fixed hourly')`.
     - `lateChargePerMinute`: blank gives `'0'` (today's `:197-199`), otherwise
       `parseMoneyInput(v, 'supersedeConfig: the late charge per minute', 'The late charge per minute')`.
   - `export type ConfigChangesInput`: `ConfigChanges` with the ten integer keys (`anchorWindowMinutes`,
     `nightDiffStartHour`, `nightDiffEndHour`, `lateInfractionPoints`, `lateGraceMinutes`, `earlyOutGraceMinutes`,
     `undertimeGraceMinutes`, `semiMonthlyCutoffDay`, `payoutLagDays`, `maxShiftHours`) widened to `number | string`,
     and `autoClockOutHour` widened to `number | string | null`. The dec2 and money keys are already `string` in the
     row type.
   - `export function parseConfigChanges(c: ConfigChangesInput): ConfigChanges`:
     - Start from `{ ...c }`. For each key in ONE ordered table that mirrors `:166-212` (label, min and max copied
       verbatim from those lines), replace the value only when `c[key] !== undefined`.
     - Keys the table does not name pass through untouched: booleans, enums, the two int arrays.
     - The table, in order:
       `requiredHoursPerShift`(dec2 .5), `halfDayHours`(dec2 .5), `anchorWindowMinutes`(0-60),
       `defaultWorkHours`(dec2 0), `defaultBreakHours`(dec2 0), `nightDiffStartHour`(0-23), `nightDiffEndHour`(0-23),
       `nightDiffMultiplier`(dec2 1), `overtimeMultiplier`(dec2 1), `overtimeFixedHourly`(money|null),
       `holidayRegularMultiplier`, `holidaySpecialNonWorkingMultiplier`, `holidaySpecialWorkingMultiplier`(dec2 1),
       `lateChargePerMinute`(money, blank→'0'), `lateInfractionPoints`(0-), `lateGraceMinutes`(0-),
       `earlyOutGraceMinutes`(0-), `undertimeGraceMinutes`(0-), `semiMonthlyCutoffDay`(1-27), `payoutLagDays`(0-31),
       `autoClockOutHour`(0-23 or null), `maxShiftHours`(10-).
   - Imports: `refuse` from `'../shared/refusal'`, `parseWholeNumberInput` from `'../shared/whole-number-input'`,
     `parseMoneyInput` from `'../shared/money-input'`. Check that none of them creates a cycle. If one does, STOP and
     report it.
2. **B2. `packages/domain/src/attendance/config.ts`.**
   - `supersedeConfig`'s input (`:70`) becomes
     `{ storeId: string; effectiveFrom: ShiftDay | string; changes: ConfigChangesInput }`.
   - Directly after `authorize` (`:72`):
     `const changes = parseConfigChanges(input.changes); const effectiveFrom = parseShiftDay(input.effectiveFrom);`
     (R2 order). Use these two locals at `:76`, `:79`, `:86-88`, `:102` and `:105`.
   - `parseShiftDay`'s own raw throw is unchanged (out of scope).
   - Import `parseShiftDay` from `'./shift-day'`, and add `export type { ConfigChangesInput } from './config-input'` so
     the barrel exposes the type. `ConfigChanges` (`:56-61`) and `stripLifecycle` are unchanged.
   - Extend the JSDoc: fields arrive raw and are parsed after `authorize` (T-352 / DEF-478).
3. **B3. `packages/domain/src/attendance/adjustments.ts`.**
   - `RecordAdjustmentInput` (`:27-39`): `chosenAnchorMinute`, `effectiveOutMinute` and `approvedOtMinutes` become
     `number | string`.
   - Add a module-private `parseMinutes(raw: string | number, key: string, label: string): number`:
     - `const t = String(raw).trim()`.
     - Blank: `refuse(\`recordAdjustment: ${key} is blank\`, \`${label} — enter a whole number of minutes (0 to 99999).\`)`.
       This is the DEF-471 sentence, which `parseWholeNumberInput`'s blank wording does not match.
     - Otherwise `parseWholeNumberInput(t, \`recordAdjustment: ${key}\`, label, 0, 99999, ' of minutes')`.
   - A `const MINUTE_LABELS` holds the three human labels verbatim from the action: `approvedOtMinutes` → 'The minutes to
     pay' (`[dayId]/actions.ts:97`), `chosenAnchorMinute` → 'The paid-from minute' (`:108`), `effectiveOutMinute` → 'The
     paid-until minute' (`:119`).
   - Directly after `authorize` (`:53-56`), build `const parsed` = `input` with each of the three keys replaced by
     `parseMinutes(...)` when `!== undefined`.
   - Use `parsed` for `assertNotInverted` (`:98`) and for the insert (`:118-121`). `assertNotInverted`'s `incoming` type
     (`:160`) becomes the parsed shape, with the three keys as `number | undefined`.
   - Nothing moves ahead of `authorize`. The `getEmployment` lookup (`:50-51`) stays first, because it supplies the store
     to authorize against.
4. **B4. `apps/erp/src/app/settings/attendance/actions.ts`.**
   - Delete `:29-141`, which B1 moved.
   - Drop the `refuse`, `parseMoneyInput` and `parseShiftDay` imports. Change the type import to `ConfigChangesInput`.
   - In `changes` (`:165-213`), each parsed field passes `str(formData, key)` raw. `overtimeFixedHourly` becomes
     `overtimeMode === 'fixed' ? str(formData, 'overtimeFixedHourly') : null` (R6). `lateChargePerMinute` and
     `autoClockOutHour` pass `str(...)` raw, and the domain applies the blank rules.
   - `parseIntList`, the `bool()` calls and the enum casts are unchanged.
   - `:218` passes `effectiveFrom` raw.
   - Header: add one line saying every field is parsed in `supersedeConfig` after `authorize` (T-352 / DEF-478).
5. **B5. `apps/erp/src/app/attendance/[dayId]/actions.ts`.**
   - Delete `wholeMinutes` (`:31-49`) and the `refuse` import (`:21`).
   - The three builders (`:97`, `:108`, `:119`) pass `str(fd, key)` raw.
   - Add one comment line: parsed in `recordAdjustment` after `authorize` (T-352 / DEF-478).

**BUILDER paths:** `packages/domain/src/attendance/config-input.ts` (new), `packages/domain/src/attendance/config.ts`,
`packages/domain/src/attendance/adjustments.ts`, `apps/erp/src/app/settings/attendance/actions.ts`,
`apps/erp/src/app/attendance/[dayId]/actions.ts`.
⛔ Not the builder's to touch:
- `whole-number-input.ts` or `money-input.ts`: they are reused unchanged.
- `lib.ts`: `parseIntList` stays.
- `packages/domain/src/index.ts`: the barrel already re-exports `./attendance`.
- `constraint-messages.ts`, `page.tsx`, and every test file.

## TESTER paths
- **New files.**
  - `packages/domain/tests/integration/t352-attendance-parse-in-domain.test.ts`: D1-D8. Real Postgres. Use the fixture
    shape from `attendance-config.test.ts` and `attendance-adjustments.test.ts`.
  - `apps/erp/tests/integration/t352-attendance-auth-before-parse.test.ts`: W1-W11 and G1. Real Postgres. Copy the
    mocks from `t343-s5-5t-followups.test.ts:36-56` (`next/navigation`, `../../src/lib/session` with BOTH
    `requireActor` and `requireSession`, `@/lib/constraint-messages`). Copy `attendanceFormData` from
    `t343-s5-5q-followups.test.ts:109-143` and `dayFormData`/`attendanceFixture` from `t343-s5-5t-followups.test.ts:107-143`.
- **The non-holder.** Add a `staff`-role person scoped to the store (`person_roles.role='staff'`, plus
  `person_store_scope`), with a session for the `[dayId]` legs. `docs/decisions/CAPABILITY-MATRIX.md:143,152`:
  `manage_attendance` and `manage_store_settings` are both ✗ for staff and ✅ for manager. Follow the precedent at
  `attendance-adjustments.test.ts:255-265`.
- **The "auth refusal" baseline.** Each W-leg compares with the SAME non-holder's redirect `error` for the SAME form with
  every field valid, as T-351 W1 did. Do not hard-code the authorization sentence.
- **No existing test file is edited.** `tests/unit/t343-throw-ratchet.test.ts` is not edited either. Its check is `<=`,
  and this slice adds no raw throw.

## Legs
Every leg asserts the TARGET (bible §13 row 233). Record the raw red for each one.
"Nothing written" means the following:
- **Config legs:** the `store_attendance_config` row count for the store is unchanged, and `getLiveConfig`'s
  `effectiveFrom` is still `'2026-01-01'`.
- **Adjustment legs:** the live `attendance_adjustments` count for (employment, day, kind) is unchanged, as in
  `adjustmentCountFor`, `t343-s5-5t-followups.test.ts:145-151`.

**Auth-before-parse: one leg per moved field group** (non-holder + malformed field → the authorization refusal).

| Id | Action / group | Field sent by the non-holder | Target | Red today |
|---|---|---|---|---|
| W1 | config · dec2 | `requiredHoursPerShift='1,5'` | `error` === the baseline; ⛔ does not contain "required hours"; nothing written | `The required hours / shift — "1,5" is not a valid number. Use at most two decimal places.` |
| W2 | config · whole number, malformed | `lateGraceMinutes='abc'` | as W1; ⛔ no "late grace" | `The late grace minutes — "abc" is not a number.` |
| W3 | config · whole number, out of range | `anchorWindowMinutes='70'` | as W1; ⛔ no "anchor window" | `The anchor window — "70" is not a whole number from 0 to 60.` |
| W4 | config · whole number, blank (row 235) | `lateGraceMinutes=''` | as W1 | `The late grace minutes — enter a whole number, 0 or more.` |
| W5 | config · whole-or-null | `autoClockOutHour='abc'` | as W1; ⛔ no "auto clock-out" | `The auto clock-out hour — "abc" is not a number.` |
| W6 | config · money, fixed OT | `overtimeMode='fixed'`, `overtimeFixedHourly='1,5'` | as W1; ⛔ no "overtime fixed hourly" | `The overtime fixed hourly — "1,5" is not a valid amount. Use at most two decimal places.` |
| W7 | config · money, late charge | `lateChargePerMinute='1,5'` | as W1; ⛔ no "late charge" | the late-charge "not a valid amount" sentence |
| W8 | config · effective date | `effectiveFrom='not-a-date'` | as W1 | whatever `errorMessage` renders for `parseBusinessDate`'s raw throw (record it; do not presume it) |
| W9 | adjustment · minutes, malformed | `approveOvertimeAction`, `approvedOtMinutes='abc'` | `error` === the non-holder's `error` for `'30'`; ⛔ no "minutes to pay"; nothing written | `The minutes to pay — "abc" is not a whole number of minutes from 0 to 99999.` |
| W10 | adjustment · minutes, blank (DEF-471) | `setStartAnchorAction`, `chosenAnchorMinute=''` | as W9, baseline `'60'`; ⛔ no "paid-from" | `The paid-from minute — enter a whole number of minutes (0 to 99999).` |
| W11 | adjustment · minutes, third box | `approveEarlyOutAction`, `effectiveOutMinute='8:30'` | as W9, baseline a valid minute; ⛔ no "paid-until" | `The paid-until minute — "8:30" is not a whole number of minutes from 0 to 99999.` |
| G1 | config · order guard (R2) | ADMIN, `requiredHoursPerShift='1,5'` + `lateGraceMinutes='abc'` | the required-hours sentence (first in order) | green (guard) |

**Domain-direct legs** (the domain now owns parsing, so a caller that bypasses the screen gets the same sentences):

| Id | Call (admin) | Target | Red today |
|---|---|---|---|
| D1 | `supersedeConfig`, `changes: { lateGraceMinutes: 'abc' }` | rejects with `userMessage` `The late grace minutes — "abc" is not a number.`; nothing written | a raw Postgres 22P02, no `userMessage` |
| D2 | `supersedeConfig`, `changes: { halfDayHours: '100' }` | `userMessage` `The half-day hours has to be at most 99.99.`; nothing written | a raw 22003 numeric overflow |
| D3 | `supersedeConfig`, `changes: { autoClockOutHour: '   ' }`, then `{ autoClockOutHour: null }` at a later date | both save `null` (row 235: blank = never) | the first is a raw 22P02 |
| D4 | `supersedeConfig`, `changes: { lateGraceMinutes: '000015' }` | saves 15 (value, not digit run) | record it (the driver may cast `'000015'`; if green, it is a guard) |
| D5 | `supersedeConfig`, `changes: { lateGraceMinutes: 15, requiredHoursPerShift: '10' }` | saves (numeric callers still work) | green (guard) |
| D6 | `supersedeConfig`, `changes: { latePolicy: 'charge_per_minute', lateChargePerMinute: '' }` | rejects with `store_attendance_config_charge_rate_check` (blank → '0', then the CHECK; the domain call does not go through `errorMessage`); nothing written | record it (`''` into numeric today: a raw 22P02) |
| D7 | `recordAdjustment`, `{ kind: 'overtime_approved', approvedOtMinutes: '1.5' }` | `userMessage` `The minutes to pay — "1.5" is not a whole number of minutes from 0 to 99999.`; nothing written | a raw 22P02 |
| D8 | `recordAdjustment`, `{ kind: 'start_anchor', chosenAnchorMinute: '' }`, then `chosenAnchorMinute: 60` (a number) | the first gives `The paid-from minute — enter a whole number of minutes (0 to 99999).`, nothing written; the second saves 60 | the first is a raw 22P02; the second is a guard |

**Sentences that must stay green UNCHANGED** (the holder paths; R3). Record each one's pass in the TESTER report:
- `apps/erp/tests/integration/t343-s5-5q-followups.test.ts`: `:167`, `:187`, `:226`; the guards A1n `:195-214` and A3n
  `:230-239`.
- `apps/erp/tests/integration/t343-s5-5t-followups.test.ts`: the constants `:153-159`, used by M1-M3 `:161-233` and
  A1 `:235-258`; the guards `:260-294`; M5 `:655-690` (`000030`/`00030`).
- `apps/erp/tests/integration/t343-s5-5w-followups.test.ts`: `:340-347`, `:350-363`, `:365-379`, `:381-414`, `:416-462`,
  `:464-503` and O1 `:505-528`. O1 is the blank fixed-OT DB-CHECK sentence.
- `packages/domain/tests/integration/`: `attendance-config`, `attendance-adjustments`, `attendance-review`,
  `attendance-adjudication`, `inbox-ingestor` and `mirror-publisher`. These are the typed callers of both functions.
- `apps/erp/tests/settings-attendance-lib.test.ts`, the throw ratchet, and the money-positivity guard and census tests.

## §9.4
Smoketest in Chrome on 9008, per `docs/SMOKETEST.md`:
- **As admin, `/settings/attendance`.** Type `abc` in late grace and save: the same sentence as before. Type `.5` in
  half-day hours and save: it saves.
- **As a staff user, the same screen** (if the page renders the form for them; otherwise post the form from the admin
  tab after switching session). Save with `abc`: the authorization refusal, not the field sentence.
- **As admin, `/attendance/<dayId>`.** Approve overtime with `1,5`: the minutes sentence. Approve with `30`: it saves.
- Take a screenshot of each. If a staff session cannot reach either screen, say so and rely on W1-W11.

## Out of scope
- `parseShiftDay` / `parseBusinessDate`'s raw, sentence-less throw. It only moves behind the gate here, and converting
  it to `refuse` is a separate item.
- The `getEmployment` "No employment …" raw throw ahead of `authorize` in `recordAdjustment`. It is a lookup the gate
  needs, not a parse.
- `parseIntList` silently dropping junk tokens. It is DB-CHECK-backed and not a refusal ordering issue.
- The wording gap O1 records: Ian's preferred fixed-OT sentence versus the mapped CHECK's sentence.
- Any other action that parses before its domain's `authorize`. If the tester or builder sees one, log it as a new
  DEF row; do not fix it here.

## Done when
- Every red leg goes red→green and every guard stays green.
- Every sentence listed above is green with no test edited.
- The throw ratchet and the money-positivity guard are green with no edit, and `packages/domain/src/attendance` is at 1
  or less.
- Typecheck is clean, §9.4 is done with screenshots, and the builder edited no test file.
- DEF-478 is moved to `fixed (T-352, <commit>)` by the orchestrator at commit.

## Questions for Ian
None. Every blank rule is already his (row 235), and this slice changes no sentence and no rule.

## Orchestrator amendments (bind; from the independent spec audit, 2026-09-28)
- **M1.** B1/B3 (`:84-85`, `:131`): write `throw refuse(...)` — `refuse` RETURNS a `RefusalError`
  (`packages/db/src/refusal.ts:52`); a bare call falls through and typecheck will not catch it.
- **M2.** Add `t343-s5-5w-followups.test.ts:742-775` (W1 `'000001'` saves 1; W2 `'100000'` → "…is not a whole number
  from 0 to 99999.") to the must-stay-green list. (5q's `attendanceFormData` is `:108-142`.)
- **M3.** D1/D3/D4/D7/D8 pass strings into fields typed as numbers today: typecheck is allowed to be red ONLY in the
  tester's two new T-352 files, between RED and the builder's READY. No gates run in that window; Done-when's clean
  typecheck applies at READY.
- **M4.** B1: `dec2` and the money parse trim first (`String(raw).trim()`), like `int`, so `'  '` gets the blank
  sentence, not "not a valid number".
- **M5.** `config-input.ts` exports only `parseConfigChanges` and `ConfigChangesInput` (the zero-caller ratchet).
- **M6.** Follow-up (orchestrator, not the builder): `shared/whole-number-input.ts:3-6` header says `int()` lives in
  the actions file — stale after the move; fix at the T-352 commit.
