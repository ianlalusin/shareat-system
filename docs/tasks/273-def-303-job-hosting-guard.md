# T-273 — DEF-303/DEF-299: a job that nothing runs must fail the build, not wait to be noticed

> **Status: RESERVED by the orchestrator, 2026-09-12.** Lane B (`webapps-65`, Sonnet).
> ⛔ **No migration slot** — lane A holds `0143`. Report a needed schema change as BLOCKED.

## Goal

Nothing in this repository compares the scheduler's own job list against the `.service`/`.timer`
pairs in `docs/ops/`. Make that comparison a test, so a registered job with nothing to run it fails
in CI instead of being found by eye.

## Why this is worth a task — four instances, and the newest two were a day apart

| | |
|---|---|
| DEF-186, DEF-226 | earlier members of the same family — built, registered, callable, nothing calling it |
| **DEF-299** | `sweepOrphanedFiles` had no production caller at all, and the codebase described it as *"a cron across every organisation"*. Found 2026-09-11 by a lane asking a question |
| **DEF-303** | `budget_reissue` is in `SCHEDULER_JOBS`, in the live `scheduler_runs_job_check`, implemented as `runBudgetReissue`, reachable by npm script — and has **neither** unit file. Found 2026-09-12, by eye, reading two listings side by side |

⭐ **Both of the last two were found by a person happening to look.** The comparison is mechanical:
one list is `SCHEDULER_JOBS` in `packages/domain/src/scheduler/index.ts`, the other is `ls docs/ops`.
A test does it in milliseconds and never forgets. **Without it, an eighth job goes the same way and
is found months later by someone noticing a number looks wrong.**

## Scope — the only paths you may create or modify

- `tests/unit/` — one new test file.

⛔ Nothing else. Do **not** add the missing unit files — DEF-303's are T-272's to write, and lane A
owns `packages/**` this cycle.

## Contract

1. A **unit** test, no database — it must run in `npm run test`, which CI runs before migrations.
2. Read `SCHEDULER_JOBS` from the scheduler module. ⛔ **Import the constant; never re-type the job
   names.** A hand-copied list is the thing that drifts (DEF-242's lesson).
3. Enumerate `docs/ops/` from disk. For each job, assert a `.service` **and** a `.timer` exist.
4. Naming is `shareat-<job with underscores turned to hyphens>.{service,timer}` — ⚠️ **verify that
   against the six that exist rather than trusting this sentence.** `attendance_sweep` →
   `shareat-attendance-sweep.*`. If any of the six does not follow it, the mapping is not a rule and
   the test must encode what is actually true.

## Invariants

1. ⛔ **The exemption list must not become DEF-296.** `budget_reissue` has no units today and the
   test would fail without an exemption — so it needs one, commented with the defect number. **But
   DEF-296 was precisely a staleness check that could not detect staleness**: it verified an
   exempted file still existed, never that it still *needed* the exemption.
   ⭐ **So this test must fail in BOTH directions:** a job missing its units and not exempt → fail;
   **a job that IS exempt but now HAS its units → also fail**, telling the reader to delete the
   exemption. An exemption that silently outlives its reason is the bug this project keeps refiling.
2. A `.service`/`.timer` pair in `docs/ops/` that matches no known job should be reported too — the
   comparison is worth making in both directions. ⚠️ Check first whether any such file exists
   legitimately (`shareat-erp.service` is the app itself, not a job; `month-end-retry.timer` is a
   second timer for one job). **Encode what is true, do not force the six into a shape they are not
   in.**

## Tests

The test IS the deliverable. Prove it has teeth the way T-271 part 2 did:
- Temporarily add a fake job name to a local copy of the list and watch it fail. Report the output.
- Temporarily "satisfy" the `budget_reissue` exemption and watch invariant 1's second direction fail.
- ⛔ Restore both by edit, not by git, and prove `git diff` is clean afterwards.

## Out of scope

- ⛔ Writing the missing unit files for `budget_reissue` — T-272's.
- ⛔ Arming anything on the droplet — Ian's, and `docs/ops` does not ship (DEF-194).
- ⛔ `packages/**`, `docs/ops/**`, the registers, any migration.

## Done when

typecheck clean · `npm run test` green with the new file · both teeth checks reported with real
output · `git diff` clean of the temporary probes · a `FOR IAN` block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-303, DEF-299, DEF-296, DEF-242, DEF-226, DEF-186;
`docs/discovery/34-scheduled-job-pattern.md`; `docs/ops/README.md`.
