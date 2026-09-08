# T-233 — DEF-219: `startRun` inside the per-organisation boundary of the scheduler runner

> **Status**: ✅ **APPROVED by the orchestrator 2026-09-08 — lane E builds.** Scope widened on approval: `scripts/finding-observation.ts:66` and `scripts/budget-reissue.ts:67` carry the same bare `ok` line (finding 4) and get the same count treatment. The test-local trigger lever (T1/T3) is approved as lane-DB DDL, never a migration, dropped in `finally` and in `afterAll`. Guard C's "keep the real counts" must be asserted by a test.
> Defect: `docs/DEFECTS-REGISTER.md` DEF-219. One runner change, not nine job edits.

---

## ⚠️ Five findings from reading the code, reported rather than designed around (RULES §3.4a)

**1. There are TEN placements, not nine, and the tenth is in another file.**
`packages/domain/src/scheduler/index.ts` — `:144` depreciation · `:194` amortisation · `:268`
attendance_sweep · `:396` mirror_publish · `:493` inbox_relay (the degenerate copy, see finding 2) ·
`:517` inbox_relay · `:617` order_wastage_backstop · `:678` finding_observation · `:781`
budget_reissue. Plus **`packages/domain/src/recurring-expenses/job.ts:106`** —
T-216's job **copies the pattern into its own file**; it does not share the runner. It has its own
`for (const org of orgs)` loop, its own `startRun` above its own `try`, its own
`failRun` catch. So `job.ts` is in scope by the briefing's own condition ("only if it carries its
own copy of the pattern") — it does.

*(The register's DEF-219 row cites `:143` and `:780`; the briefing cites the `:144`/`:194`/… list.
The numbers above are the ones I read in the file today and are what this spec cites throughout.)*

**2. `failedInboxRun` (`:487`–`:505`) is the same defect with a wider blast radius.** It is a
degenerate copy — `startRun` then `failRun` immediately, no work between — and it is called from
**`Promise.all(orgs.map(...))` at `:461`**, on the path where the Firestore inbox read itself
failed. One refused `startRun` there rejects the whole `Promise.all`, so *every* org loses its row,
not just the ones after the first. The `for` loops at least reach the orgs before the failure.

**3. Moving `startRun` inside the `try` is NOT sufficient, and the register's first remedy would
leave the defect half-fixed.** Every catch block does
`await transaction((tx) => schedulerRepo.failRun(tx, runId, message))` — which needs a `runId` that
does not exist when `startRun` is what failed, and which can itself throw for the very reason
`startRun` did (a refused write, a dead pool). `finishRun` on the success path has the same
exposure. **Nothing in this file catches a failure of the recording call itself.** A fix that only
relocates `startRun` still aborts the loop whenever `failRun`/`finishRun` throws. The seam therefore
has to be **total**: the per-org helper must return a `JobOutcome` on every path and throw nothing.

**4. The bare `: ok` line the T-216 nit is about exists in two sibling scripts too.**
`scripts/finding-observation.ts:66` and `scripts/budget-reissue.ts:67` print `'<job>: ok'` with no
count, exactly as `scripts/recurring-expense-draft.ts:76` does. My scope is the one script, so I fix
only that one. **Flagged for the orchestrator** (RULES §13 row 164 — log what you see): the other two
are the same line and want the same treatment, either by widening this task's scope or as a register
row.

**5. DEF-218 does not undermine this task's tests, and it is worth saying why.** DEF-218 is that the
integration harness connects as `postgres` (`rolsuper` + `rolbypassrls`), so a missing RLS principal
is invisible. Every lever this spec uses to refuse a write is a **CHECK constraint or a trigger**,
which a superuser does not bypass. So these tests measure what they claim to. ⛔ This task does not
fix, work around, or depend on DEF-218 — that is a harness change and someone else's slice.

---

## Goal

A scheduler job whose **first write is refused for one organisation** records that organisation's
failure in the run's per-org outcomes and **continues to the next organisation**. No org after the
first is ever skipped, and the recorded failure names **the org and the error**.

Delivered as **one shared helper the ten placements call**, not ten edits — the placements are
identical today and must stay identical by construction, so the next job added cannot reintroduce
the defect by copying its neighbour.

Second, small and disjoint: `scripts/recurring-expense-draft.ts` prints `ok` on a no-op run with no
count. Print the count.

---

## Scope — the exact files this task may create or modify

| Path | Why |
|---|---|
| `docs/tasks/233-def-219-scheduler-runner-start-run.md` | this spec |
| `packages/domain/src/scheduler/index.ts` | the seam, and eight of the ten call sites |
| `packages/domain/src/recurring-expenses/job.ts` | the tenth call site — it carries its own copy (finding 1) |
| `packages/domain/tests/integration/scheduler.test.ts` | the failing-first-write tests |
| `packages/domain/tests/integration/recurring-expenses-job.test.ts` | only because `job.ts` changes |
| `scripts/recurring-expense-draft.ts` | the count line only |

**`packages/db/src/repo/scheduler.ts` is NOT modified.** `startRun`'s contract is already right —
"opens a run row BEFORE the work starts", `:38`–`:50` — and its docstring's reasoning (a row written
at the end could never record *"started and never finished"*) is untouched by this task. Nothing in
the repo needs to know that a caller now handles its refusal. Cited here because the briefing asked
for a reason either way.

**Not touched — described here, the orchestrator makes the change:** `PROJECT_BIBLE.md` ·
`docs/ROADMAP.html` · `docs/DEFECTS-REGISTER.md` (DEF-219's disposition at commit) · any
`packages/*/src/index.ts` barrel · migrations · every T-232 path.

**No barrel change is needed** and that is deliberate: `job.ts:58` already does
`import type { JobOutcome } from '../scheduler'`, so importing the helper across that same edge adds
no new dependency and no new cycle. ~~The helper stays module-private to `packages/domain`.~~
*(Corrected on review: it is `export`ed for `job.ts`, and `packages/domain/src/index.ts` does
`export * from './scheduler'`, so it rides `@shareat/domain`'s public surface like `runMonthEnd`
already does. No new class of exposure; the claim was simply wrong.)*

**No migration.** My migration slot is none. Nothing here changes a schema; if the build turns up a
schema need, that is a BLOCKED report, not a workaround.

---

## Contract

### 1. The seam — `runJobForOrg`, in `packages/domain/src/scheduler/index.ts`

```ts
/** What a job's body reports back. The helper turns this into a `JobOutcome` and a run row. */
interface JobWork {
  posted: number;
  skipped: number;
  failures: SchedulerFailure[];
  detail?: string;
  adjudicationFailures?: { clientPunchId: string; detail: string }[];
}

async function runJobForOrg(
  org: { id: string; name: string },
  job: JobOutcome['job'],
  period: string,
  trigger: 'cron' | 'manual',
  work: () => Promise<JobWork>,
): Promise<JobOutcome>
```

**It never throws.** Every path returns a `JobOutcome`. That single property is what makes
*"no org after the first is skipped"* true, and it is what the loops depend on.

### 2. Three guards, because there are three distinct failures

**Guard A — `startRun` refused. No run row exists and none can be written.**

```ts
let runId: string;
try {
  runId = await transaction((tx) => schedulerRepo.startRun(tx, { orgId: org.id, job, period, trigger }));
} catch (err) {
  return { ...base, posted: 0, skipped: 0, failed: 0, failures: [],
           error: `could not open a scheduler run row — ${message}` };
}
```

⭐ **This is the answer to the steer.** A refused `startRun` cannot record itself — the write is what
was refused — so the failure lives **only** on the in-memory outcome, and the existing result shape
already carries it:

- `JobOutcome.orgId` / `orgName` name the org. Both come from `base`, which is built from `org`
  **before** any write, so they are available even when nothing can be written.
- **`JobOutcome.error?: string` (`index.ts:73`)** carries the error text. This is the same field the
  existing catch blocks already use for "the job blew up outright".
- **`hadFailures: outcomes.some((o) => o.failed > 0 || o.error)`** — `index.ts:134`, `:258`, `:385`,
  `:607`, `:714`, `:894` and `job.ts:255` — already flips on `error` alone, so every CLI's non-zero
  exit code and every cron mailer already fire on this outcome with no change to any of the seven
  call sites.
- The CLIs already print it: `scripts/recurring-expense-draft.ts:52` →
  `` `${head}: FAILED OUTRIGHT — ${o.error}` ``.

⚠️ **The message is prefixed, and that prefix is load-bearing.** *"The run failed"* and *"the run
was never opened"* are different facts with different fixes: the second means the table itself
refused, so `scheduler_runs` has no row to find and the `/scheduler` screen will show an org that
looks like it was never visited. The prefix is the only thing that tells them apart, because there
is no row to carry a flag. **Rejected alternative:** a discriminating field on `JobOutcome`
(`runRecorded: false`). It is more precise but it widens a shape seven call sites and a screen read,
for a distinction only ever consumed as human-readable text. If a machine ever needs to branch on
it, the field is the right answer then.

**Guard B — `work()` threw.** The row exists. Best-effort `failRun`; its own failure is swallowed
and appended to the error rather than escaping:

```ts
} catch (err) {
  const message = ...;
  const note = await recordFailure(runId, message); // returns '' or ' (and the run row could not be closed: …)'
  return { ...base, posted: 0, skipped: 0, failed: 0, failures: [], error: message + note };
}
```

If `failRun` also fails, the row stays `finished_at IS NULL` — which
`schedulerRepo.unfinishedRuns` already reports as *"started and never reported back"*
(`repo/scheduler.ts:154`). That is the correct existing signal for exactly this state, so the
swallow loses nothing.

**Guard C — `finishRun` threw, after the work committed.** ⭐ The outcome keeps the **real counts**
and adds the error. Reporting `posted: 0` here would be a lie of exactly the kind
`runDepreciationJob`'s own comment (`index.ts:159`–`:167`) rails against, wearing its other face:
the work happened, the ledger has the entries, and only the bookkeeping of the run failed. The row
is left unfinished for `unfinishedRuns` to surface.

### 3. The ten call sites become `work` closures

Six are already separate functions with the identical shape and convert mechanically —
`runDepreciationJob`, `runAmortisationJob`, `runSweepForOrg`, `runMirrorPublishJob`,
`runInboxRelayForOrg`, `runOrderWastageBackstopForOrg`. Each keeps its whole body and its
comments; it loses `startRun`, `base`, the `finishRun` call, and the catch, and returns a `JobWork`.

Two are inline in their loop and become closures in place: `runFindingObservation` (`:676`–`:711`)
and `runBudgetReissue` (`:780`–`:891`). ⚠️ Their inner per-item `try`/`catch` blocks — the ones that
push to `failures` and are load-bearing for
`reference_postgres_batch_needs_savepoint` — are **not** touched.

`failedInboxRun` (`:487`) becomes a call whose `work` rejects immediately with the read error:

```ts
// The inbox read failed before any org could be attempted, so every org still gets a row saying
// so (DEF-044). Expressed through the same helper so this path cannot drift from the other nine —
// a rejecting `work` is exactly "open the row, then fail it".
runJobForOrg(org, 'inbox_relay', period, trigger, () => Promise.reject(new Error(message)))
```

⭐ This also fixes finding 2 for free: because the helper never throws, the `Promise.all` at `:461`
can no longer reject.

`job.ts:105`–`:253` imports `runJobForOrg` from `'../scheduler'` and uses it identically. Its
`detail` string and its per-template failure handling are unchanged.

### 4. `scripts/recurring-expense-draft.ts` — the count

Line `:76`, `console.log('recurring-expense-draft: ok')`, becomes a line carrying the totals summed
across `result.outcomes` — drafted, already-drafted, and the org count — in the same
counts-never-a-bare-done spirit its own `:55` comment and bible §15.6 state. Shape:

```
recurring-expense-draft: ok — drafted 0 · already drafted 4 · 2 orgs
```

Nothing else in the script changes.

---

## Invariants

1. **`runJobForOrg` never throws.** Every path returns a `JobOutcome`. *(The property the whole task
   rests on — `index.ts` loops at `:130`, `:255`, `:377`, `:480`, `:604`, `:675`, `:779`,
   `job.ts:104`.)*
2. **Every org in `listOrgsToRun` produces exactly one outcome per job, whatever fails.** Count in ==
   count out.
3. **A refused `startRun` writes nothing and claims nothing.** No `scheduler_runs` row, `posted`/
   `skipped`/`failed` all 0, `failures` empty, `error` set and prefixed, org named.
4. **`hadFailures` is true whenever any org's `startRun` was refused** — via the existing
   `|| o.error`, unchanged at all seven sites.
5. **A run whose work succeeded never reports 0 posted because its bookkeeping failed** (guard C).
6. **DEF-044's rule survives**: an org that ran and did nothing still gets a row. Only an org whose
   row was *refused* has none, and that is not a choice — it is the refusal.
7. **No behaviour change on the happy path.** Same rows, same counts, same outcomes, same
   `detail` strings.

---

## Tests — written first, watched to fail for the right reason

In `packages/domain/tests/integration/scheduler.test.ts`, against `shareat_test_def219`.

### ⭐ T1 — one org's first write is refused; the next org still runs. *The one that matters.*

A test-local `BEFORE INSERT` trigger on `scheduler_runs` that raises for one org id only:

```sql
create function t233_refuse_run() returns trigger as $$
begin raise exception 'T233: refused'; end $$ language plpgsql;
create trigger t233_refuse before insert on scheduler_runs
  for each row when (new.org_id = '<broken>') execute function t233_refuse_run();
```

⚠️ Test-local DDL on the lane's own database, created in the test and dropped in a `finally` — **not
a migration**, and my migration slot is none. It is the only per-org lever available: the insert's
only per-org column is `org_id`, and every CHECK on the table is org-independent.

Then `runMonthEnd({ period: '2026-01' })` over a broken org and a healthy one, and assert:

- it **resolves** — it does not reject *(before the fix: it rejects, and that is the failure to
  watch)*;
- the broken org has outcomes for both jobs, each with `error` matching `/could not open/` and
  `/T233: refused/`, `posted` 0;
- the broken org's outcome names it — `orgName` is its name;
- **the healthy org's depreciation `posted` is 1** — it still did its real work;
- `scheduler_runs` for the broken org: **0 rows**; for the healthy org: 2 rows, both finished;
- `hadFailures` is true.

### T2 — every org's first write refused, nothing is skipped

`runMonthEnd({ period: '2026-1' })` — a malformed period, refused by
`scheduler_runs_period_shape_check` (`migrations/0028_t140_scheduler_runs.sql:37`) for **every** org.
No trigger needed. Assert: resolves; `outcomes.length === orgs × 2`; every outcome carries the
prefixed error; `scheduler_runs` gains no row; `hadFailures` true. *This is the shape of the real
DEF-219 finding — the `scheduler_runs_job_check` refusing `recurring_expenses` before 0136 widened
it — with the one constraint I can trip without a migration.*

### T3 — the failure is recorded per org, and `failRun`'s own failure does not escape

Trigger on `UPDATE` instead of `INSERT` for one org, so the row opens and `failRun` cannot close it.
Assert: resolves; outcome carries the work's error; the row exists with `finished_at IS NULL` and is
returned by `unfinishedRuns`.

### T4 — the happy path is unchanged

The five existing tests in this file are the regression net and must stay green **unmodified**. If
any needs an edit, that is a behaviour change I did not intend and I report it rather than editing
the test.

### T5 — `recurring-expenses-job.test.ts` keeps passing, plus one refusal test

The 18 existing tests unmodified, plus T1's trigger applied to `runRecurringExpenses` — one org
refused, a second still drafts.

### Running them

```
node ~/.claude/skills/orchestrator/tools/it.mjs shareat_test_def219 \
  packages/domain/tests/integration/scheduler.test.ts \
  packages/domain/tests/integration/recurring-expenses-job.test.ts
```

⛔ Never `npm run test:integration` — it targets the shared `shareat_test` and would truncate
another lane's fixtures.

---

## Out of scope

- **DEF-218** — the harness's superuser connection. Named in finding 5 only to show these tests do
  not depend on it.
- ~~**`scripts/finding-observation.ts` and `scripts/budget-reissue.ts`** — the same bare `: ok`
  (finding 4). Flagged, not fixed; the orchestrator's call.~~ **Pulled INTO scope on approval** (see
  the header): both print their counts now — `opened <N> · <N> orgs`, `created <N> · <N> orgs`.
- **`packages/db/src/repo/scheduler.ts`** — unchanged, reasoned above.
- **Arming any timer** (DEF-194) and `docs/ops/README.md` — a T-232 path and not mine.
- **Retrying a refused `startRun`.** A refused write is a schema or outage fault; retrying it in a
  loop turns one bad org into a hang. It is recorded and the run moves on.
- **The `/scheduler` screen.** An org with no row already renders as no row; this task does not add
  a UI affordance for "refused". Worth a follow-up if the screen ever needs to say it.

---

## Done when

- [ ] T1–T3 written first and each watched to fail for the right reason, then green.
- [ ] The five existing scheduler tests and the 18 recurring-expense tests green, **unmodified**.
- [ ] All ten placements call `runJobForOrg`; no `startRun` remains outside the helper. Verified by
      `grep -n 'startRun' packages/domain/src` returning exactly one call site (the helper) — with a
      non-zero control first, per `reference_sweep_needs_nonzero_control`.
- [ ] `npx tsc --noEmit` clean; unit tests green — real output, exit codes quoted in the READY.
- [ ] `scripts/recurring-expense-draft.ts` prints the counts on a no-op run.
- [ ] Self-reviewed line by line.
- [ ] ⛔ Not done by me: commit, bible, roadmap, register disposition, board. Described in the READY
      for the orchestrator.
