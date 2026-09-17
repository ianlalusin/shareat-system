# T-319 — a remittance before anything is verified is refused, not silently unrecorded

> ### **Status: SPEC — written 2026-09-17 by `system32-85` (Opus planner). NOT BUILT. Reserves T-319. Closes DEF-358.**
>
> **Ian's ruling, 2026-09-17.** Shown both shapes in plain language — record the difference against
> the store and date with no day attribution, or block the handover until something is verified —
> and told plainly that refusing **changes how his cashiers close and they would need telling**, he
> chose **REFUSE**.
>
> ⭐ **And the discovery pass then found that it costs nothing operationally**, which he should know
> and which is the strongest argument for doing it now — see *What research settled* below.

## Why this exists

`createRemittance` filters the day reports to `settleable = reports.filter((r) => r.remittable &&
Number(r.owed) > 0)` (`packages/domain/src/remittance/index.ts:125`), where `remittable` means
`sd.status = 'verified'` (`packages/db/src/repo/remittance.ts:99`). With nothing verified,
`settleable` is empty, `days` is empty, and `allocateFifo` returns a **positive `variance` with
`varianceDayId` null** (`packages/domain/src/remittance/allocate.ts:64-89`).

The variance write is then guarded by `if (Number(result.variance) !== 0 && result.varianceDayId)`
(`index.ts:178`). **That condition is false, so the guard skips the variance row — while the
remittance row and every money transfer have already been written above it.**

⛔⛔ **THE CASH MOVES AND NOTHING IS WRITTEN DOWN.** T-143's whole premise is *"remittance variances
that can't hide"*, and its screen renders open variances first, above everything, by Ian's own
instruction. **A variance that was never written cannot be rendered first.**

⛔ **And the null is load-bearing in the wrong direction:** `varianceDayId` is null *precisely
because* there is no verified day to attribute the difference to — so **the condition that makes the
variance most worth recording is the condition that suppresses it.**

## What research settled — `docs/discovery/35-cash-closing-before-verification.md`

Read it before building. Four findings change how this is specced:

1. ⭐⭐ **The refusal costs nothing operationally, and this is the headline.**
   `apps/erp/src/app/remittance/page.tsx:295` already gates the whole handover form on
   `remittable.length > 0`, so **the one real screen structurally cannot reach this trigger today.**
   ⛔ **But that is an ACCIDENTAL client-side-only gate, which RULES §1 rule 7 exists to forbid** —
   it protects the screen and nothing else. A refusal in `createRemittance` costs today's screen
   nothing and closes the hole for **every other caller**: a script, a test, a future POS.
2. ⛔ **Do NOT copy v1's answer.** v1 auto-verifies the day inline when you remit an open one
   (`sales-report.actions.ts:95-109`). **T-318 has just made `verify_sales_day` and
   `submit_sales_day` separately position-grantable** — folding one into the other would silently
   bypass a store's deliberate choice about who may do which. ⚠️ v1's *sequential-verification* gate
   at submit is a different thing and **v2 already ported it** (`sales-days/create.ts:112,126-142`).
3. ⭐ **Sequencing that nobody had noticed, and it decides the order of the next task.** DEF-357 and
   T-316 independently rejected *"cap the handover at what is owed"* for the same reason: `owed` is
   zero while nothing is verified, so the cap would refuse everything. **If this task refuses first,
   `owed > 0` is guaranteed whenever a remittance proceeds — and that rejected cap becomes safe to
   write.** ⛔ DEF-357 must come after this, not with it.
4. ⚠️ **No production count exists.** `shareat_dev` holds 0 remittances, 0 variances, 2 verified
   sales days — a seed database, not evidence. **Nobody can say how often this has happened**, and
   the discovery said so plainly rather than estimating. ⛔ **Do not write a frequency claim into
   any comment.**

## Scope — the only paths this task may create or modify

- `packages/domain/src/remittance/index.ts` — the refusal, in `createRemittance` only.
- `packages/domain/tests/integration/remittance.test.ts` — the paired red control and the cases below.

⛔ **Out of scope and orchestrator-owned:** `PROJECT_BIBLE.md` (report the row, do not write it) ·
`docs/ROADMAP.html` · `docs/DEFECTS-REGISTER.md` · every other `docs/tasks/*.md`.

## Contract

1. **`createRemittance` refuses when there is nothing to settle**, and the refusal is thrown
   **BEFORE `insertRemittance` and before the money-transfer loop** — i.e. immediately after
   `settleable` is computed at `index.ts:125`.
   ⛔⛔ **THIS ORDERING IS THE CONTRACT, NOT AN IMPLEMENTATION DETAIL.** The transfer loop
   (`index.ts:146-166`) moves real money through `createMoneyTransfer` before the variance guard is
   ever reached. **A refusal placed after it would leave transfers written for a remittance that
   then threw.**
2. **Two distinct refusals, because the remedy differs and a single message would mislead:**
   - **no verified day at all** on or before `remittedOn` → the person must verify a day first;
   - **verified days exist but every one owes zero** → there is nothing outstanding to settle, which
     is a different situation and not fixed by verifying anything.
   ⚠️ Both produce `varianceDayId === null` today and both must refuse. **One message for both
   would send somebody to verify a day when a verified day already exists.**
3. **The message names the store's state and what to do**, in the voice of the existing throws in
   this file (`index.ts:83, 91, 93, 109` — plain sentences, prefixed `createRemittance:`).
4. **Nothing is written on the refusal path.** No `remittances` row, no `remittance_lines`, no
   `money_transfers`, no allocations, no variance.
5. ⛔ **The `varianceDayId` guard at `index.ts:178` STAYS.** After this refusal it becomes
   unreachable on this path rather than wrong. **Deleting it would leave the next caller unprotected
   for a reason nobody wrote down** — and `reverseRemittance` and `resolveRemittanceVariance` share
   this module.

## Invariants, with citations

1. **No client-side-only authorization or validation** — RULES §1 rule 7. The screen's
   `remittable.length > 0` gate is not the control; this is. The screen keeps its gate.
2. **The database enforces the rules, not the service layer** — RULES §6 item 3, bounded by §15.11:
   **no layer may be the only one for a given risk.** ⭐ **ASSESS AND REPORT, DO NOT BUILD:** say
   whether a deferred constraint trigger asserting *"a non-reversed remittance has at least one
   allocation"* is worth a migration, or whether the domain refusal plus the screen gate already
   satisfy §15.11. ⛔ **Do not write a migration in this task** — `0153` is free if we decide yes,
   and that is a separate decision.
3. **Tests before implementation, failing for the right reason** — RULES §3.2. See below; the red
   control is the point.
4. **No money in floats** — RULES §1 rule 6. Untouched by this task; do not introduce arithmetic.

## Tests — integration, real Postgres, the lane's own DB

⛔⛔ **THE RED CONTROL COMES FIRST AND IT IS THE WHOLE EVIDENCE.** Before the refusal exists, write a
test proving **today's** behaviour: with no verified day, `createRemittance` **succeeds**, the money
transfers exist, and **no `remittance_variances` row was written.** Watch it pass. *That* is DEF-358
reproduced. Then add the refusal and invert it.

⭐ A test that only ever passed proves nothing (RULES §3.2), and this defect has never had a test —
which is why it survived.

1. **Red control**, as above — reproduce the hole, then invert.
2. **Refuses with no verified day**, and the error names the verify remedy.
3. **Refuses when verified days exist but all owe zero**, with the *other* message.
4. **Still succeeds normally** — one verified day owing something, allocation written, money moved.
   ⛔ Without this the refusal could be over-broad and every test above would still pass.
5. ⛔ **Nothing written on refusal** — assert zero rows in `remittances`, `remittance_lines` and
   `money_transfers` for that store afterwards. **This is the test that catches a refusal placed
   below the transfer loop**, which is the one way to get this task badly wrong.

## Out of scope

- **DEF-357's cap** on the handover amount. It comes *after* this (finding 3) and is its own task.
- **Any screen change.** `page.tsx:295` already gates the form; leave it.
- **v1's auto-verify-inline behaviour** (finding 2).
- **Any migration**, including invariant 2's candidate trigger — assess and report only.
- ⚠️ **`apps/erp/src/app/remittance/actions.ts:89-97`**, where the success message reads
  `result.variance` when it should read `result.varianceId`. Found in passing by the discovery lane.
  **It is filed separately and is NOT yours** — and note it stays harmless under this task's fix,
  because refusing means the two never disagree.

## Done when

- A remittance before anything is verified is refused, with the right one of two messages.
- The red control has been seen to pass *before* the fix and fail *after* it, and that is reported
  as the real command output rather than described.
- Nothing is written on the refusal path, proven by the row counts in test 5.
- Typecheck · unit · integration on the lane DB · `npm run build` with the dev server stopped ·
  the §15.11 assessment reported · the bible row reported to the planner.

## Needs from Ian

**Nothing.** The ruling is made and recorded. ⚠️ **One thing to tell him at the end, not to ask:**
because the screen already gates the form, **his cashiers will notice no change** — the refusal
protects every non-screen caller. That reverses the warning he was given when he made the decision,
and he should hear it plainly rather than be left with the original caution.
