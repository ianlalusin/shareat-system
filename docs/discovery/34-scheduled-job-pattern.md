# 34 — the current contract for a scheduled job in this repo

Read-only pass across the six shipped job pairs, ahead of T-272 (DEF-299, the orphan-file sweep).
For each: the `.service`/`.timer` pair in `docs/ops/`, the runner in `scripts/`, and — because neither
half tells the whole story alone — the shared harness both actually call, `packages/domain/src/
scheduler/index.ts` (`runJobForOrg`, `listOrgsToRun`) and, for the one outlier, `packages/domain/src/
recurring-expenses/job.ts`.

No code read here was changed. Two things noticed in passing are named at the end as `reported`,
per RULES §3 — not verified further, not fixed.

---

## 1. The six, side by side — the runner half

Every one of the six is invoked as `npm run <name>`, parses `--org=` and `--manual` off `process.argv`
with an identical hand-rolled `arg()` helper (copied six times, not shared — see §3.7), defaults
`trigger` to `'cron'` unless `--manual` is present, and wraps `main()` in an identical
`.then(exit code)/.catch(crashed)` pair that always calls `closeDb()`. That much is uniform. Below is
where they stop being uniform.

| Job (script) | DB connection for the actual write | Org enumeration | `scheduler_runs` write site | Reporting shape |
|---|---|---|---|---|
| `attendance-sweep` | `asSystem(org.id, …)` **inline** in `scheduler/index.ts` (`runSweepForOrg`) | `listOrgsToRun(orgId)` — all orgs, or one | `runJobForOrg` (shared harness) | one row per **store** summed into the org's `JobOutcome` |
| `month-end` (2 sub-jobs: depreciation, amortisation) | `runDepreciationAsSystem` / `runAmortisationAsSystem` — **pushed down** into `../fixed-assets/depreciate` and `../prepaid`, each owning its own system-principal call | `listOrgsToRun(orgId)` | `runJobForOrg`, called **twice per org** (one row for `depreciation`, one for `amortisation`) | counts **created**, not considered — `result.posted` includes already-posted no-ops and is explicitly NOT what gets reported (§3.3) |
| `firestore-relay` (2 lanes: mirror, inbox) | `withOrgPrincipal(org.id, …)` **inline**, both lanes | `listOrgsToRun(orgId)` for enumeration, but **inbox is not naturally per-org** — one global `systemTransaction` read resolves `storeId → orgId` for every event BEFORE any org-scoped tx opens, then fans out (§3.2) | `runJobForOrg`, twice per org (`mirror_publish`, `inbox_relay`) | split by lane — mirror `posted`/`skipped` vs inbox `posted`/`skipped`, **never summed together** (a stalled inbox must not hide behind a healthy mirror) |
| `order-wastage-backstop` | `asSystem(org.id, …)` **inline**, **one transaction for the whole org's due wastages** (not per-row) | `listOrgsToRun(orgId)` | `runJobForOrg` | `posted` = wastages closed |
| `recurring-expense-draft` | `withOrgPrincipal(org.id, …)` **as the template creator's real `Actor`**, through ordinary `authorize()`-gated domain calls (`recordInvoice`, `createExpense`) — **not** a system principal at all, and its own module (`recurring-expenses/job.ts`), not `scheduler/index.ts` | `listOrgsToRun(orgId)` (imported from `../scheduler`) | `runJobForOrg` (imported from `../scheduler` — the harness is shared even though the job body is not) | `due`/`drafted`/`already drafted`/`refused`, one tx **per template** |
| `finding-observation` | `asSystem(org.id, …)` **inline**, **one transaction for the whole org** (deliberately — a half-observed day would invent clears that never happened) | `listOrgsToRun(orgId)` | `runJobForOrg` | `detail` string naming which periods were re-asked, plus `opened`/`observed`/`closed` |

A seventh job lives in the same harness and is worth knowing about even though it isn't one of the
six requested — see §4's `reported` note: `budget_reissue` (`scripts/budget-reissue.ts`,
`runBudgetReissue`) follows the `asSystem`-inline, per-org, `runJobForOrg` shape identically to
`order-wastage-backstop`, one transaction **per budget**.

---

## 2. The six, side by side — the timer half

| Timer | `OnCalendar` | Style | `Persistent` | `AccuracySec` | Timezone pinned? |
|---|---|---|---|---|---|
| `attendance-sweep` | `hourly` | shorthand | `true` | `1min` | no |
| `firestore-relay` | `*:0/2` | stepped | `true` | `15sec` | no |
| `finding-observation` | `*-*-* 01:30:00 Asia/Manila` | explicit daily | `true` | `5min` | **yes** |
| `recurring-expense-draft` | `*-*-* 02:00:00 Asia/Manila` | explicit daily | `true` | `5min` | **yes** |
| `order-wastage-backstop` | `*-*-* 02:30:00 Asia/Manila` | explicit daily | `true` | `5min` | **yes** |
| `month-end` | `*-*-15 02:00:00 Asia/Manila` | explicit monthly | `true` | `5min` | **yes** |
| `month-end` **retry** (2nd timer, same service) | `*-*-15 03:00:00 Asia/Manila` | explicit monthly | **`false`** | `5min` | **yes** |

Every `.service` file is identical in shape regardless of which job it runs: `Type=oneshot`,
`WorkingDirectory=/srv/shareat`, `User=shareat`/`Group=shareat`, `Environment=NODE_ENV=production`,
`ExecStart=/usr/bin/npm run <name>`, both `StandardOutput`/`StandardError` appended to
`/var/log/shareat/<name>.log`, and the same `After=network-online.target`/`Wants=` pair with a
comment that Postgres is DO Managed and off-box so no `After=postgresql.service` is needed. **Zero
disagreement here** — this half of the pattern is genuinely settled. Every `.timer` file's own
`[Unit]` section is bare (`Description=` only, no `After`/`Wants`) — also settled.

Failure surfaces the same way for all seven services: the exit code is load-bearing (non-zero on
`hadFailures`), `StandardOutput`/`StandardError` both append to a per-job log file, and — per every
script's own header comment — that log is the ONLY watchdog; nothing here pages anyone if the timer
itself was never armed (that is `docs/ops/README.md`'s and DEF-194's territory, not this file's).

---

## 3. Where the six disagree, and which side is current

This is the part with actual value — "follow the existing pattern" is not one instruction, it is at
least five separate decisions, most of them made once and never written down as a rule.

### 3.1 Principal kind — system vs. the real creator's `Actor`

Five of six run as a **system** principal (`asSystem`/`withSystemOrgPrincipal`, or a domain module's
own `*AsSystem` export) and write straight through repos, bypassing `authorize()` entirely. One —
`recurring-expense-draft` — deliberately does **not**: it calls `recordInvoice`/`createExpense` as
the template's own creator, through their ordinary gates, stated explicitly as the point (*"the
automation can never do what the person who set it up could not"*).

**This is not an oversight to reconcile — it is the correct axis of disagreement**, and it splits on
one question: does the job's OUTPUT need to be attributable to a human's authority (money movement,
here a drafted-but-unapproved expense a person must still verify), or is it pure janitorial
housekeeping nobody signs their name to (closing a shift, publishing a mirror, sweeping stock,
sweeping a 15-day wastage clock, observing findings)? **For a new job with no "acting on someone's
behalf" question, the system-principal side (5 of 6) is current and correct.** `recurring-expense-
draft`'s divergence is domain-specific and should not be copied by default.

### 3.2 Where the system-principal wrapping actually lives

Even among the five system-principal jobs, the wrapping call site is not uniform:

- **Inline in `scheduler/index.ts`**, as a `run<Job>ForOrg` sibling function calling `asSystem`
  directly: `attendance-sweep`, `order-wastage-backstop`, `finding-observation`, and both lanes of
  `firestore-relay` (via `withOrgPrincipal`, since mirror/inbox are genuinely `staff`-scoped org data,
  not system-kind — see the file's own §"asSystem is NOT the same helper" note).
- **Pushed down into the domain module that owns the business logic**: `month-end`'s two sub-jobs
  call `runDepreciationAsSystem`/`runAmortisationAsSystem`, which live in `../fixed-assets/depreciate`
  and `../prepaid` respectively and own their own system-principal call internally. `scheduler/
  index.ts` here only unwraps the result into a `JobOutcome`.

**Which is current:** the inline shape is the more common and more discoverable one — six call sites
share one file, one import list, one place to read all scheduler jobs at once. Depreciation/
amortisation's push-down is explained by those functions being substantial, independently-owned
domain logic that predates or exceeds the scheduler's own concerns, not by any principle about where
scheduling code belongs. **A new job whose entire body is small and job-specific (a sweep, a
backstop, an observation) belongs inline, matching the majority.**

### 3.3 What gets reported as `posted`

Not a disagreement in mechanism, but in *discipline*, and it is worth naming because it is easy to
get wrong the way `month-end` almost did: `runDepreciationJob` explicitly filters
`result.posted.filter(p => p.created)` because the domain function's own `posted` array counts
postings **considered**, not written — reporting its raw length made a second run of the same month
falsely claim work it hadn't done. Every other job's domain-layer result already returns a number
that means "created/closed/drafted", so no such filter is needed there. **A new job must check
whether its domain function's return value already means "written" or merely "looked at"; the
scheduler layer is not where that gets fixed if it doesn't.**

### 3.4 Transaction granularity

- **Per item** (a store, a template, an asset): `attendance-sweep` (one tx per store),
  `month-end` (one tx per asset/prepaid item, inside the pushed-down domain functions),
  `recurring-expense-draft` (one tx per template). Reasoning stated identically wherever it appears:
  `reference_postgres_batch_needs_savepoint` — one DB error aborts the whole transaction it happened
  in, so a shared transaction would take the run's own `scheduler_runs` bookkeeping down with the one
  bad item and leave no trace at all.
- **Per whole org, one transaction**: `order-wastage-backstop` and `finding-observation`, for two
  different reasons stated in each — order-wastage-backstop because its own per-row failure handling
  already lives inside `runOrderWastageBackstop` and does not need a second layer of isolation at the
  scheduler; finding-observation because a **consistent daily snapshot** is the entire point, and
  observing half the detectors against one transaction and closing occurrences against a second would
  invent clears that never happened.

**Which is current:** per-item is the default and the majority; per-whole-org is a deliberate,
named exception each of the two times it appears, never a shortcut. **A new job should default to
per-item unless it has order-wastage-backstop's or finding-observation's specific reason not to.**

### 3.5 Cadence expression style, and timezone pinning

`attendance-sweep` uses the `hourly` shorthand; `firestore-relay` uses a stepped `*:0/2`; the four
daily/monthly jobs all use the fully explicit `*-*-{DD|*} HH:MM:SS Asia/Manila` form. **The pattern
is not arbitrary: only the jobs whose semantics depend on a wall-clock calendar boundary (a specific
day, a specific "today") pin `Asia/Manila` explicitly** — `attendance-sweep` and `firestore-relay`
don't need to, because neither cares what day it is, only that it runs on its own interval.
`month-end.timer`'s own header names the reason this matters more than it looks: an **unzoned**
`OnCalendar` is read by systemd as UTC, and that exact omission was DEF-241 (the job silently ran at
10:00 Manila instead of 02:00) — never omit the zone on a job that has a "today" or "this month".

### 3.6 `AccuracySec`, scaled to cadence but never stated as a rule

`1min` for the hourly job, `15sec` for the 2-minute job, `5min` for every daily/monthly job. Nobody
has written down "scale `AccuracySec` to roughly 1-2% of the interval", but that is what all seven
timers already do, consistently. **Following it (rather than copying one number blindly) is the
current, if unwritten, convention** — a new nightly job should use `5min`, matching every other
nightly job, not the hourly job's `1min`.

### 3.7 The retry timer — a one-off, not a pattern

`month-end` alone has a second timer (`shareat-month-end-retry.timer`) firing the same service again
at 03:00, `Persistent=false` **specifically because** the 02:00 timer's own `Persistent=true` already
covers an outage — a second catch-up would add nothing. Every comment on this file is explicit that
it exists because **Ian asked for it by name** ("2am and 3am if 2am fails") for this one job, not
because idempotent daily jobs generally deserve a retry timer. **None of the other four daily jobs
has one, and that is not an oversight — do not add one to a new job unless asked.**

### 3.8 `scheduler_runs.period` — a closed period vs. bookkeeping only

`month-end`'s `period` is the actual `YYYY-MM` being closed (`lastCompletedPeriod()`, business
content). Every other job has no period of its own — the column is `NOT NULL` by a `CHECK`
(`schema/scheduler.ts`), so all five others simply record the Manila month the run **happened in**
(`new Date(nowMs + 8*3_600_000).toISOString().slice(0,7)`), stated identically in each one's own
comment as bookkeeping, never a period being closed. **A new job with no period of its own should
follow the five, not `month-end`.**

### 3.9 The `arg()` helper is copied six times, not shared

Trivial, but real: `function arg(name) { return process.argv.find(...)...}` is hand-typed
identically (modulo formatting) in all six scripts. Nobody has hit a bug from the duplication, and
it is not proposed as a fix here — named because a seventh copy is what "following the pattern"
literally produces, and a shared `scripts/lib/cli-arg.ts` would be a one-time, low-risk cleanup if
anyone ever decides duplication six-deep is one too many. Not a recommendation to do it now.

---

## 4. Direct application to T-272 (DEF-299, the orphan-file sweep)

Three findings that change T-272's shape, found by reading `sweepOrphanedFiles` itself
(`packages/domain/src/files/index.ts:214`) against the pattern above, not by reading the task spec's
own description of it:

1. **⛔ `sweepOrphanedFiles` and `filesRepo.listOrphans` take no `orgId` and run once, globally**,
   returning one aggregate `{ removed, claimed, failed }` with no per-org breakdown. Every one of the
   six existing jobs writes **one `scheduler_runs` row per org**, and `scheduler_runs.org_id` is
   `NOT NULL`, FK'd to `organizations` (`schema/scheduler.ts:107-109`) — there is no representable
   "global" row. T-272 cannot wire this function in as-is; it needs `listOrphans(tx, orgId, hours)`
   scoped by org and `sweepOrphanedFiles(orgId, hours)` threaded the same way, called once per org
   from a new `runOrphanSweepForOrg`, the same shape as `attendance-sweep`/`order-wastage-backstop`.
2. **⭐ This is mechanically small, not a redesign.** `stored_files.org_id` already exists and is
   `NOT NULL` (`schema/stored-files.ts:54-56`) — `listOrphans` simply never filters on it today.
   Adding the `WHERE org_id = $1` and threading the parameter through is the entire schema-facing
   change; no migration is needed for this part.
3. **⛔ The write itself must also switch principal.** `sweepOrphanedFiles` currently opens each
   delete via a bare `systemTransaction` (correct for its CURRENT cross-org shape, per DEF-287's rule
   that cross-org reads/writes need the system door). Once scoped per-org, it must switch to
   `asSystem(orgId, …)` like every other system-principal job — a bare `systemTransaction` would keep
   bypassing RLS instead of scoping to the one org the run row claims to be about.

Following §3's other findings: the new job is a per-item (per-file), system-principal, inline-in-
`scheduler/index.ts`, daily, `Asia/Manila`-pinned, `Persistent=true`, `AccuracySec=5min` job with no
period of its own (bookkeeping month) and no retry timer — i.e. structurally closest to
`order-wastage-backstop`, not to `attendance-sweep` (no per-store wall-clock anchor exists here) or to
`recurring-expense-draft` (no human authorization question exists here). A nightly slot after
`order-wastage-backstop`'s 02:30 (e.g. 03:00 or later) avoids contending with any existing job's
window, matching the spacing reasoning every other timer's own comment already states — naming this
as a candidate, not deciding it; the exact minute is T-272's call.

**⚠️ The migration risk named in T-272's own spec is confirmed, not new:** `scheduler_runs_job_check`
is a shared enum-shaped `CHECK` that has already been widened four times (`0126`, `0130`, `0131`,
`0136`) — the same constraint T-272 must widen for its new job name. If any other lane's migration
touches this same constraint in the same cycle, the two `DROP`/`ADD` pairs must be reconciled into
one, or the second one to apply will silently narrow the list back down. Worth flagging to whoever
holds the next migration slot at the same time T-272 claims it.

---

## 5. Logged in passing (`reported`, not verified further — RULES §3)

- **`budget_reissue` (`scripts/budget-reissue.ts`, `npm run budget-reissue`, registered in
  `scheduler/index.ts` as `runBudgetReissue`) has no `docs/ops/shareat-budget-reissue.service` or
  `.timer` at all.** `ls docs/ops` lists units for all six jobs asked about here, plus
  `shareat-erp.service` (the app itself) — nothing for `budget_reissue`. The script exists, the
  scheduler wiring exists, `package.json` has the npm script — this is DEF-186/DEF-226's exact shape
  (a function built, registered, and callable, with nothing on any host actually calling it) for a
  **seventh** job. Told to the orchestrator directly per the standing instruction that DEF-303 is
  theirs to assign, not edited into the register here.
