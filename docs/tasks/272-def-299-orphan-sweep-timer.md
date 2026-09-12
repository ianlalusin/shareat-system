# T-272 — DEF-299: the orphan file sweep has never run, and Ian has ruled it should, nightly

> **Status: ✅ COMPLETE — shipped 2026-09-12, `55fc4bd`, migration `0144`, lane A.** Includes DEF-303 (`budget_reissue` units). ⚠️ Neither timer is ARMED on the droplet — that is Ian’s step (DEF-194), and there are now TWO to arm, not one. ⭐ DEF-306, DEF-307 and DEF-308 were filed out of this task; DEF-308 was found by SMOKETESTING the script after every gate was already green.

## Ian's decision, 2026-09-12 — the WHAT, not open to revision

> **Wire it, nightly**, on the pattern of the six existing timers in `docs/ops/`.

Asked whether abandoned uploads should be swept at all and on what schedule, having been told that
both of the sweep's bugs are now fixed and that it has never run in production.

## Why this is a landmine and not a chore

`sweepOrphanedFiles` (`packages/domain/src/files/index.ts:214`) has **no production caller and never
has**. `git grep` returns the definition, two doc comments, and four calls — all inside
`packages/domain/tests/integration/files.test.ts`. There is no systemd unit, no npm script, no route.

⛔ **Meanwhile the codebase describes it as a running cron.** `packages/db/src/client.ts:135` names
it in `systemTransaction()`'s privileged caller list as *"a cron across every organisation"*, and its
own doc comment says it *"REPORTS what it did — a sweep that deletes quietly is indistinguishable
from one that is broken."* Both sentences describe a thing that does not exist.

⭐ **This recontextualises DEF-298**, the data-loss race found the same afternoon: it has never
fired. A landmine, not a bleed — and worse for it, because whoever eventually scheduled that cron
would have done so believing it had been running safely for months.

⚠️ **Both bugs (DEF-297, DEF-298) were fixed on 2026-09-12, so it is safe to wire. It was not safe
that morning.** Wiring it before those fixes would have started deleting bytes out from under
just-claimed files on night one.

## Scope, when this is picked up

- A runner script under `scripts/`, on the pattern of `attendance-sweep.ts`,
  `order-wastage-backstop.ts`, `finding-observation.ts`, `recurring-expense-draft.ts`.
- A `.service` / `.timer` pair in `docs/ops/`, on the pattern of the six already there.
- ⛔ **A migration widening `scheduler_runs_job_check`** to admit the new job name. The live
  constraint (`0136:100-102`) is `('depreciation','amortisation','attendance_sweep','mirror_publish',
  'inbox_relay','order_wastage_backstop','finding_observation','budget_reissue','recurring_expenses')`.
  ⚠️ **`scheduler_runs` is a SHARED table** — `0126`, `0130`, `0131` and `0136` all carry the same
  warning: if another lane's migration also widens this constraint in the same cycle, the two
  DROP/ADD pairs must be reconciled into ONE naming every job from every lane.

## ⛔ Non-negotiable: it records a run, or it is not wired

**Do not ship the timer without the `scheduler_runs` row.** DEF-299's own lesson is that a sweep
nobody can see is a sweep nobody knows is broken — and this defect exists precisely because the code
*claimed* to be a reporting cron while being nothing at all. A nightly job that deletes storage bytes
and leaves no trace of having run would reproduce the defect it is closing, one layer up.

⭐ See also bible §12's sweep-control landmine (§13 row 181): **a sweep that reports a total must
first report a known non-zero control.** A nightly "0 files swept" is indistinguishable from a
broken query unless something proves the sweep can still count.

## Out of scope

- ⛔ Re-opening DEF-297 or DEF-298. Both are fixed and verified; this task consumes that work.
- ⛔ Arming the timer on the droplet — that is Ian's, and `docs/ops` does not ship (DEF-194).

See `docs/DEFECTS-REGISTER.md` DEF-299, DEF-297, DEF-298, DEF-194; `PROJECT_BIBLE.md` §13 rows 181,
194; `packages/db/src/client.ts:135`; `docs/ops/README.md`.

---

## ⛔ SCOPE CORRECTION, orchestrator, 2026-09-12 — this is NOT "a script and a timer"

Found by lane B writing `docs/discovery/34-scheduled-job-pattern.md`, and verified independently
before being recorded here.

**`sweepOrphanedFiles(olderThanHours = 24)` takes no `orgId` and runs ONCE GLOBALLY**
(`packages/domain/src/files/index.ts:214`), reading its candidates through a bare
`systemTransaction` and returning one aggregate result. **`scheduler_runs.org_id` is `NOT NULL`**
(`packages/db/schema/scheduler.ts:107-109`), and every one of the six existing jobs writes one row
per organisation through `runJobForOrg`.

⛔ **So the sweep as written cannot record a run at all** — and per this task's own non-negotiable,
a sweep that records nothing is not wired. The two facts are in direct conflict and one of them has
to move.

⭐ **The good news is that the fix is mechanical, not architectural:** `stored_files.org_id` already
exists and is `NOT NULL`, so `listOrphans` can be scoped per organisation without a schema change.
⚠️ But it is real code beyond a script and a unit file: the **write** side must also move from a bare
`systemTransaction` to the per-org system principal once the read is scoped, or the sweep will read
one organisation's orphans and delete against another's principal.

⚠️ **This also re-opens a question bible row 194 already answered.** `sweepOrphanedFiles` is on the
closed cross-org caller list *because* it takes no `orgId` by design (DEF-287). Scoping it per-org
would REMOVE its reason to be on that list. ⛔ **Do not quietly drop it from the list** — row 194 says
the set changes only by a named ruling. Report it and let the orchestrator take it to Ian.

### Shape to follow — `order-wastage-backstop`, not the others

Per the discovery doc's §3: per-item transactions, system principal, wrapped inline in
`scheduler/index.ts`, daily, Manila-pinned, no retry timer, bookkeeping-only `period`. ⛔ Do **not**
copy `recurring-expense-draft`'s real-creator `Actor` shape — that is deliberate and domain-specific
to a job that must act as a person — nor `month-end`'s retry timer, which Ian asked for by name and
is a one-off rather than a pattern.

### ⭐ And take DEF-303 with it

`budget_reissue` is a seventh registered job with no `.service`/`.timer` pair either. This task is
already wiring one un-hosted job, already editing `docs/ops/`, and already holds the
`scheduler_runs_job_check` slot — adding a second unit pair costs almost nothing here and repeats
every bit of setup if split out. ⚠️ Ian confirms, since it is a second nightly job on the droplet.

---

## Implementation spec, lane A — 2026-09-12 (`webapps-4e`)

Model: Sonnet. Read RULES.md, this file (incl. the scope correction above), `docs/discovery/34-
scheduled-job-pattern.md` §3–4, DEF-299/303/287/297/298, bible §13 rows 181/194,
`packages/db/migrations/README.md`, ADR-012 §5, plus the live code named below, before writing this.

### ⛔ Two scope defects found — reporting before building, not working around them (RULES §3.4a)

**Defect 1 — the mandated principal switch cannot be made inside the granted file list; it needs
two files that are not on it.** The scope correction requires `sweepOrphanedFiles`'s write side to
move off `systemTransaction()` onto `withSystemOrgPrincipal(orgId, …)` once scoped per-org. Two
build-enforced guards outside my scope then go stale or red:

- `packages/db/src/client.ts:135` — `systemTransaction`'s own doc comment names `sweepOrphanedFiles`
  in prose as one of the enumerated cross-org callers ("row 194 subsystem 2, DEF-287 — a cron across
  every organisation"). Leaving this sentence in place after the switch reproduces the exact "the
  code describes a thing that is not true" shape DEF-299 itself exists to close.
- `tests/unit/system-transaction-callers.test.ts:31-49` — `REQUIRED_CALLERS` lists
  `'packages/domain/src/files/index.ts'` (added under T-267/DEF-287), and its own test at line 159
  (*"each of the three required callers contains at least one `systemTransaction(` call"*) **fails
  the moment `files/index.ts` stops calling it** — not a hypothetical, a mechanical break.

Neither file is in the "only paths you may create or modify" list. Both edits are pure list/prose
maintenance (delete one bullet in a doc comment; delete one array entry + its comment), no behaviour
change, and follow directly from the removal Ian's note already pre-authorizes ("scoping this sweep
per-org REMOVES its reason to be on the closed list… sanctioned without a fresh ruling"). **Requesting
these two files be added to my scope**, narrowly:
- `packages/db/src/client.ts` — delete the `sweepOrphanedFiles` bullet (line 135) from
  `systemTransaction`'s doc comment only.
- `tests/unit/system-transaction-callers.test.ts` — delete the `packages/domain/src/files/index.ts`
  entry and its comment (lines 40-42) from `REQUIRED_CALLERS` only.

If this is refused, T-272 cannot close DEF-287's fourth instance without leaving a red or a lying
test in the tree, and I'll hold the principal-switch half of the build until this is answered.

**Defect 2 (minor) — finishing DEF-303 inside the granted file requires touching more than the
named row.** `tests/unit/scheduler-job-hosting.test.ts` already exists (T-273, not part of this
task) and already carries an `EXEMPT_FROM_UNITS['budget-reissue']` row (lines 84-89) citing DEF-303.
That same file's own "no exemption outlives its reason" test (line 129) requires deleting that row
the moment `docs/ops/shareat-budget-reissue.{service,timer}` both exist — which this task creates.
The briefing scoped this file to "its JOB_SCRIPT row for your new job" only. Treating the
EXEMPT_FROM_UNITS deletion as included (same file, mechanical consequence of finishing DEF-303, no
new judgement call) rather than stopping for it — flagging here so it isn't a surprise in READY.
Say so if that reading is wrong.

### Q1 — the non-zero control (bible row 181 / §12)

**A per-file count cannot be the control: zero orphans is a legitimate, common, healthy result.**
The honest control already exists and is already load-bearing in every sibling script, not something
to invent: **the number of orgs the run actually iterated.** Every one of the six existing scripts
(`order-wastage-backstop.ts:68-72`, `budget-reissue.ts:65-69`, etc.) already treats
`result.outcomes.length === 0` as a **failure**, not a quiet success — *"not a success. An empty run
means no orgs were found."* That is precisely "prove the sweep can still count" applied one layer
up: it can't prove *this run* found real orphans, but it can prove the enumeration step that has to
run before any org-scoped query even fires actually ran and saw something. I'm proposing the new
`orphan-file-sweep.ts` follow that exact, already-established idiom (zero orgs ⇒ exit 1; zero orphans
across ≥1 real orgs ⇒ exit 0, "removed 0"), not inventing a second control (e.g. total rows scanned
pre-filter) that no other job in this file bothers with and that `listOrphans` cannot produce without
a second, unfiltered query. If the org-count control is judged insufficient for this specific job,
that's a design call bigger than my slice — naming it rather than deciding it.

### Q2 — the 500 cap

Confirmed, and it is a real gap: `listOrphans`'s `.limit(500)` (`packages/db/src/repo/files.ts:91`)
is a candidate cap, not a per-run guarantee of completion. After a multi-day outage, an org with
>500 eligible orphans gets `removed` up to 500, `failed: []`, `outcome: 'ok'` — and **that row is
byte-for-byte indistinguishable in `scheduler_runs` from a run that fully drained the backlog.**
Worse, the schema has no vocabulary to say otherwise today: `scheduler_runs_outcome_matches_failures_check`
(`packages/db/schema/scheduler.ts:158-163`) ties `'partial'` to `failedCount > 0`, so a capped-but-
otherwise-clean run cannot be marked anything but `'ok'` without a constraint change. That's DEF-299's
own shape, one layer up, exactly as flagged. Within my granted scope I can only do the cheap honest
thing: report a `detail` string when the candidate batch hits 500 (*"hit the 500-candidate cap — more
orphans may remain"*), which the run's own printed line and `scheduler_runs.failures`/`detail`-shaped
reporting already surfaces to a human reading the log. **I'm not proposing a schema fix for this**
(a `'capped'`-shaped outcome, or removing the cap) — that's a real design question, not mine to
decide inside this slice. Naming it as a candidate follow-up defect for the orchestrator to file,
not filing it myself and not silently building around it.

### Q3 — the promised bucket-reconciliation sweep

**It does not exist anywhere in this repo**, verified by `git grep`, not by trusting the comment:
no `reconcil`-anything touches storage, and the storage driver interface itself
(`packages/domain/src/files/driver.ts`) exposes only `put`/`remove`/`signedUrl` — **no `list`
method at all**, so the described recovery ("detectable and recoverable by a later sweep against
the bucket," `files/index.ts:209`) isn't merely unbuilt, it isn't expressible against today's driver
contract without adding bucket enumeration first. The same sentence was carried forward verbatim
into `docs/tasks/269-def-297-def-298-orphan-sweep-and-third-bootstrap-site.md:70` when DEF-297/298
were fixed, without anyone building it then either — same shape as `client.ts:135`'s "a cron across
every organisation" describing a thing that never ran. Per the task's own instruction: **not
building it.** Reporting it for the orchestrator to file.

### Naming decisions (mine to make, flagging so they can be corrected)

| | Choice |
|---|---|
| `SCHEDULER_JOBS` / `scheduler_runs_job_check` entry | `orphan_file_sweep` |
| npm script / unit basename | `orphan-file-sweep` — holds the same `job-name-hyphenated` rule `scheduler-job-hosting.test.ts`'s own header confirms already holds for `attendance_sweep`, `order_wastage_backstop`, `finding_observation` |
| scheduler entry point | `runOrphanFileSweep(options: { orgId?, trigger?, nowMs? })` calling `runOrphanFileSweepForOrg` per org — same shape as `runOrderWastageBackstopSweep` / `runOrderWastageBackstopForOrg` (`scheduler/index.ts:614-651`) |
| cadence | Daily, `*-*-* 03:00:00 Asia/Manila` — after `order-wastage-backstop` (02:30) so the two don't contend, `Persistent=true`, `AccuracySec=5min`, no retry timer (§3.7 — Ian did not ask for one), bookkeeping-month `period` (§3.8) |
| transaction granularity | Per-item (per-file) — already the current shape of `sweepOrphanedFiles`; unchanged |

### Contract

- **`filesRepo.listOrphans(tx, orgId, hours)`** (`packages/db/src/repo/files.ts:77`) — adds
  `eq(storedFiles.orgId, orgId)` to the existing `and(...)`. Keeps `.limit(500)` and the existing
  `orderBy(asc(uploadedAt))`. No migration needed (`stored_files.org_id` is already `NOT NULL`).
- **`filesRepo.deleteFile`** — unchanged; already org-agnostic by primary key and already returns
  a boolean (DEF-297, fixed).
- **`sweepOrphanedFiles(orgId: string, olderThanHours = 24)`** (`packages/domain/src/files/index.ts:214`)
  — signature order per the discovery doc's own recommendation (§4). Internally, both existing
  `systemTransaction(...)` call sites (the `listOrphans` read and the per-file `deleteFile`) become
  `withSystemOrgPrincipal(orgId, ...)`, imported from `@shareat/db` alongside the existing
  `systemTransaction` import (which this file then no longer uses — that import is removed).
  Return type gains one additive field: `candidates: number` (`orphans.length`, before claimed/failed
  are subtracted out) — safe because every existing assertion on this return value is field-level
  (`expect(result.removed).toBe(...)`), never a whole-object `toEqual`, confirmed by re-reading
  `files.test.ts:280-408`. DEF-297/298's delete-then-remove order and per-file try/catch are
  untouched, byte for byte.
- **`runOrphanFileSweepForOrg`** (new, `packages/domain/src/scheduler/index.ts`, inline beside
  `runOrderWastageBackstopForOrg`) — calls `sweepOrphanedFiles(org.id, 24)` directly inside
  `runJobForOrg`'s `work()` (not double-wrapped in `asSystem`, since the domain function now owns
  its own per-org principal internally — the one place this job's shape genuinely differs from its
  siblings, because it needs N+1 transactions, not one). Maps `posted: result.removed`,
  `skipped: result.claimed`, `failures` from `result.failed` (`subjectId`/`subjectName` both the
  `path` — no other identifier survives that far), and sets `detail` only when
  `result.candidates === 500` (Q2's cap signal).
- **`JobOutcome['job']`** union (`scheduler/index.ts`, ~line 58-68) gains `'orphan_file_sweep'`.

### Migration — `0144_t272_def299_orphan_sweep_job.sql`

**DEF-303 needs no migration.** `budget_reissue` has been in `SCHEDULER_JOBS` and the live
`scheduler_runs_job_check` since `0131` — its gap is purely `docs/ops/` files, no schema change.

0144 is DEF-299's half only: widen `scheduler_runs_job_check` to add `orphan_file_sweep`, same
DROP/ADD shape as `0126`/`0130`/`0131`/`0136`:

```sql
ALTER TABLE "scheduler_runs" DROP CONSTRAINT "scheduler_runs_job_check";
ALTER TABLE "scheduler_runs" ADD CONSTRAINT "scheduler_runs_job_check"
	CHECK ("job" IN ('depreciation','amortisation','attendance_sweep','mirror_publish','inbox_relay','order_wastage_backstop','finding_observation','budget_reissue','recurring_expenses','orphan_file_sweep'));
```

`packages/db/schema/scheduler.ts`'s `SCHEDULER_JOBS` array and its own `scheduler_runs_job_check`
`sql` literal (line 148) are updated in the same change, per DEF-217's own note beside that literal.
Journal entry (`meta/_journal.json`, one new entry, appended after idx 143):

```json
{ "idx": 144, "version": "7", "when": 1798515107084, "tag": "0144_t272_def299_orphan_sweep_job", "breakpoints": true }
```

`when` = 0143's `1798428707084` + `86_400_000`, matching the briefing's own figure. Proven on a
throwaway `shareat_scratch_<x>` database first (ADR-012 §5 step 8) — created, migrated, `count(*)`/
`max(created_at)` read from `drizzle.__drizzle_migrations`, dropped — before ever touching
`shareat_test_lanea`. Lane A's own deviation on `0143` (skipping this step) is on record as a
handoff item; not repeating it.

### Tests

- **`packages/domain/tests/integration/files.test.ts`** — the four existing
  `sweepOrphanedFiles(24)` calls become `sweepOrphanedFiles(f.orgId, 24)`. Add: (a) a cross-org
  isolation test — two orgs, one aged unclaimed upload each, sweep org A only, assert org A's orphan
  is gone and org B's survives completely untouched (row and bytes); (b) an end-to-end wiring test
  calling the new `runOrphanFileSweep({ orgId: f.orgId, trigger: 'manual' })` and reading back a
  `scheduler_runs` row with `job = 'orphan_file_sweep'`, matching `postedCount` to files actually
  removed — same pattern `budgets.test.ts:270-345` already uses for `runBudgetReissue`.
- **`packages/domain/tests/integration/scheduler.test.ts`** — no change anticipated. Its own
  existing scope is the generic `runJobForOrg`/`listOrgsToRun` harness (exercised via month-end),
  and neither `order-wastage-backstop` nor `budget_reissue` has its own entry there either — the
  precedent is that per-job behaviour lives in the feature's own integration test file. Naming this
  as a default rather than silently deciding it; say so if scheduler.test.ts needs a harness-level
  assertion instead.
- **`tests/unit/scheduler-job-hosting.test.ts`** — add `orphan_file_sweep: 'orphan-file-sweep'` to
  `JOB_SCRIPT`; delete the now-satisfied `EXEMPT_FROM_UNITS['budget-reissue']` row (Defect 2 above).
- **`tests/unit/scheduler-jobs-have-callers.test.ts`** — add `'runOrphanFileSweep'` to
  `KNOWN_JOB_NAMES` (kept sorted); raise the floor `toBeGreaterThanOrEqual(6)` to `(7)` (BLOCKER-1's
  lesson: a floor that only ever equals the current count can't see a hole).
- **(pending Defect 1's answer) `tests/unit/system-transaction-callers.test.ts`** — delete the
  `packages/domain/src/files/index.ts` `REQUIRED_CALLERS` entry and its comment.

### Invariants

- **INV1** `listOrphans` never returns another org's rows — `packages/db/src/repo/files.ts:77-92`,
  proven by the new cross-org test in `files.test.ts`.
- **INV2** the write side never opens a bare `systemTransaction()` for this path once scoped —
  `packages/domain/src/files/index.ts:214-242`, proven by `tests/unit/system-transaction-callers.test.ts`
  going green with the entry removed (Defect 1) rather than red.
- **INV3** `scheduler_runs` gets exactly one row per org per run, unchanged mechanism —
  `packages/domain/src/scheduler/index.ts:116-175` (`runJobForOrg`), reused not re-implemented.
- **INV4** DEF-297/298's delete-then-remove order and per-file failure isolation
  (`packages/domain/src/files/index.ts:214-242`) survive unchanged in shape — only the principal
  helper and the `orgId` threading change.
- **INV5** `scheduler_runs_job_check` accepts `orphan_file_sweep` — proven on a scratch database
  before `shareat_test_lanea` (ADR-012 §5 step 8).

### Out of scope (restated + additions found while specifying)

- Re-opening DEF-297/298 (fixed) or DEF-304 (the caller-guard's file-scan blindness — that's slice 2).
- Building the bucket-reconciliation sweep Q3 found missing — reporting, not building.
- Widening or removing `listOrphans`'s `.limit(500)`, or giving `scheduler_runs` a `'capped'`-shaped
  outcome — Q2's finding is reported, not fixed here.
- An org-scoped index on `stored_files` beyond what exists (`stored_files_unlinked_idx` is a global
  partial index on `uploaded_at WHERE linked_to IS NULL`; adding org_id to it would be a performance
  nicety, not a correctness need, since `org_id NOT NULL` already makes the query correct without
  one) — logged in passing per RULES §13 row 164, not acted on.
- Amending `PROJECT_BIBLE.md` row 194, `docs/DEFECTS-REGISTER.md`, or `docs/CAPABILITY-GAPS.md` —
  reporting which call sites stop needing the system door in READY; the row itself is the
  orchestrator's/Ian's to write.
- Arming any timer on the droplet (DEF-194 — that step is Ian's).

### Done-when

typecheck clean · `npm run test` green · `shareat_test_lanea` green via `it.mjs` for
`files.test.ts` and `scheduler.test.ts` · migration proven on a throwaway scratch database before
`shareat_test_lanea` · `docs/ops/shareat-orphan-file-sweep.{service,timer}` and
`docs/ops/shareat-budget-reissue.{service,timer}` written on the exact pattern of
`shareat-order-wastage-backstop.*` · `docs/ops/README.md`'s job table gains both rows and the
"NOT YET ARMED" paragraph is updated to name them · exactly one new `package.json` script line ·
this file's status line updated at the end · self-reviewed line by line.

**STATUS: BUILT, REVIEW CHANGES APPLIED, READY v2 SENT — 2026-09-12, lane A (`webapps-4e`).**
Approved by `system32-85` including both scope-defect requests, then three review changes applied:
`deleteFile` now org-scoped (defence in depth against `rolbypassrls` in production), the 500-cap
signal reads a shared `ORPHAN_SWEEP_BATCH_LIMIT` constant instead of a duplicated literal, and the
script was smoke-tested end to end — which surfaced and fixed a real gap (no CLI script had ever
installed the Firebase storage driver outside the Next.js app's own boot hook; `orphan-file-sweep.ts`
now does, on the same rule `apps/erp/src/instrumentation.ts` uses). `orphan_file_sweep` wired nightly
per-org (DEF-299); `shareat-budget-reissue.{service,timer}` written (DEF-303); DEF-306 (the 500-cap
ambiguity) and DEF-307 (no bucket-reconciliation sweep, and none is buildable against today's
driver) reported for the orchestrator to file, not built. typecheck clean, `npm run test` 98/98
files green, `shareat_test_lanea` 27/27 green for `files.test.ts` + `scheduler.test.ts`, migration
0144 proven on a throwaway scratch database, and the script smoke-tested for real against
`shareat_test_lanea` (exit 0, 17 real orgs, one genuine orphan correctly swept). Awaiting commit.
