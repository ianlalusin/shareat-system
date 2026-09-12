# T-285 — DEF-313: the fixture-cleanup hook that times out under load

> **Status: SPEC WRITTEN, 2026-09-12 — awaiting APPROVED.**
> ⭐ **Measurement overturned the register's own hypothesis.** "Narrow `resetTables()`" is not
> available for the three known files — measured and falsified below. The fix is one line in
> `vitest.config.mts`, and it already has a precedent elsewhere in this repo.

Source defect: `docs/DEFECTS-REGISTER.md` DEF-313, as widened 2026-09-12 by lane A's own regression
sampling during T-281.

## Answering the scope's own question first: where is "the shared `resetTables` helper"?

**There is no shared helper. This premise needed correcting before anything else.**

`git grep -n "async function resetTables"` finds **11 independent, same-named local functions**,
one per file, no shared import:

`packages/domain/tests/integration/{reverse-entry,legacy-adapter,post-entry-party,post-entry,reports}.test.ts`,
`packages/db/tests/integration/{journal,reports}.test.ts`,
`packages/etl-firestore/tests/integration/capture.test.ts`,
`packages/etl/tests/integration/{etl-run,replay}.test.ts`,
`tests/integration/core-schema.test.ts`.

**Neither of the two files this defect actually names uses a function called `resetTables` at
all** — `stock-transfers.test.ts` and `production.test.ts` both inline
`await sql\`truncate table …\`` directly in `beforeEach`, unnamed. Widening the search to any
`beforeEach` that truncates (`git grep -il "truncate table"`) finds **63 files repo-wide**, **37**
of them under `packages/domain/tests/integration/` (92 files total there). So "the shared helper"
is really a *convention*, copy-pasted independently dozens of times, not a module. There is nothing
at a single path to change under this scope bullet — see Contract point 3 for what that implies for
the fix shape.

## The measurement that changes the disposition

The register's hypothesis: *"if `resetTables()` truncates tables a file never touches, narrowing it
would cut the cost."* I measured this directly against `shareat_test_lanea` rather than trusting it,
using rolled-back transactions (`BEGIN; TRUNCATE …; ROLLBACK;`) so nothing below altered the lane
database.

**1. `organizations`, `persons` and `stores` — all three already present in every affected file's
truncate list — sit at the root of almost the entire schema's foreign-key graph:**

| Root table | `TRUNCATE … CASCADE` closure size | of 128 total tables |
|---|---|---|
| `organizations` | **124** | 97% |
| `persons` | 116 | 91% |
| `stores` | 100 | 78% |
| `items` | 29 | 23% |
| `accounts` | 2 | 2% |

(Computed by walking `pg_constraint` for every FK edge and taking the closure — not estimated.)

**2. The nominal list length is therefore almost irrelevant.** `reports.test.ts` names 9 tables;
`production.test.ts` names 26. Both include `organizations`, so both actually truncate ~124 of 128
**regardless of what else is or isn't named** — confirmed by timing `TRUNCATE organizations CASCADE`
alone against the full 26-name statement: statistically indistinguishable (below).

**3. I tried to build a genuinely narrower, non-`CASCADE` list for `production.test.ts` — the exact
lever the register proposed — and it does not converge.** Dropping `CASCADE` and adding back
whatever Postgres names as missing (`detail: Table "X" references "Y"`, one at a time), I added
**38 tables** before stopping — `pos_item_maps`, `supplier_returns`, `trade_orders`,
`ar_charges`, `count_sessions`, `employments`, `expense_payments`, and more, none of which
`production.test.ts` or its imports touch — and it had not reached a fixed point. `organizations` /
`persons` / `stores` are referenced by nearly every table in this schema (accounting, HR, POS,
commissary, counts…), so a *correct* (non-erroring) non-cascading list converges toward the same
~100+ table set CASCADE already gives, just discovered one Postgres error at a time instead of one
keyword. **Narrowing is not a lever here.** Every test creates its own org/store/persons, so
`organizations`/`persons`/`stores` must be cleared every time, and clearing them safely means
clearing (or already having empty) everything that references them.

**4. Real timing, load stated honestly — `ListAgents` throughout this session showed `webapps-f2`,
`webapps-65` and `webapps-f7` all `busy` (not a quiet box):**

- Current `production.test.ts` statement (26 named + `CASCADE`, effectively ~124 tables), 5 runs:
  **1998ms, 2368ms, 4006ms, 3995ms, 4031ms.**
- `organizations, persons, stores CASCADE` alone, 5 runs measured a few minutes later: **2906,
  5667, 4973, 5681, 5145ms** — same cost as the 26-name statement, confirming point 2, and visibly
  *higher* than the first batch purely from ambient load drifting upward over ~10 minutes with no
  self-induced contention at all.
- `organizations` alone, `CASCADE`: **4934, 2819, 3966, 4291, 5007ms** — statistically the same as
  the prior two, confirming the closure (not the list) sets the cost.
- **Self-induced lock contention, 4 concurrent connections truncating the same tables on the same
  lane database** (simulating what would happen if these files' hooks ever raced each other):
  **2362, 6257, 15989, 12149ms** — the last one already exceeds a 10s hook timeout on its own.
- **8 concurrent connections, same test:** **2258, 6182, 10084, 14247, 18365, 24140, 28618,
  32915ms** — growing roughly linearly with contention, the worst case exceeding even 30s.
- ⚠️ **That last result does NOT describe today's real risk, and I want to say so rather than let a
  scary number stand unexplained: `vitest.config.mts`'s `integration` project already sets
  `fileParallelism: false` (line 92, confirmed by reading the file) — so within one session's own
  `vitest run --project integration`, files never race each other for the same lane database's
  table locks.** The 4-/8-way numbers are a stress-test upper bound on *that specific mechanism*,
  which today's config already prevents. The realistic contention is **cross-session**: separate
  lane databases (`shareat_test_lanea`/`laneb`/`orch`) share one Postgres server's buffers, WAL,
  checkpointer and CPU (DEF-313 point 4), which cannot produce table-lock waits across databases
  but does inflate each truncate's own execution time — consistent with the single-connection
  numbers above drifting from ~2-4s to ~3-6s over ten minutes of other sessions' ambient work, and
  with DEF-313's own original observation (full suite: 1962s busy vs 1620s normal, ~20% inflation).

## Existing precedent for the fix, found by grepping sibling configs

`firebase/vitest.config.ts` and `spike/firestore-two-lane/vitest.config.ts` **already carry both**
`fileParallelism: false` **and** `hookTimeout: 30_000`. The root `vitest.config.mts`'s `integration`
project (which is what every file in this defect actually runs under — confirmed by its `include`
glob covering `packages/**/tests/integration/**`) has `fileParallelism: false` and
`testTimeout: 30_000`, but **no `hookTimeout` at all**, silently defaulting to vitest's global
10,000ms. `testTimeout` and `hookTimeout` are separate settings; raising one does not raise the
other. This reads as an oversight from whoever set `testTimeout: 30_000` for the same underlying
reason (slow DB-backed setup) without knowing hooks needed their own line.

## Goal

Add `hookTimeout: 30_000` to `vitest.config.mts`'s `integration` project — the one line missing
relative to the pattern already adopted in `firebase/vitest.config.ts` and
`spike/firestore-two-lane/vitest.config.ts` — so a `beforeEach` truncate that legitimately takes
several seconds under real concurrent load gets the same budget vitest already gives the *test*
body (`testTimeout: 30_000`, same project, same reason), instead of a shorter, undocumented default
that was never chosen for this workload.

## Scope — the exact files this task may create or modify

- `vitest.config.mts` — one line (`hookTimeout: 30_000,`) plus a citation comment, inside the
  existing `integration` project block only. The `unit` project is untouched and keeps vitest's
  default 10s — it never touches a database and has no reason to need longer.
- `docs/tasks/285-def-313-truncate-hook-timeout.md` — this file.

**Nothing under `packages/domain/tests/integration/` needs editing.** No file-local `beforeEach`
override, no narrowed truncate list — both are either unavailable (narrowing, measured above) or
made redundant by the project-level setting (file-local overrides), and the register's own
widened disposition already says a file-local fix "would fix one third of a problem" now that three
files are confirmed and the population is unknown-but-large (37 files share the pattern in this one
package alone). A single project-level setting fixes all of them, present and future, uniformly.

## Contract

1. `hookTimeout: 30_000` is set **only** inside `test.projects[].test` where `name: 'integration'`
   — never at the top-level `test:` block (which would also raise the `unit` project's hooks, a
   change nothing here justifies and the register's "not globally" warning is about).
2. `testTimeout` stays exactly as-is (`30_000`, already correct, already the standard this change
   matches).
3. No test file's `beforeEach`/truncate statement changes. Point 3 of the measurement section
   proves narrowing is not available while every test creates its own org/store/persons; changing
   a list that cannot actually get smaller would be motion without effect.
4. `fileParallelism: false` (line 92) is left exactly as it is. It is not the register's forbidden
   "serialise the lanes" (that is about the four SESSIONS/lane-databases taking turns, which this
   setting has no power over — it only stops one session's OWN vitest invocation from racing its
   own files against its own lane database) and it is not part of this task's diagnosis — DEF-313's
   flakiness happens even with it already on, per the single-file, single-connection measurements.

## Invariants

1. ⛔ **Do NOT raise `hookTimeout` at the top-level `test:` block or inside the `unit` project.**
   That is the literal thing the register forbids — it would hide a genuinely hung hook in every
   unit test too, which never touches a database and has no legitimate reason to need 30s.
2. ⛔ **Do NOT touch any `beforeEach` in `packages/domain/tests/integration/` to narrow its
   truncate list.** Measured and disproven above — attempting it converges toward the same ~100+
   table closure by a slower, error-driven route. A future reader tempted to "fix it properly" by
   narrowing should read the 38-table non-convergence result first.
3. ⛔ **Do NOT move any `beforeEach` to `beforeAll`.** Unchanged from the original disposition —
   per-test isolation is what makes each test's invariants independent of run order, and this task
   does not touch fixture strategy at all, only the budget the existing strategy is judged against.
4. ⛔ **Do NOT add `maxWorkers`/`poolOptions` limits or otherwise further serialise test execution**
   to chase the 8-way stress number down — that number describes a mechanism (`fileParallelism`)
   already disabled for this project; solving it again would be solving something that isn't live.
5. The fix must be traceable to a measurement, not an estimate — `vitest.config.mts`'s new line
   carries a comment citing DEF-313 and the real numbers above, the same way this codebase cites
   *why* everywhere else (`docs/RULES.md` §2 rule 9's neighbour convention).

## Tests — validation is the repeated-real-run kind, not a new automated test

This is a timeout-budget change, not new application behaviour; there is nothing to unit-test about
the number `30_000` itself. The validation is: **do the three known-flaky files stop flaking under
today's real, stated load**, run enough times to say so with a number rather than a vibe.

1. Before the change: one more baseline run each of `reports.test.ts`, `stock-transfers.test.ts`,
   `production.test.ts` against `shareat_test_lanea`, real output, real pass/fail counts, `ListAgents`
   state recorded alongside (repeats T-281's own sampling, one more data point).
2. After the change: the same three files, **3 consecutive runs each** (9 runs total), against
   `shareat_test_lanea`, real output every time. Zero `Hook timed out` errors is the bar — a
   downstream duplicate-key error would mean a timeout still occurred somewhere upstream in the
   same run and must be treated as a failure of this fix, not a separate finding.
3. `npm run typecheck` and `npm run test` (unit) — confirm the `unit` project's behaviour and
   timing are genuinely untouched (point 1 above), not just documented as untouched.
4. Full command for the affected-file gate, matching the briefing:
   `node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_lanea packages/domain/tests/integration/reports.test.ts packages/domain/tests/integration/stock-transfers.test.ts packages/domain/tests/integration/production.test.ts`
   run **three times**, one file at a time per DEF-313's own nondeterminism finding (point 3:
   "two consecutive runs failed a different test each time") — a single green run proves less here
   than anywhere else in this codebase.

## Out of scope

- ⛔ **A shared `resetTables()` module to de-duplicate the 11 (or 63) independent implementations.**
  Real, and arguably worth doing, but it is a separate refactor across dozens of files this task's
  briefing did not scope in, and DRYing the *code* wouldn't change the *cost* measured above — the
  closure size is a schema-graph property, not a copy-paste problem.
- ⛔ **Narrowing any file's explicit truncate list.** Measured, not chosen: see the 38-table
  non-convergence result. Anyone still tempted to do this later should re-run the discovery loop
  before touching a list, not assume the register's original hypothesis holds.
- ⛔ **Reworking fixture strategy to scope cleanup by `org_id` instead of truncating.** Would likely
  be genuinely cheaper (a `DELETE … WHERE org_id = …` cascade touches only rows this test created,
  not a schema-wide lock sweep) but is a correctness-sensitive change to how every one of these
  files establishes isolation, not a budget tweak, and belongs in its own spec if Ian wants it
  pursued.
- ⛔ `apps/erp/**`, `packages/domain/src/stores/**`, `packages/db/src/repo/stores.ts`,
  `packages/core/src/env.ts`, `scripts/**`, `tests/unit/**` — `webapps-f7` and lane B are live
  there; f7 also holds port 9008 and a dev server.
- ⛔ Any migration — none needed; this is test infrastructure only.
- ⛔ `firebase/vitest.config.ts`, `spike/firestore-two-lane/vitest.config.ts` — already correct,
  cited only as precedent, not touched.

## Done when

- `vitest.config.mts` carries `hookTimeout: 30_000` in the `integration` project only, with a
  citation comment.
- typecheck clean.
- unit suite unaffected — real numbers reported, compared against the pre-change baseline.
- `reports.test.ts`, `stock-transfers.test.ts`, `production.test.ts` — 3 consecutive green runs
  each against `shareat_test_lanea`, real output, under whatever load exists at the time (stated,
  not assumed quiet).
- Self-reviewed line by line.
- Report ends with a `FOR IAN` block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-313 (original + widening); `vitest.config.mts`;
`firebase/vitest.config.ts`; `spike/firestore-two-lane/vitest.config.ts`;
`docs/tasks/281-def-302-honest-stock-period-refusal.md` (where this was found).
