# T-299 — DEF-325: the migration-from-zero proof times out under full-suite load

> **Status: 2026-09-13 — SLICE 1 (DEF-328) spec below, awaiting APPROVED. Slice 2 (DEF-325,
> the task this file was originally opened for) follows once slice 1 lands.**
> system32-85 measured CI directly (`gh run view --log-failed` on 34699289872, 34699937686,
> 34704090611) and found DEF-325 has never once been the CI failure — filed as **DEF-328**, put in
> front of this task as T-299's first slice. Both slices share this task number per the register's
> own disposition column for DEF-328.

## Slice 1 — DEF-328: `ci.yml`'s two Firebase project-id placeholders disagree

Source: `docs/DEFECTS-REGISTER.md` DEF-328.

### The finding, as measured by the orchestrator

`.github/workflows/ci.yml:40` sets `FIREBASE_PROJECT_ID: ci-placeholder`; `:44` sets
`NEXT_PUBLIC_FIREBASE_PROJECT_ID: ci`. `packages/core/src/env.ts:201-209` (T-292, DEF-315) fires
whenever both are set and differ, and `loadServerEnv` throws the *"Shareat System REFUSED TO
START"* banner. Every integration test file loads server env, so **109 of 122 integration files
fail on this banner** in every recent CI run — confirmed at 3253 occurrences across three runs.
The unit suite and typecheck pass because neither loads server env, which is why this was invisible
to every gate except the integration step. DEF-325 (slice 2 below) is a real, separate, purely
local finding — it has never appeared as a CI failure, because in CI `position-defaults.test.ts`
dies on this same banner before it ever reaches its own body.

### Placeholder-collision check, done before picking a replacement

`git grep` for the literal strings `ci-placeholder` and `"ci"` / `: ci` across the repo: neither
value is asserted, matched, or branched on anywhere outside `ci.yml` itself (`docs/DEFECTS-REGISTER.md`'s
own DEF-328 row is the only other hit, describing this defect). No test, fixture, or script depends
on either literal. Local dev (`.env.local`) already sets both `FIREBASE_PROJECT_ID` and
`NEXT_PUBLIC_FIREBASE_PROJECT_ID` — to the same real value, which is why this has only ever
surfaced in CI.

### Goal

Make `ci.yml`'s two project-id placeholders the same string, so T-292's contract check
(substantively correct, not in scope to touch) has nothing to disagree about.

### Scope — the exact change

- `.github/workflows/ci.yml:40` — `FIREBASE_PROJECT_ID: ci-placeholder` → `FIREBASE_PROJECT_ID: ci`.
  Matches the existing convention already used by all five `NEXT_PUBLIC_FIREBASE_*` lines
  (`:42-46`, all literally `ci`) rather than inventing a second placeholder scheme — the smaller,
  more consistent diff (bible §0.2, boring over bespoke).
- `docs/tasks/299-def-325-from-zero-migration-timeout.md` — this section.

### Contract / invariants

1. ⛔ `packages/core/src/env.ts` is untouched. The guard is correct; the configuration was wrong.
2. Only line 40 of `ci.yml` changes. The other 44 lines, including all five `NEXT_PUBLIC_FIREBASE_*`
   placeholders, are already mutually consistent and stay as-is.
3. No test file changes — confirmed above that nothing asserts on either literal.

### Tests

Nothing in this repo runs `ci.yml`'s env block locally (it's GitHub Actions YAML, not consumed by
any test today — see the durable-fix question below). Validation is: reproduce the exact failure
locally with `ci.yml`'s literal values, confirm it disappears after the edit, one file, real output:

```
node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_laneb ^
  packages/domain/tests/integration/position-defaults.test.ts --repo C:\Users\ianla\webapps\shareat-system
```
run once with `FIREBASE_PROJECT_ID=ci-placeholder NEXT_PUBLIC_FIREBASE_PROJECT_ID=ci` exported
ahead of it (reproduces the banner), once more after unexporting / with the corrected pair (or
simply matching values) to confirm a clean pass. Both runs' real output quoted in the READY report.

### Durable-fix recommendation (to argue, not to build this slice)

Two options were on the table. **Recommending the unit test, not the shared-example-file:**

- ⛔ **"CI consumes `.env.example`" — does not actually work here.** Checked: `.env.example`'s
  `FIREBASE_PROJECT_ID=` and `NEXT_PUBLIC_FIREBASE_PROJECT_ID=` (lines 56 / nearby) are documentation
  with blank values by design — there is no literal to source into CI's YAML `env:` block, and
  wiring GitHub Actions to read an arbitrary dotenv file for its `env:` section needs a new script
  step (`echo ... >> $GITHUB_ENV`) that doesn't exist today — a bigger, riskier change than this
  defect calls for.
- ⭐ **A unit test that runs `checkValueContracts`-equivalent logic against `ci.yml`'s own env
  block, living in `tests/unit/`.** Parse the workflow YAML (a small, already-available dependency
  or a targeted regex against the known `env:` block — either is cheap), build the same shape
  `checkValueContracts` expects, and assert zero failures. This runs in the **unit** project, which
  is fast and runs first — so the next contract T-292's guard learns breaks a local `npm run test`
  in seconds, not a 30-minute red integration run a day later. It directly closes the exact silent
  class DEF-328 is, at the layer where it was actually invisible.

## Slice 2 — DEF-325: the migration-from-zero proof times out under full-suite load

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
