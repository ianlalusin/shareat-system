# T-299 — DEF-325: the migration-from-zero proof times out under full-suite load

> **Status: RESERVED 2026-09-13 by system32-85 — dispatched to lane B (webapps-4e, Sonnet 5).**
> Number reserved before dispatch. Spec to be written by the lane and approved by the
> orchestrator before any edit.

Source: `docs/DEFECTS-REGISTER.md` DEF-325.

## The measurement on record

`packages/domain/tests/integration/position-defaults.test.ts:537` (T-289 case 13) —
`Test timed out in 30000ms` inside the full suite (1 failed / 2834 passed / 122 files / 1828s),
and **19/19 in 20.56s when the file is run alone**, verified on the same database minutes later.

It creates a scratch database and runs all 146 migrations from zero while 121 other files work the
same Postgres instance.

## ⛔ The constraint on the fix — from Ian, not negotiable

- Give **that one test** its own timeout, **measured under load**.
- ⛔ Do **not** raise the project-wide default.
- ⛔ Do **not** weaken the test. Migrating from zero on a scratch database is the only thing that
  proves a migration applies to an empty database — it is what migration `0145` never got.

## Why this blocks everything else today

`deploy.yml` triggers on `workflow_run` of CI completing on `main`. `ci.yml:80` runs the integration
suite. While this test is red, **CI is red, and Deploy is `skipped` — it never even starts.** Runs
`34699912489` and `34700481646` are both `skipped` for this reason. This lane is not cosmetic; it is
the gate in front of lane A's fix.
