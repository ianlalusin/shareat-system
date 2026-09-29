# T-360: the attendance day actions parse `shiftDay` in the domain, after `authorize()` (DEF-488)

**Status:** APPROVED 2026-09-29 (orchestrator, after Opus spec audit) with Amendment A1. **Model:** Sonnet, tester then builder.
**Migration:** none. Domain code only, plus one comment line in an action. `shift_day` is already a
`date` column (`packages/db/schema/attendance-adjustments.ts:88`, `attendance-days.ts:96`) and no CHECK changes.
**Line numbers** were checked at HEAD `e4d9ff3` and re-verified by the auditor at `3372e5e` (the baseline; `page.tsx` hidden input is l.221 there, l.220 at e4d9ff3). None of the paths below is dirty in the tree at that HEAD. T-348
is sweeping `apps/erp/**/page.tsx`, and this task touches no page.

## Why
DEF-488 (`docs/DEFECTS-REGISTER.md`, the DEF-488 row). It was logged at T-352's pre-commit review and never
executed. Here is what it looks like at source:
- `apps/erp/src/app/attendance/[dayId]/actions.ts:53` reads `shiftDay` with `str()`, which only trims. It is
  spread into the `recordAdjustment` input and cast through `as Parameters<typeof recordAdjustment>[2]` (`:57-62`).
- `RecordAdjustmentInput.shiftDay` is typed `ShiftDay` (`packages/domain/src/attendance/adjustments.ts:31`), but
  nothing ever calls `parseShiftDay`. The raw string reaches four places:
  - `attendanceDaysRepo.findDay` (`:120-123`)
  - `attendanceAdjustmentsRepo.listLive` (`:142-145`)
  - the insert (`:165`)
  - `adjudicateDay` (`:179-182`)
- So a malformed value (from a stale page, a hand-posted form or a future caller) reaches Postgres as `'abc'::date`.
  - The error carries a SQLSTATE, so `errorMessage` (`apps/erp/src/lib/constraint-messages.ts:315-327`) renders the
    generic fallback: *"The database refused that change for a reason this screen cannot show…"* (`:214-215`).
  - That is a real refusal with no sentence.
- No auth leak: `authorize()` (`:84-87`) runs before any use of `shiftDay`. This is DEF-478's shape, one field over.

The precedent is T-352 (commit `a47e0a7`). `supersedeConfig` takes `effectiveFrom: ShiftDay | RawShiftDay` and
parses it with `parseShiftDay` directly after `authorize` (`packages/domain/src/attendance/config.ts:26,89,94`).

## Rulings (planner, 2026-09-29)

- **R1: the domain parses, and the action keeps passing the raw string.**
  - `RecordAdjustmentInput.shiftDay` becomes `ShiftDay | RawShiftDay`.
  - `RawShiftDay` moves from `config.ts:16-26` (module-private today) into `shift-day.ts`, exported, with its
    comment.
    - It is the type T-352 F2 designed for exactly this job. A plain unbranded string is admitted, and a
      `BusinessDate` is still a compile error.
    - That second property is the point of the brand: 00:00-05:00 Manila is the previous shift day.
    - `ShiftDay | string` would collapse to `string` and admit it, which is the trap the F2 comment records.
  - A second copy of the alias in `adjustments.ts` is refused: two copies of one type rule drift.
- **R2: a sentence for every malformed value.** The value is refused, never coerced.
  - The parse is a module-private `parseShiftDayInput(raw)` in `adjustments.ts`:
    1. `const t = String(raw).trim()`.
    2. If `t === ''`: `throw refuse('recordAdjustment: shiftDay is blank', SHIFT_DAY_MISSING)`.
    3. Otherwise `try { day = parseShiftDay(t) } catch { throw refuse(\`recordAdjustment: shiftDay ${JSON.stringify(t)} is not a YYYY-MM-DD shift day\`, shiftDayMalformed(t)) }`.
    4. **Calendar check:** if `addShiftDays(day, 0) !== day`, throw the same `refuse` as step 3.
  - Why step 4 exists: `parseBusinessDate` accepts `2026-02-30` (`packages/core/src/datetime.ts:47-49` checks only
    `d <= 31`).
    - `addDays` goes through `Date.UTC` and normalises the date, so an impossible date does not round-trip.
    - This is a VALUE check, not a digit-run check (bible §13 row 234).
    - Fixing core's parser is out of scope, because it has many callers.
  - The sentences are new, since no human sentence exists today. Their wording uses the glossary's term "shift day"
    (`docs/GLOSSARY.md:85`):
    - `SHIFT_DAY_MISSING` = `The shift day is missing. Reopen the day from the attendance list and try again.`
    - `shiftDayMalformed(v)` = `` `The shift day — "${v}" is not a date. Reopen the day from the attendance list and try again.` ``
  - The field is a hidden input (`[dayId]/page.tsx:221`). A person cannot fix it by typing, so the sentence tells
    them what they *can* do.
- **R3: where the parse sits. Immediately before the first use of `shiftDay`, after `authorize` and after the
  self-adjudication check.** The order is:
  1. `getEmployment`
  2. `authorize`
  3. the minute parses (T-352)
  4. self-adjudication (`:110-118`)
  5. **`parseShiftDayInput`**
  6. `findDay` (frozen, verify)
  7. `listLive` (inverted)
  8. insert
  9. `adjudicateDay`
  - Why here and not with the minute parses: every holder who sees a sentence today still sees that same sentence.
    Only today's generic database fallback changes, into R2's sentence.
    - A malformed minutes box plus a malformed day still gives the minutes sentence.
    - A manager on their own day still gets the self-adjudication sentence.
    - This is the T-352 R2 principle.
  - A non-holder still gets the authorization refusal, because nothing new runs before `authorize`.
- **R4: one parsed local, used everywhere.**
  - `const shiftDay = parseShiftDayInput(input.shiftDay)`.
  - `input.shiftDay` is then read nowhere else in `recordAdjustment`. `:122`, `:144`, `:165` and `:181` all use
    `shiftDay`.
- **R5: no raw throw.** The `catch` rethrows through `refuse` (`throw refuse(...)`, T-352 M1). `refuse` RETURNS
  the error. `packages/domain/src/attendance` stays at 1 or below in `tests/unit/t343-throw-ratchet.test.ts:69`.
- **R6: the action's cast stays.** `build` returns `Record<string, unknown>`, so the payload still needs the cast.
  - The raw `shiftDay` now matches the declared type honestly: a plain `string` is a `RawShiftDay`.
  - Removing the cast would mean re-typing six builders. That is out of scope.

## BUILDER items
1. **B1. `packages/domain/src/attendance/shift-day.ts`.**
   - Add `export type RawShiftDay = string & { readonly __brand?: undefined };` directly after `ShiftDay`
     (`:52`).
   - Move the T-352 F2 comment VERBATIM from `config.ts:16-25`. Extend its first sentence to say the type is shared
     by `supersedeConfig` and `recordAdjustment`.
2. **B2. `packages/domain/src/attendance/config.ts`.**
   - Delete `:16-26`.
   - Import `type RawShiftDay` from `'./shift-day'`, alongside `parseShiftDay` (`:11`).
   - No behaviour change. The T-352 compile pin (`t352-attendance-parse-in-domain.test.ts:443-472`) must stay green.
3. **B3. `packages/domain/src/attendance/adjustments.ts`.**
   - `:31` becomes `shiftDay: ShiftDay | RawShiftDay;`.
   - Import `parseShiftDay`, `addShiftDays` and `type RawShiftDay` from `'./shift-day'` (`:20`).
   - Add `parseShiftDayInput` and the two sentence constants, per R2, beside `parseMinutes` (`:64-70`).
   - Give them a JSDoc: T-360 / DEF-488, and why the calendar round-trip exists.
   - Insert `const shiftDay = parseShiftDayInput(input.shiftDay);` between the self-adjudication block (ends `:118`)
     and `findDay` (`:120`), with a comment citing R3.
   - Replace `input.shiftDay` at `:122`, `:144`, `:165` and `:181` with `shiftDay`.
   - `listAdjustments` (`:188-193`) is unchanged and stays `ShiftDay`-typed.
4. **B4. `apps/erp/src/app/attendance/[dayId]/actions.ts`.**
   - Change only the header comment (`:20-21`) so it also says: `shiftDay` is passed raw and parsed in
     `recordAdjustment` after `authorize()` (T-360 / DEF-488).
   - No code change.
   - ⚠️ If this file is dirty from another lane at build time, skip B4 and say so. It is a comment.

**BUILDER paths:** `packages/domain/src/attendance/shift-day.ts`, `packages/domain/src/attendance/config.ts`,
`packages/domain/src/attendance/adjustments.ts`, `apps/erp/src/app/attendance/[dayId]/actions.ts`.

⛔ Off limits to the builder:
- `packages/core/src/datetime.ts`, because R2's round-trip covers the gap locally.
- `constraint-messages.ts`, `page.tsx` and the barrel.
- Every test file.

## TESTER paths (disjoint from BUILDER)
- `packages/domain/tests/integration/t360-attendance-shiftday-parse.test.ts` (new, **integration**, real Postgres):
  - legs D1-D11;
  - fixture copied from `t352-attendance-parse-in-domain.test.ts` (`adjustmentFixture`, `:322`; `liveAdjustmentCount`, `:385`);
  - the self-adjudication fixture shape from `attendance-adjustments.test.ts:190-205`.
- `apps/erp/tests/integration/t360-attendance-shiftday-web.test.ts` (new, **integration**, real Postgres):
  - legs W1-W5;
  - harness copied from `t352-attendance-auth-before-parse.test.ts`: `RedirectSignal` (`:26-35`), `ACTOR_HOLDER`
    with both `requireActor` and `requireSession` (`:39-46`), the `@/lib/constraint-messages` forward (`:50-52`),
    `dayFixture` (`:272-303`) and `dayFormData` (`:309-316`).
- Both files point `TEST_DATABASE_URL` at **the lane's own `_test` database**, with the `_test` name guard (t352
  `:20-24`). They never point at the shared `shareat_test` while another lane runs integration (RULES §2).
- **"Nothing written"**: the count of `attendance_adjustments` rows for the employment across all shift days is
  unchanged. A malformed day cannot be queried by day.
- **Baselines are never hard-coded.** The authorization refusal is always the same non-holder's `error`/message for
  the same call with a VALID shift day (T-351 W1 / T-352 precedent).
- No existing test file is edited.
- ⚠️ **Typecheck may be red ONLY in the tester's two new files, between RED and the builder's READY** (T-352 M3).
  The typed legs pass unbranded strings, which do not compile against today's `ShiftDay`.

## Legs
Every leg asserts the TARGET. Record the raw red for each one; do not presume the SQLSTATE, measure it.

**Domain-direct** (admin actor unless stated; kind `overtime_approved` with `approvedOtMinutes: 30` unless stated):

| Id | Call | Target | Red today |
|---|---|---|---|
| D1 | `shiftDay: 'not-a-date'` | rejects with `userMessage` `The shift day — "not-a-date" is not a date. Reopen the day from the attendance list and try again.`; nothing written | a raw Postgres error with no `userMessage` (record the code, expected 22007) |
| D2 | `shiftDay: ''` | `userMessage` `The shift day is missing. Reopen the day from the attendance list and try again.`; nothing written | raw Postgres (record it) |
| D3 | `shiftDay: '2026-02-30'` (calendar-impossible) | D1's sentence with `"2026-02-30"`; nothing written | raw 22008 (record it) |
| D4 | `shiftDay: '2026-13-01'` | D1's sentence with `"2026-13-01"`; nothing written | raw (record it) |
| D5 | kind `verify`, `shiftDay: 'abc'` | D1's sentence with `"abc"` (every kind passes the parse); nothing written | raw (record it) |
| D6 | `shiftDay: toShiftDay(new Date())` (branded) | saves; the row's `shift_day` equals it | green (guard) |
| D7 | `shiftDay: '2026-09-28'` (plain unbranded string) | saves; `shift_day = '2026-09-28'` | typecheck red only (M3 window); runtime green |
| D8 | `shiftDay: ' 2026-09-28 '` | saves as `2026-09-28`; exactly one live row for that day | record it (Postgres may trim too; if green, it is a guard) |
| D9 | **ordering guard: a STAFF non-holder** (`manage_attendance` ✗, `CAPABILITY-MATRIX.md:143`), `shiftDay: 'not-a-date'` | the rejection message equals the same staff's message for a valid day; ⛔ it does not contain "shift day"; nothing written | green (guard); stays green after |
| D10 | **order guard: admin**, `approvedOtMinutes: 'abc'` AND `shiftDay: 'not-a-date'` | the minutes sentence `The minutes to pay — "abc" is not a whole number of minutes from 0 to 99999.` | green (guard; R3) |
| D11 | **order guard: a non-admin MANAGER adjudicating their OWN employment**, `shiftDay: 'not-a-date'` | rejects `/your own attendance/i`, not the shift-day sentence | green (guard; R3) |

**Compile pin (in the domain file, never called):**
- A `@ts-expect-error` on passing `toBusinessDate(new Date())` as `recordAdjustment`'s `shiftDay`.
- Positive control: a plain string literal compiles.
- Red today: the positive control does not compile (`shiftDay: ShiftDay`).
- Shape: t352 `:443-472` (through the `void neverCalled_…` line); it lives in the domain-direct TEST file, never in `adjustments.ts`.

**Web** (`attendance/[dayId]/actions.ts`, via `dayFormData` with `shiftDay` overridden):

| Id | Action / actor | Field | Target | Red today |
|---|---|---|---|---|
| W1 | `approveOvertimeAction`, admin | `shiftDay='not-a-date'`, minutes `30` | the redirect `error` is D1's sentence; nothing written | the generic database fallback (`constraint-messages.ts:214-215`); record the exact text |
| W2 | `verifyDayAction`, admin | `shiftDay=''` | D2's sentence; nothing written | record it |
| W3 | **the ordering leg.** `approveOvertimeAction`, staff non-holder | `shiftDay='not-a-date'` | `error` === the same staff's `error` for a valid `shiftDay`; ⛔ no "shift day"; nothing written | green (guard); stays green after |
| W4 | the ordering leg, second action. `setStartAnchorAction`, staff | `shiftDay='2026-02-30'`, minute `60` | as W3 | green (guard) |
| W5 | `approveOvertimeAction`, admin | the valid `DAY`, minutes `30` | the `ok` redirect; one live row | green (guard) |

**Proving the ordering legs are not vacuous:**
- At READY the orchestrator's auditor makes a throwaway mutant in a worktree: `parseShiftDayInput` moved above
  `authorize`.
- It records that D9, W3 and W4 go red under that mutant. Nothing about the mutant is committed.

**Must stay green UNCHANGED.** Record each file's pass count in the TESTER report:
- `packages/domain/tests/integration/`: `t352-attendance-parse-in-domain` (including the compile pin),
  `attendance-adjustments`, `attendance-review`, `attendance-adjudication`, `payroll` (it calls `recordAdjustment`);
- `apps/erp/tests/integration/`: `t352-attendance-auth-before-parse`, `t343-s5-5t-followups`;
- `packages/domain/src/attendance/shift-day.test.ts` (unit);
- `tests/unit/t343-throw-ratchet.test.ts` and `tests/unit/production-caller-ratchet.test.ts`.

## §9.4
Smoketest on **9008**, per `docs/SMOKETEST.md`, signed in as admin:
1. Open `/attendance/<dayId>` for a day with pending overtime.
2. In devtools, set the hidden `shiftDay` input (`page.tsx:221`) to `abc` and approve overtime with `30`.
   Screenshot D1's sentence in the banner.
3. Reload the page, which restores the real value. Approve with `30` and screenshot the success banner.
4. Set the hidden value to `2026-02-30` and screenshot the same sentence.
- A staff session is refused at the page before the form (T-352's smoketest found this). Rely on W3/W4 for the
  ordering, and say so.

## Out of scope
- **`parseBusinessDate` accepting `2026-02-30`** (`packages/core/src/datetime.ts:48`). R2 covers it locally.
  - The core fix affects every caller.
  - The orchestrator logs it as a new DEF row (section E) at commit.
- **`parseShiftDay`'s own raw, sentence-less throw.** It is still called raw by `supersedeConfig` (`config.ts:94`).
  - For `effectiveFrom` it renders as `Invalid business date: …` (T-352 W8, measured).
  - Giving `supersedeConfig` the R2 treatment is a small follow-up. The orchestrator logs it.
- `getEmployment`'s raw "No employment …" throw ahead of `authorize` (`:81-82`). It is a lookup the gate needs.
- Re-typing the six `build` closures to drop the action's cast (R6).
- `listAdjustments` or any other attendance reader.

## Done when
- D1-D5, W1 and W2 go red→green. D7 and the compile pin compile at READY. D6 and D8-D11, W3-W5 are green before and
  after.
- The mutant proof for D9, W3 and W4 is recorded.
- The must-stay-green list passes with no test edited, and typecheck is clean at READY.
- §9.4 screenshots are pasted.
- The builder edited only the BUILDER paths.
- **Orchestrator:** DEF-488 → `fixed (T-360, <commit>)`. Log the two out-of-scope findings above as new rows.

## Questions for Ian
None. No rule changes. The only new wording is a sentence for a case that today shows the generic database
fallback.

## Amendment A1 — spec audit (2026-09-29, orchestrator; auditor findings adopted)
1. **Mutants for R3's second half.** Besides "parse above `authorize`" (D9/W3/W4 must red), the READY mutant pass
   adds two positions in the auditor's worktree: parse moved **above the minute parses** (D10 must red) and parse
   moved **above the self-adjudication block** (D11 must red). All three reds quoted in FINDINGS.
2. **Leap-year legs.** D12: `'2024-02-29'` saves (positive control). D13: `'2026-02-29'` is refused with D1's
   sentence and nothing is written. These pin step 4 against a wrong days-in-month rule, which D3 alone does not.
3. **Compile pin location:** the domain-direct TEST file (tester path), copied through the `void` line (`:472`).
4. **Baseline** is `3372e5e` (header updated).
5. **Named, not fixed:** `getEmployment` throws `No employment ${id}` (`adjustments.ts:82`) before `authorize`
   (`:84`) — an existence oracle for an employmentId to an unauthorised caller. Out of scope here (the gate needs the
   lookup); logged as a finding for a later authorise-first pass. R2's sentence interpolates the raw value without a
   length cap — the same exposure as T-352's minutes sentence, no new risk.
- **Concurrency note:** `tests/unit/t343-throw-ratchet.test.ts` and `production-caller-ratchet.test.ts` measure the
  tree; if T-361 runs concurrently, a red there may belong to the other lane.
