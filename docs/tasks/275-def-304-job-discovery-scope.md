# T-275 — DEF-304: `scheduler-jobs-have-callers.test.ts`'s job discovery is blind outside one file

> **Status: ✅ COMPLETE — shipped 2026-09-12, `e00549a`, lane A.** Plant-proven in four states, including the one that proves the OLD guard was blind. DEF-309 was filed out of this task’s spec phase.

## The defect, precisely

`tests/unit/scheduler-jobs-have-callers.test.ts`'s `jobEntryExports()` reads exported `run*` job
entries out of exactly one hardcoded path, `SCHEDULER_FILE = 'packages/domain/src/scheduler/index.ts'`
(`tests/unit/scheduler-jobs-have-callers.test.ts:32,101-111`). `runRecurringExpenses`
(`packages/domain/src/recurring-expenses/job.ts:89`) is a real, correctly-wired top-level job entry
— `scripts/recurring-expense-draft.ts:47` calls it — but it lives in its own module, not
`scheduler/index.ts`, so this guard has never once looked at it. Not merely uncalled: **invisible**.
If `scripts/recurring-expense-draft.ts` ever lost that one call site, this guard would stay green,
because its population never included the function that would have gone orphaned.

Same shape, same fix, as DEF-295 (`tests/unit/system-transaction-callers.test.ts`'s own history):
a guard whose scanned set does not match what it claims to scan is not closed, it only looks closed.

## Implementation spec, lane A

### Measurement — not the guessed 8, the actual 13 raw matches, 8 real, 2 false positives found

Per the orchestrator's instruction to measure rather than trust arithmetic:
`git grep -n "^export \(async \)\?function run" -- 'packages/domain/src/**/*.ts'` (excluding
`.test.ts`) returns **13** candidates. Applying the CURRENT exclusion filter
(`/^_?(org|tx|trx)\s*:/` on the first parameter) to each, by hand, against the real source:

| Function | File | First param | Current filter says |
|---|---|---|---|
| `runDepreciation` | `fixed-assets/depreciate.ts:191` | `tx: Tx \| null` | excluded (`tx:` matches) — correct, this is the human-actor-gated core, `domain-actions-have-callers.test.ts`'s population |
| `runDepreciationAsSystem` | `fixed-assets/depreciate.ts:238` | `orgId: string` | **NOT excluded — false positive** |
| `runAmortisationAsSystem` | `prepaid/index.ts:548` | `orgId: string` | **NOT excluded — false positive** |
| `runRecurringExpenses` | `recurring-expenses/job.ts:89` | `options: {...} = {}` | included — **the real target of this task** |
| `runJobForOrg` | `scheduler/index.ts:120` | `org: {...}` | excluded (`org:` matches) — correct |
| `runMonthEnd` | `scheduler/index.ts:231` | `options` | included — known |
| `runAttendanceSweep` | `scheduler/index.ts:316` | `options` | included — known |
| `runFirestoreRelay` | `scheduler/index.ts:423` | `drivers: {...}` | included — known |
| `runOrderWastageBackstopSweep` | `scheduler/index.ts:618` | `options` | included — known |
| `runFindingObservation` | `scheduler/index.ts:673` | `options` | included — known |
| `runBudgetReissue` | `scheduler/index.ts:761` | `options` | included — known |
| `runOrphanFileSweep` | `scheduler/index.ts:904` | `options` | included — known (T-272) |
| `runOrderWastageBackstop` | `wastage/orders.ts:563` | `trx: Tx` | excluded (`trx:` matches) — correct, the per-tx core `runOrderWastageBackstopForOrg` wraps |

**⛔ A naive widen (same regex, same filter, wider file set) produces 10 matches, not 8: 7 known +
`runRecurringExpenses` (real) + `runDepreciationAsSystem` + `runAmortisationAsSystem` (both false
positives).** Both false positives share one shape neither `org|tx|trx` nor the file's own stated
reasoning anticipated: a first parameter literally named `orgId`, the T-140 "pushed down into the
domain module" idiom (discovery doc `34-scheduled-job-pattern.md` §3.2) — these are per-org helpers
that `scheduler/index.ts`'s own PRIVATE `runDepreciationJob`/`runAmortisationJob` wrap and call, one
level of indirection below where a `scripts/*.ts` caller would ever mention them by name. Left
unfixed, the widen would not just miss `runRecurringExpenses` less — it would turn two currently
green, correctly-wired functions into false "no caller" failures, which is worse than todays's blind
spot: DEF-304 is a false NEGATIVE (silently misses a real gap); an unfixed widen introduces a false
POSITIVE (cries wolf on functions that are fine). Both are guard failures; only one is mine to avoid
by fixing the exclusion filter in the same change, not by reporting it and stopping — it is squarely
inside the one file I am scoped to and is a correctness bug in the exact mechanism this task builds.

**The real, measured, correct count is 8**: the 7 already in `KNOWN_JOB_NAMES` plus
`runRecurringExpenses`, once the exclusion filter also recognises `orgId` as a per-org identifier
parameter, same as `org`/`tx`/`trx`.

### Contract

- Replace `SCHEDULER_FILE` (one hardcoded path) with a scan of every tracked, non-test `.ts` file
  under `packages/domain/src/`, on the DEF-295 pattern already proven in
  `tests/unit/system-transaction-callers.test.ts`: `git ls-files -z --cached --others
  --exclude-standard` (never a directory walk — `apps/erp/.next` holds turbopack copies of the
  domain barrel and would report every export as called forever, the same reasoning that file's own
  header already states), filtered to `packages/domain/src/` and excluding `.test.ts`/`/tests/`.
- `jobEntryExports()` runs its existing per-file regex extraction over each such file instead of one,
  building one `Map<name, file>` — the map's value (declaring file) now genuinely varies, so the
  "always `SCHEDULER_FILE`" note in its doc comment is deleted along with the constant.
- The per-first-param exclusion regex becomes `/^_?(org|orgId|tx|trx)\s*:/` — the ONE line that
  changes the actual filtering behaviour; everything else is scope, not logic.
- `KNOWN_JOB_NAMES` gains `'runRecurringExpenses'` (sorted), for a total of 8.
- The size floor (`toBeGreaterThanOrEqual`) rises from 7 to 8, matching BLOCKER-1's own lesson: a
  floor equal to today's true count cannot see a hole appear later, but a floor BELOW the true count
  is worse — it cannot see today's hole either. 8 is measured, not guessed.
- Doc comments naming "the six top-level job entries" (already stale at 7 since T-272) and "always
  `SCHEDULER_FILE`" are corrected to describe the widened scan and the real count in the same change.

### The two guards' discovery mechanisms — answering the question asked, not just building the change

`tests/unit/scheduler-job-hosting.test.ts` (T-273) discovers jobs by importing the **typed
`SCHEDULER_JOBS` union** and mapping each member through the hand-maintained `JOB_SCRIPT` table.
`tests/unit/scheduler-jobs-have-callers.test.ts` (T-236/T-275) discovers jobs by **regex-scanning
exported function shapes** across source files. These are not two instruments aimed at the same
target — they answer genuinely different questions, and **neither should replace the other**:

- T-273 asks: *for every value the `scheduler_runs.job` CHECK constraint can accept, does a
  `.service`/`.timer` pair exist to host it?* Its population is enum membership.
- T-236/275 asks: *for every function that LOOKS like a job's code entry point, does something on
  disk actually call it?* Its population is a TypeScript declaration shape.

**A job can be constructible that only one of them sees, in both directions — and one such gap is
real and undetected by either, today:**

1. **T-273 sees it, T-236/275 does not (already disclosed, not new).** A job could be registered in
   `SCHEDULER_JOBS`, given a `JOB_SCRIPT` entry and real units, but written as
   `export const runFoo = async (options = {}) => {...}` instead of a `function` declaration, or
   re-exported under a second name. T-236/275's own doc comment already names this as a stated,
   accepted limit ("the gap is real but currently empty") — widening file SCOPE in this task does
   nothing for this axis, which is declaration-SHAPE blindness, a different defect.

2. **T-236/275 sees it, T-273 does not — also already true, not new, and benign.** A function
   shaped like a job entry with a real `scripts/*.ts` caller, but never added to `SCHEDULER_JOBS` at
   all, is outside T-273's population (which only iterates registered enum members) but inside
   T-236/275's (which finds it by shape, not by registration). Not a contradiction — the two guards
   simply do not promise to agree on a function neither has any obligation to.

3. **⭐ The one gap that is real, constructible today, and caught by NEITHER guard — described, not
   closed, per the question asked.** A function could be shaped exactly like a job entry, live under
   `packages/domain/src/`, be registered in `SCHEDULER_JOBS`, have a real `scripts/*.ts` caller AND
   an armed timer — and still never call `runJobForOrg` internally, so it never writes a
   `scheduler_runs` row at all. T-236/275 (post-fix) would call it wired (it has a caller — true).
   T-273 would call its unit pair present (true). **Both are individually correct and the job still
   runs invisibly** — DEF-044's exact shape, arrived at from the opposite direction: not "nothing
   calls this," but "something calls this and it leaves no trace when it does," which is precisely
   the failure `scheduler_runs` exists to make impossible (bible §13 row 181's sweep-control
   landmine, one layer over). Neither existing guard asks "does this job's body actually reach
   `runJobForOrg`" — that would need reading INTO the function body, not just its declaration, which
   is a different and harder guard than either of these two. **Not building it in this task** — out
   of scope (DEF-304 is a file-scope bug in an existing guard, not a request for a third one) —
   naming it for the orchestrator to file if it's judged worth a row.

### Proof plan — DEF-295's own standard, not a smaller one

1. Before touching the test file: create a throwaway file, `packages/domain/src/_plant-def304.ts`,
   containing one export shaped exactly like a job entry
   (`export async function runPlantDef304Probe(options: { orgId?: string } = {}) {...}`) with
   **no** `scripts/*.ts` caller anywhere.
2. Run the CURRENT (unmodified) `tests/unit/scheduler-jobs-have-callers.test.ts` and confirm it
   stays green with the plant present — proving the OLD guard is blind to it, not merely that it
   happens to pass today.
3. Apply the widened scan + fixed exclusion filter.
4. Re-run and confirm the widened guard FAILS, naming `runPlantDef304Probe` as an orphan needing a
   caller or a written exemption.
5. Delete `packages/domain/src/_plant-def304.ts`. Re-run and confirm the tree is clean and green
   again — T-273 left probe residue behind once and only caught it because it checked; checking here
   too.
6. Report all three real states (old guard blind / widened guard catches / clean after deletion) in
   READY, not just the final green.

### Out of scope

- `tests/unit/scheduler-job-hosting.test.ts` — T-273's sibling guard, already correct, not touched.
- `packages/domain/src/**` — the two false positives (`runDepreciationAsSystem`,
  `runAmortisationAsSystem`) are handled entirely by fixing the TEST's exclusion regex; neither
  function is renamed or otherwise touched.
- Building a guard for gap 3 above (a job that is called, registered and armed, but never reaches
  `runJobForOrg`) — described only.
- `docs/DEFECTS-REGISTER.md`, `PROJECT_BIBLE.md` — reporting, not editing.

### Tests / Done-when

Unit-only; no integration DB involved (this guard reads source files, not a database).
typecheck clean · `npm run test` green, including both scheduler guard files · the plant-and-prove
sequence executed with its three real states reported · self-reviewed line by line · this file's
status line updated at the end.
