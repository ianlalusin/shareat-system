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

## The measurement on record (original, DEF-325's filing)

`packages/domain/tests/integration/position-defaults.test.ts:537` (T-289 case 13) —
`Test timed out in 30000ms` inside the full suite (1 failed / 2834 passed / 122 files / 1828s),
and **19/19 in 20.56s when the file is run alone**, verified on the same database minutes later.

It creates a scratch database and runs the migration chain from zero while 121 other files work the
same Postgres instance.

## Correction to the filing (Q3): the migration count is 130, not 146

Checked in the file rather than trusting the wording, per the briefing's own instruction.
`packages/db/migrations/meta/_journal.json` has **130 entries**; `146` is the highest **reserved
idx**, and 17 idx slots (73–79, 90–99) are reserved-but-unused gaps (ADR-012 §2.1, DEF-091 —
`docs/decisions/ADR-012-hand-authored-migrations.md:40-41,55,60` documents the same gap mechanism
at an earlier count). The test's own comment (`position-defaults.test.ts:561-563`) already warns of
exactly this distinction; DEF-325's filing didn't apply it. The scratch database replays 130
migrations, confirmed by asserting the journal length against `drizzle.__drizzle_migrations`'s row
count, which is what the test itself does at line 571.

It does create its own scratch database every run (`shareat_test_scratch_t289`, lines 538-551), not
reuse the lane database — confirmed by reading the file. The name is **hardcoded**, not derived from
the lane/caller's own database name, and it is created on the same Postgres **server** as whatever
`TEST_DATABASE_URL` resolves to (only the URL's pathname changes — host, port, user, password are
untouched). See the new finding below for what that hardcoding implies.

## Slice 1 changes what CI shows (this changed the whole shape of slice 2)

DEF-328 (slice 1, `5bd6d44`) was the real CI blocker, not this test. With it fixed, CI run
`34705670725` gave the first honest integration measurement in over a day: **122 files passed, zero
failures**, and `T-289 case 13` itself completed in **~5.5s** (started 16:39:45.99 after case 12,
finished 16:39:51.45) — against the 30s budget, on a shared GitHub Actions runner running all 122
files against one Postgres. **DEF-325 has never reproduced in CI at all.** It is a real, local-only
finding.

## Local measurement, and a new finding it surfaced

Per the orchestrator's (c) plan: CI figure above, plus a bounded local run (position-defaults.test.ts
alongside `reports.test.ts`, `stock-transfers.test.ts`, `production.test.ts`, `post-entry.test.ts`
against `shareat_test_laneb` — **not** the full 122-file suite, which OOM-killed this shared machine
minutes earlier mid-run and was abandoned per the orchestrator's explicit instruction not to retry it
(a peer session's work is worth more than this measurement — see the handoff note below).

**Five local attempts over roughly fifteen minutes, three lane/orchestrator sessions concurrently
busy on this one machine, `Get-CimInstance Win32_OperatingSystem` showing 3.5 GB free of 15.6 GB at
the time:**

| # | Configuration | Result |
|---|---|---|
| 1 | Bundled with 4 other files, default 30s ceiling | **hit the ceiling — 30008ms, did not complete** |
| 2 | Same bundle, `--testTimeout=180000` (CLI-only override, not committed) | 2723ms |
| 3 | Alone, default 30s ceiling | **hit the ceiling — 30017ms, did not complete** |
| 4 | Alone, `--testTimeout=180000` | 2307ms |
| 5 | Alone, `--testTimeout=180000` | 2127ms |

⚠️ **This is not the shape DEF-313 measured, and I want that said plainly rather than folded into
"slower under load."** DEF-313's own numbers drift smoothly with ambient load (2906ms → 5145ms →
5681ms, tens of runs). Mine are **bimodal** — fine in ~2.1-2.7s, or stuck against whatever ceiling is
configured, with nothing in between across 5 attempts, including two attempts where I widened the
ceiling to 180s specifically to try to catch a real "slow" completion time and both landed in the
fast bucket instead. **I do not have a real measured duration for the slow case — only that it
exceeds whatever ceiling is set.** That is a materially weaker basis for a number than DEF-313 had,
and I'm saying so rather than presenting a confident figure I don't have.

I checked one live hypothesis: a `pg_stat_activity` query for connections to any `shareat_test%`
database, run immediately after one attempt, showed no residual connection to the scratch name and
no lock wait — but the race window (if this is a cross-lane collision on the hardcoded scratch-DB
name) is narrow, and one clean snapshot after the fact doesn't rule it out. I did not chase this
further given slice 1's urgency and the orchestrator's instruction against repeating the expensive
full-suite run; flagging it as unresolved rather than as either confirmed or dismissed.

⭐ **Handoff note, at the orchestrator's request, not a register row:** a full local integration run
is not safely repeatable while multiple lane sessions share this machine — the failure mode observed
today was not a slow test but an OOM that could have killed a peer session mid-task. The bounded
5-file run above is the safe substitute and what produced the numbers in this table.

## Answers to the four original questions

**Q1 — the measured number, and how.** Two real numbers, kept separate per the orchestrator's
instruction not to average them: **CI, ~5.5s**, on the box that gates deploy, inside a genuine
122-file full run, zero failures. **Local, bimodal**: 2.1-2.7s three times, or a hard stop at
whatever ceiling was configured twice, on this shared dev machine under real (if unusually acute —
see the OOM handoff note) multi-session contention. Method for both: `gh run view` on
`34705670725`'s timeline for CI; `node it.mjs shareat_test_laneb --reporter=verbose [...files]`
(plus a CLI-only `--testTimeout` override on some attempts to try to observe a real slow-completion
time, which never landed) for local.

**Q2 — remedy or symptom, argued both ways.** The CI number alone says the current 30s budget is
already generous (~5.5x headroom) and case 13 was never CI's problem — DEF-328 was. Read narrowly,
slice 2 doesn't need to exist for CI's sake. But this project also treats the **local** full/bounded
integration run as a real gate (the wrap-up ritual, and the register's own precedent about a false
red costing a wrap-up its credibility), and on this machine, right now, that gate does fail this test
intermittently. A generous per-test override costs nothing when the machine is fast and prevents that
false red when it isn't — the orchestrator's lean (a), and I agree with it, **for that reason
specifically, not because I've shown the local slowness scales with migration count.** The
migration-count growth story in the original briefing (a timeout that "expires again at migration
~200") is milder than feared on the evidence I have: CI's ~5.5s for 130 migrations is mostly fixed
per-migration overhead in an otherwise-idle run (~42ms/migration), so even several hundred more
migrations stays well inside 30s **on a quiet box** — the real open risk isn't migration count, it's
the bimodal local stall, whose root cause I could not pin down (leading candidates: this machine's
current memory pressure — corroborated by the concurrent OOM-kill of the abandoned full-suite run —
or the scratch database's hardcoded name creating a collision surface between concurrent lanes on one
shared Postgres server, unconfirmed). **Recommendation: ship the small per-test fix now (it is free
and correctly targets what's actually observed — an intermittent local stall, not a growing
performance cost), and file the bimodal-stall root cause as its own durable investigation, separate
from a migration-count worry.** I am not building that investigation in this slice.

**Q3 — 146 real, own database, whose server.** No — 130 (see correction section above). Yes, its own
scratch database every run, never the caller's lane database. Same physical Postgres server as
whatever `TEST_DATABASE_URL` resolves to — which is exactly what makes it contend (and, per the new
finding, possibly collide) with everything else live on that server.

**Q4 — existing override idiom.** None exists anywhere in this repo today: no `it(name, fn,
timeoutMs)` usage, no `vi.setConfig`, no per-file `testTimeout`/`hookTimeout` outside three
whole-project config blocks (root `integration` project, `firebase/vitest.config.ts`,
`spike/firestore-two-lane/vitest.config.ts`) — checked by grep, not assumed. Vitest's own documented
mechanism for exactly this need — a third `timeoutMs` argument to `it()` — is the boring, standard
choice given no repo convention exists yet to follow, and it matches DEF-325's own register
disposition wording: "a per-site override with a citation comment naming the measurement."

## ⛔ The constraint on the fix — from Ian, not negotiable

- Give **that one test** its own timeout, **measured under load**.
- ⛔ Do **not** raise the project-wide default.
- ⛔ Do **not** weaken the test. Migrating from zero on a scratch database is the only thing that
  proves a migration applies to an empty database — it is what migration `0145` never got.

## Why this no longer blocks deploy, and what it still is

`deploy.yml` triggers on `workflow_run` of CI completing on `main`. Originally filed as the reason
CI (and therefore Deploy) stayed red — **superseded**: DEF-328 was the actual blocker (§Slice 1);
DEF-325 has never once been the CI failure. It remains a real, verified **local** defect: an
intermittent false red on the gate this project's own wrap-up ritual runs, worth fixing for that
reason, not for CI's.

## Proposed fix

`packages/domain/tests/integration/position-defaults.test.ts:537-538` — add a third `timeoutMs`
argument to case 13's `it(...)` call, with a citation comment naming this task doc, the CI figure,
and the local bimodal finding, so a reader meets the reason where they meet the number (T-285's
established shape). Proposing **120000** (2 minutes): roughly 22x the real CI figure (~5.5s), in
line with the orchestrator's "budget costs nothing when the machine is fast" reasoning, and 4x the
30s ceiling that two of five local attempts hit without completing. ⚠️ **Stated honestly: this is
not verified against an actual slow-run completion time**, since none of my attempts with a widened
ceiling landed on a slow outcome to measure. Open to a different number if the orchestrator wants
one — this is the figure I can defend, not one I'm certain is sufficient in the worst case.

## Scope — the exact files this task may create or modify

- `packages/domain/tests/integration/position-defaults.test.ts` — one line (the `it()` call's third
  argument) plus a citation comment immediately above it.
- `docs/tasks/299-def-325-from-zero-migration-timeout.md` — this file.

## Contract

1. The timeout override applies **only** to case 13's own `it()` call. No other test in this file,
   and no config file, changes.
2. `vitest.config.mts`'s `integration` project `testTimeout: 30_000` is untouched — it remains the
   budget for the other 2,833 tests.
3. The test body itself is unchanged: same scratch database, same from-zero migration replay, same
   assertions. Nothing about what the test proves is weakened.
4. The citation comment states plainly that the number absorbs an intermittent local stall of
   unconfirmed root cause and unmeasured worst-case duration — not a real performance budget — so a
   future reader doesn't mistake 120000 for a considered ceiling on migration-replay cost.

## Invariants

1. ⛔ Do NOT raise `testTimeout` at the `integration` project level or the top-level `test:` block.
2. ⛔ Do NOT touch `packages/db/migrations/**`, `ADR-012`, or the journal — this task is a test
   budget, not a migration change.
3. ⛔ Do NOT remove, mock, or shrink any part of the from-zero proof (scratch DB creation, full
   migration replay, the four-source admission check, the CHECK-constraint refusal) to make it
   faster. Ian's constraint forbids this regardless of how tempting a narrower test would be to time.
4. ⚠️ Do NOT present the CI figure and the local figures as one number. They measure different
   machines under different, non-comparable pressure — report both, always, per the orchestrator's
   instruction.

## Tests

1. Before: reproduce the two hard-ceiling failures above are already captured in this doc's
   measurement table (real output, already gathered — not re-run for this section).
2. After the edit: `node it.mjs shareat_test_laneb packages/domain/tests/integration/position-defaults.test.ts` — 3 consecutive real runs, real exit codes, expecting 19/19 pass each time
   (case 13 completing well inside 120000ms whichever bucket — fast or previously-stuck — it lands
   in).
3. `npm run typecheck` — confirm the added argument type-checks (vitest's `it` overload accepting a
   trailing number).
4. No change to `npm run test` (unit) expected — this file is integration-only; run it anyway and
   report the real numbers, unchanged from slice 1's baseline (109 files, 1464 passed, 1 skipped).

## Out of scope

- ⛔ Investigating or fixing the bimodal local stall's root cause (memory pressure vs. hardcoded
  scratch-DB-name collision across lanes) — flagged above as unresolved, not a fix I'm building here.
- ⛔ A shared/parameterized scratch-database name (e.g. suffixed by lane or PID) to close the
  cross-lane collision surface, if that turns out to be the real cause — a correctness-relevant
  change to the test's isolation strategy, not a budget tweak, and needs its own spec if pursued.
- ⛔ Any change to `packages/core/src/env.ts`, `.github/workflows/ci.yml`, or anything from slice 1 —
  already committed (`5bd6d44`).
- ⛔ `docs/DEFECTS-REGISTER.md` — out of this lane's scope; the bimodal-stall finding and the
  hardcoded-scratch-name hazard are reported here for the orchestrator to register, not self-logged.

## Done when

- `position-defaults.test.ts` case 13 carries a per-site timeout with a citation comment; no other
  line in the file changes.
- `vitest.config.mts` is untouched.
- typecheck clean; unit suite numbers unchanged from slice 1's baseline; 3 consecutive green
  integration runs of the file against `shareat_test_laneb`, real output each time.
- Self-reviewed line by line.
- Report ends with a `FOR IAN` block.

See `docs/DEFECTS-REGISTER.md` DEF-325, DEF-313, DEF-328; `docs/tasks/285-def-313-truncate-hook-timeout.md`;
`vitest.config.mts`; `packages/db/migrations/meta/_journal.json`; `docs/decisions/ADR-012-hand-authored-migrations.md`.
