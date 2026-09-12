# T-272 — DEF-299: the orphan file sweep has never run, and Ian has ruled it should, nightly

> **Status: RESERVED, NOT STARTED — 2026-09-12.** Ian ruled on 2026-09-12: **wire it, nightly.**
> ⛔ **Blocked today only by the migration slot** — lane A held `0143`. The next free index is
> `0144`; its journal `when` must exceed **1798428707084**.
> ⚠️ **READ THE SCOPE CORRECTION AT THE END OF THIS FILE BEFORE PLANNING.** This is not “a script
> and a timer”: the sweep takes no `orgId` and `scheduler_runs.org_id` is `NOT NULL`, so as written it
> cannot record a run at all. ⭐ **DEF-303 rolls into this task** — `budget_reissue` has no unit pair
> either, and this task is already editing `docs/ops/` and already holds the constraint migration.

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
