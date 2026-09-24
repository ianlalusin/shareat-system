# T-276 — DEF-305: keep `fiscal_periods` coverage rolling forward

> ⭐ **IAN RULED OPTION (c), 2026-09-12 — BACKFILL THE GAP AND REPORT THE RUN AS `partial`.** Put
> to him in plain language as a three-way choice with (c) recommended; (a) and (b) are settled and
> must not be re-proposed. The HOLD on this spec is therefore LIFTED on its design question.
>
> ⭐⭐ **QUEUED FOR BUILD — IAN, 2026-09-20: *"queue T276"*.** Ordinary lane work before cutover:
> **not shelved, and not jumping the queue.** The design question was already settled on 2026-09-12
> (option c, above); both remaining gates were mechanical and both are now clear:
>
> | Gate | State |
> |---|---|
> | Lands after T-275 | ✅ T-275 has SHIPPED |
> | A migration slot to widen `scheduler_runs_job_check` | ✅ **SLOT `0157` IS ALLOCATED TO THIS TASK** (re-allocated 2026-09-24 by the orchestrator: `0156` went to T-336, which was ready first. It was originally allocated `0156` on 2026-09-20.) `0155` is APPLIED IN PRODUCTION and must never be edited. ⛔ Reserved and NOT to be re-issued: `0149`, `0150`, `0151`. |
>
> ⚠️ **The stale text this replaces said "build it next cycle on slot 0146"** — written when `0145`
> was the live slot. **Migrations have since reached `0155`**, so that instruction had been wrong for
> roughly ten slots and would have collided with an applied migration. ⭐ Recorded rather than
> silently corrected, because a task doc carrying a specific number nobody re-checked is exactly how
> the hand-applied-migration defect of 2026-09-06 happened.
>
> ⛔ **ONE MIGRATION PER CYCLE STILL HOLDS** (DEF-091, the 2026-08-23 collision). No other lane gets
> a slot in the cycle that builds this.
>
> ⭐ **Why it is armed with the others, not after them** (context given to Ian before the ruling):
> SHAREAT OPC's periods end **2027-08**, so the first uncovered date is **2027-09-01**, and the soft
> `fiscalPeriodRunwayLow` finding warns 60 days out — nothing is on fire. ⛔ **But the timer must be
> installed in the SAME pass as the other production timers rather than becoming a fourth one nobody
> installs.** `webapps-9f`'s script census measured the shape of that risk on 2026-09-20: all eight
> live timers `ExecStart` an `npm run <name>` in `/srv/shareat`, so **the unit-to-file mapping runs
> through `package.json` and no unit names a `scripts/` path at all** — a ninth timer added out of
> band is invisible to every in-repo check.
>
> ⛔ **Two things the BUILD spec must still pin, and they are the orchestrator's to decide, not
> Ian's:** (1) **what counts as "a gap"** — this spec names it as the price of (c) and leaves it
> open. Proposed: measure the org's coverage frontier (`latestPeriodEnd`) against the current
> business month, and treat **one month of slack as normal** so a run that fires a few days late
> never reports `partial`; the threshold is *frontier more than one whole month behind*. Argue it or
> replace it, but do not leave it unstated — **an unstated threshold is how (c) silently degrades
> into (b)**, which is the option Ian rejected. (2) the exact `docs/ops` `.service`/`.timer` pair,
> which makes this the THIRD unarmed timer.
>
> **Status: SPEC ONLY, 2026-09-12.** Lane B specs; no implementation code in this task. Sequencing
> note from the orchestrator: T-275 (DEF-304) is rewriting the job-caller-discovery guard right now,
> and this task adds a job name to the same `SCHEDULER_JOBS` union / `scheduler_runs_job_check`
> constraint that guard and its sibling pin. Build after T-275 lands, by whoever is free — not
> before, and not as part of this task.

## Why this exists

`docs/DEFECTS-REGISTER.md` DEF-305, filed 2026-09-12 out of T-274's own Q1: `seedCalendarMonths`
(`packages/db/src/repo/fiscal-periods.ts:75`) is the only function anywhere that creates a
`fiscal_periods` row, and it has exactly two callers — `createOrganization`
(`packages/domain/src/organizations/index.ts:169`), **once**, at bootstrap, seeding 12 months
forward from the org's creation month; and `scripts/backfill-fiscal-periods.ts`, a **manual**,
`--confirm`-gated CLI nothing schedules. `packages/domain/src/scheduler/index.ts` — every recurring
job this codebase has — contains zero references to `fiscal_periods`. Roughly twelve months after an
organisation is created, `postEntry` starts refusing every entry with *"no fiscal period covers
entry date …"* (`post-entry.ts:142-147`), and nothing brings coverage back except a human
remembering to run the backfill script.

## The check requested, not assumed — has anywhere already hit this?

**Production: no, on the best evidence in this repo, and I cannot check further.** `docs/ops/
README.md`'s last recorded status (2026-09-06) states *"Production has ZERO organizations"* in
terms, with `shareat-finding-observation` exiting 1 nightly for exactly that reason. I have no
droplet access and cannot query production directly — this is the orchestrator's/Ian's to confirm
independently, not something I can verify myself.

> ⛔ **CONFIRMED INDEPENDENTLY, AND IT CAME BACK THE OTHER WAY — T-300, 2026-09-13.** The lane was
> right to flag this as unverifiable from here, and right to ask for it: **production holds ONE
> organisation**, `SHAREAT OPC` (`select count(*) from organizations` → `1`, run against the live
> database as the admin role; independently derivable from `/var/log/shareat/budget-reissue.log`'s
> `ok — created 0 · 1 orgs` at 2026-09-12 15:57 UTC). The 2026-09-06 status quoted above was a true
> measurement **of 2026-09-06** and had been quoted forward as current for six days.
>
> ⭐ **So the answer to this section's question changes from "no, and nothing is counting down" to
> "no, and the countdown has started."** See the re-dated FOR IAN block below — the deadline is
> **2027-09-01**.

**This machine's own local dev database: not yet, but it has a visible countdown running.**
`shareat_dev` (`DATABASE_URL`, `localhost:5435`) has exactly one organisation:

| org code | created_at | fiscal_periods coverage |
|---|---|---|
| `shareat` | 2026-08-31 12:41:57+08 | 2026-08-01 .. **2026-12-31** |

Queried read-only, one `SELECT`, no writes. Today is 2026-09-12, so this org is not yet stuck — but
its coverage runs out in **under four months**, and it was seeded through a **5-month** window, not
the 12-month one `fiscalPeriodSeedWindow` gives production orgs (this org was almost certainly
created via a dev-seed script with its own hand-rolled window, not `createOrganization`'s production
path — a difference worth knowing but not this task's to fix). **Nobody is currently working around
"no fiscal period covers …" on this machine either — there just hasn't been time for the clock to
run out yet.** That is exactly what makes this cheap now, per the orchestrator's own framing.

I could not check any other lane's or any staging environment's database — I only have credentials
for this machine's `shareat_dev`/`shareat_test*`. If a longer-lived shared staging database exists
elsewhere, someone with access to it should run the same one-line check before assuming this is
universally unhit.

## The existing mitigation, and why it is not enough on its own

**This is not a coverage gap with zero warning today.** T-264 slice 1 already built
`fiscalPeriodRunwayLow` (`packages/db/src/repo/findings.ts:253-299`): a **soft**, never-blocking
finding that fires when an org's open-period coverage ends within `RUNWAY_WARNING_DAYS = 60`, with
the detail text *"Generate the next year of periods before then"* — and fires an even more direct
message when an org has zero periods, or zero *open* periods, at all. It is wired into every
`listFindings` call (`findings/index.ts:135`), so it is visible on `/findings` today for any org
whose coverage is genuinely low.

**What it does not do, and cannot by design:** it is a soft signal a person has to be looking at.
Nothing pages anyone, nothing blocks anything (correctly — RULES/ADR-006 both treat "an admin has an
errand" findings as soft), and the remedy it names is the same manual script this whole defect is
about. **This task's job does not replace that finding — it makes it redundant in the steady state
and gives it a second job for free once this job exists**: if `fiscalPeriodRunwayLow` ever fires
*after* the new job is deployed, that is no longer "somebody forgot to run a script," it is evidence
**the new job itself has stopped running** — the exact DEF-299/DEF-303 shape (a scheduled job with
no caller, or a caller with no armed timer), now with an existing, unmodified tripwire that already
points at it. No change to `findings.ts` is proposed or needed.

## Does anything assume `fiscal_periods` has exactly the bootstrap's twelve rows?

Checked directly: every consumer of `fiscal_periods` I could find resolves rows dynamically —
`findPeriodForDate` (date range lookup), `hasEarlierOpenPeriod`/`unpostedDraftsInPeriod` (status +
date range), `latestPeriodEnd` (`max(ends_on)`), `fiscalPeriodRunwayLow` (`max(ends_on)` again, plus
a bare `count(*)` used only to distinguish "zero periods" from "periods exist, none open"). None of
them assume a row count, a specific number of months, or that bootstrap's window is the only one that
ever ran. **Answer: no, nothing assumes exactly twelve rows** — coverage is read as "how far does it
reach," never "how many rows are there," which is exactly what makes topping it up safe to do
incrementally, in overlapping windows, from more than one call site.

## The design that needs almost no new code

`seedCalendarMonths` is already idempotent by the table's own `EXCLUDE` constraint (a bare `ON
CONFLICT DO NOTHING`, not a pre-read — its own doc comment at `fiscal-periods.ts:58-66` explains
why), and it already reports `periodsInserted`/`periodsSkipped` honestly, including the
`DEF-044`-shaped trap of a full skip looking identical to a full seed unless both numbers are
surfaced (same file, `:38-52`). **The scheduled job does not need a new domain function, a new repo
function, or new SQL.** It needs exactly one thing wired: a monthly call to the existing
`seedCalendarMonths(tx, orgId, fiscalPeriodSeedWindow())` for every organisation, through the
existing scheduler harness. `fiscalPeriodSeedWindow(now)` already computes "12 months forward from
the current business month" (`organizations/index.ts:113-118`) — called every month with a fresh
`now`, it produces a window whose end rolls forward by one month each run, which **is** a rolling
12-months-ahead horizon, with zero new arithmetic.

⚠️ **One real gap in that simple version, found by working through what "the job was down for a
while" means for it — see "The one open design question" below.** `fiscalPeriodSeedWindow(now)`
always starts the window at the *current* month, never at wherever the org's existing coverage
actually ends. That is fine when the job runs on schedule; it is not obviously fine after an outage.

## What the job does on an org whose coverage is already fine

Exactly what `seedCalendarMonths` already does on a fully-covered window: every one of its N
candidate months conflicts, `periodsInserted: 0`, `periodsSkipped: N`. Wired through the existing
`runJobForOrg` harness (`scheduler/index.ts:120-179`) unchanged, that becomes a `scheduler_runs` row
with `posted_count: 0, skipped_count: N, outcome: 'ok'`. **That satisfies bible §13 row 181's own
rule — "a sweep that reports a total must first report a known non-zero control" — for free**:
`skipped_count` being a known, predictable, non-zero number (N, the size of the window checked) on
every healthy run is exactly the control that lets a reader tell "ran, nothing to do" apart from "the
row does not exist, this org's run never happened" — no new column, no new convention, reusing the
same `periodsInserted`/`periodsSkipped` pair `scripts/backfill-fiscal-periods.ts` already prints for
the same reason (`:22-29`).

## Does seeding ever create a period already in the past, and what status is it born in?

**With the naive "always start from `now`" version above: no, never — and that is itself the
problem.** If the job runs on schedule, it only ever seeds forward from the current month, so nothing
it creates is ever in the past. But that also means a window that has fallen behind — because the job
itself was down, DEF-299/DEF-303's exact shape — is never backfilled by a resumed run: the job simply
resumes seeding from *today* forward and the missed months are permanently absent, having refused
every posting dated inside them for as long as the gap lasted and forever after unless someone runs
the manual backfill script by hand.

**The alternative — start the window at the org's own coverage frontier (`latestPeriodEnd`,
`fiscal-periods.ts:111-119`, already exists) instead of at `now`** — does create already-past
periods after a long-enough outage, and they would be born `open`, because `seedCalendarMonths` has
no other status to give them (it never takes one — every candidate month is inserted `status:
'open'` unconditionally). **This is exactly the shape T-264 slice 1 rejected for `postEntry` itself**
(*"an auto-created period is an auto-opened one"*, `docs/tasks/264-def-284-fiscal-period-lock.md:179`)
— a month born open in March that should have gone through its own 15-April close by now has skipped
every gate that ordinarily prompts a human to close it on schedule, silently, because it did not
exist yet when its own 15th passed.

⛔ **This is the one open design question in this spec, and it is a real trade-off, not a detail —
naming it rather than picking one:**

| Option | What it gets right | What it costs |
|---|---|---|
| **(a) Always seed from `now`** (the zero-new-code version above) | Never creates a past-dated period; simplest; matches T-264 slice 1's reasoning exactly | A gap, once opened, is permanent and silent — the very job meant to prevent DEF-305 cannot heal its own outage |
| **(b) Seed from `latestPeriodEnd + 1 month`** whenever that is earlier than `now` | Self-heals a gap automatically, closing the loop DEF-305 opened | Creates already-elapsed months as `open` with no close ritual applied — a new, narrower version of the same "auto-opened" risk, now scoped to catch-up only |
| **(c) (b), but treat a detected gap as a REPORTED failure, not a silent success** — seed it (so postings are unblocked immediately) and write a `failures` entry naming the gap in months, so the run is `outcome: 'partial'` rather than `'ok'` even though periods were created | Unblocks postings immediately (the more urgent harm) *and* makes the irregular catch-up visible on the same screen `/findings`-style monitoring already reads, rather than trusting a person to notice a coverage date | Needs one more field of judgement in the job body (what counts as "a gap" — one month of slack for an off-by-a-few-days run is not the same signal as six) |

**My recommendation is (c)**, for the same reason `closeYear` reused `postEntry`'s existing refusal
rather than defensively seeding (T-274's spec, "one decision needing your ruling"): a silent
auto-heal that never tells anyone a gap existed would make the NEXT instance of this exact defect
class harder to notice, not easier. But this is Ian's call, not a lane's — the FOR IAN section below
states it plainly rather than assuming.

## How far ahead should coverage run, and why that number

**Twelve months, unchanged from the existing bootstrap window — argued for staying at parity, not
picked fresh.** The number that matters here is not "how far ahead is enough," it is "how long can
THIS JOB itself be down before its own outage becomes anyone's emergency" — because a scheduled job
silently not running is precisely the failure class this cycle keeps finding (DEF-299, DEF-303, and
this defect itself). A wide horizon is what made the ORIGINAL bootstrap-only design survive a year
of nobody touching it; keeping the same width for the ongoing top-up means an outage of *this job*
has the same year-long grace period an outage of the *entire mechanism* already tolerated once.
Argued against, and rejected:

- **A shorter horizon (e.g. 3 months)** — cheaper per run (fewer candidate months checked, though at
  this cost that saving is not real money), but makes the job's OWN downtime dangerous roughly 4x
  sooner. Nothing about the business (ADR-006's 15-day close window, a monthly cadence) asks for
  finer granularity than a month, so there is no real benefit to buy with that risk.
- **A longer horizon (e.g. 24 months)** — no principled reason for the number, and a wider window
  is more rows created ahead of any real need, for no stated benefit over 12 that anyone has argued.

**Rejected as an alternative to a job at all, per RULES §3.6:**

- **Seed further ahead once, at bootstrap, and never again** (e.g. 24 or 60 months) — this is
  literally what created DEF-305: bootstrap-only seeding is exactly today's design, and every extra
  month bought at bootstrap only delays the same cliff, it does not remove it. Rejected for being the
  status quo restated with a bigger number.
- **Seed lazily, at period-close time** (e.g. `closeYear`/`closePeriod` top up coverage as a side
  effect of closing) — rejected for the same reason `closeYear`'s own spec rejected defensively
  seeding inside itself: it ties an operational maintenance concern to a business action that has
  nothing to do with it, and it does nothing for an org that never closes anything (a young org has
  no closes yet and is exactly the one still inside its bootstrap window, silently approaching the
  cliff with no closing action to hang a fix on).

## Cadence, shape, and naming — following `docs/discovery/34-scheduled-job-pattern.md`, not re-deriving it

That discovery pass (read ahead of T-272, still current) already answers most of the "how" questions
a new job raises, and this job fits its majority case cleanly rather than needing a new exception:

| Question (discovery doc §) | Answer for this job | Reason |
|---|---|---|
| Principal kind (§3.1) | **System**, like 5 of 6 | Pure janitorial maintenance, nobody's authority to attribute it to |
| Wrapping location (§3.2) | **Inline** in `scheduler/index.ts`, a `runFiscalPeriodSeedForOrg` sibling | The body is one call to an existing function — exactly the "small, job-specific" case the doc says belongs inline |
| What counts as `posted` (§3.3) | `seedCalendarMonths`'s own `periodsInserted`/`periodsSkipped` — already mean "written", need no filter | Confirmed by reading the function, not assumed |
| Transaction granularity (§3.4) | **One transaction per org**, a deliberate exception with its own stated reason (see below), not the per-item default | `seedCalendarMonths` is already one call handling all N candidate months; splitting it into per-month transactions would decompose an already-correct, already-tested function for no isolation benefit — there is no per-month business decision that could fail independently the way a per-asset depreciation posting can |
| Cadence style (§3.5) | **Monthly**, explicit `Asia/Manila`-pinned `OnCalendar` (this job's semantics depend on "which business month is it now") | Matches `month-end`'s reasoning exactly — this is a wall-clock-calendar-boundary job, not an interval one |
| `AccuracySec` (§3.6) | `5min`, matching every other daily/monthly job | Convention, not derived fresh |
| Retry timer (§3.7) | **None**, unless Ian asks for one by name | Every job but `month-end` has none, and `month-end`'s exists because Ian asked for it explicitly, not because idempotent jobs generally deserve one |
| `scheduler_runs.period` (§3.8) | **Bookkeeping only** — the Manila month the run happened in, not a period being "closed" | This job has no period of its own to close, same as five of the six existing jobs |

**Candidate name:** `fiscal_period_seed`, matching the noun-phrase style of `orphan_file_sweep` /
`budget_reissue` / `recurring_expenses`. Script `scripts/fiscal-period-seed.ts`, npm script
`fiscal-period-seed`, function `runFiscalPeriodSeed(options)` / `runFiscalPeriodSeedForOrg`.
**Candidate slot:** monthly, on the 1st (this job does not care about the 15th close date at all),
e.g. `*-*-01 03:30:00 Asia/Manila` — after `order-wastage-backstop`'s 02:30 and clear of `month-end`'s
15th-only slot, named as a candidate exactly as the discovery doc named T-272's, not decided here.

## Why this is spec-only, restated plainly

Building this needs: a new `fiscal_period_seed` entry in `SCHEDULER_JOBS`
(`packages/db/schema/scheduler.ts:46-96`), a migration widening `scheduler_runs_job_check` (the same
constraint `0126`, `0130`, `0131`, `0136` and now T-272's `0144` have each widened once), and a new
row in **both** job-caller guards (`tests/unit/scheduler-jobs-have-callers.test.ts`,
`tests/unit/scheduler-job-hosting.test.ts`). **T-275 (DEF-304) is rewriting the first of those two
guards' discovery mechanism right now** — it currently scans one hardcoded file
(`SCHEDULER_FILE = 'packages/domain/src/scheduler/index.ts'`) and misses jobs declared elsewhere.
Building this job's caller before T-275 lands means either fighting a guard mid-rewrite or landing a
pin that the rewrite immediately has to reconcile — the same collision two lanes hit on 2026-08-23,
now over a job name instead of a migration number. **Spec now, build after, by whoever is free.**

## Out of scope

- Any implementation code — schema, migration, scheduler wiring, systemd units, scripts. This is a
  spec.
- Deciding option (a)/(b)/(c) above — Ian's, named in FOR IAN below.
- Widening or changing `fiscalPeriodRunwayLow`. It needs no change; it already does its job and gains
  a second one for free once this ships.
- `scripts/backfill-fiscal-periods.ts` — stays as the manual, ad hoc tool for an org whose coverage
  needs a deliberate one-off top-up (e.g. right after this task's own migration lands, to catch any
  org that fell behind before the job existed). Not superseded, not touched.
- Any change to `docs/discovery/34-scheduled-job-pattern.md` — read as the authority, not amended.

## Done when (for the eventual BUILD task, not this one)

- Ian has ruled on (a)/(b)/(c) above.
- The spec above is turned into a task doc with exact migration slot, exact `docs/ops` unit pair, and
  the exact gap-detection threshold if (c) is chosen.
- T-275 (DEF-304) has landed and the new job registers cleanly against its rewritten discovery
  mechanism, watched — plant the new job as the guard's own proof it can see a job declared inline in
  `scheduler/index.ts`, the same way DEF-295's fix was proven by planting a violation.

## FOR IAN

**What this is:** a scheduled job to stop `fiscal_periods` coverage from running out a year after any
organisation is created — found while specifying T-274, not something urgent today (production has
zero organisations; this machine's own dev org still has ~4 months of runway).

> ⛔ **RE-DATED — T-300, 2026-09-13. Still not urgent. No longer open-ended, and this is the
> sentence to read if you read nothing else in this block.**
>
> Production holds **one** organisation, `SHAREAT OPC`, created in business month **2026-09**
> (`count(*) = 1`, measured 2026-09-13 as the admin role). `bootstrapOrganization` seeds **12
> consecutive calendar months from the organisation's current business month**
> (`fiscalPeriodSeedWindow`, `packages/domain/src/organizations/index.ts:95-117`, `months: 12`).
>
> **So SHAREAT OPC's `fiscal_periods` cover `2026-09` → `2027-08`, and the first uncovered date is
> `2027-09-01` (Asia/Manila).** That is roughly **11½ months of runway** from today.
>
> ⭐ **The deferral survives and gets a deadline instead of a feeling.** This row predicted *"cheap
> now and an outage later"*; the "later" is now a date, and the recommendation becomes **build the
> coverage job before 2027-09-01**. ⚠️ The January cutover falls well inside that window, so the
> organisation will be carrying real books long before coverage runs out — which is precisely the
> combination that makes a silent expiry expensive rather than annoying.

**Three things only you can decide:**

1. **This is the THIRD timer from today's work alone** (orphan sweep, budget reissue, now this) that
   will eventually need arming on the droplet. Naming it because `docs/ops/README.md`'s own history
   is three real incidents (v1 depreciation, POS holiday calendar, POS weather) where a merged job
   was never actually scheduled — the more timers wait for one arming pass, the more that pass looks
   like this one.
2. **Does a resumed job backfill a coverage gap it finds (option b/c above), or only prevent new ones
   (option a)?** Backfilling unblocks postings sooner but creates already-elapsed months as `open`
   with no close ritual behind them; never backfilling is simpler and matches T-264's own reasoning
   about auto-opened periods, but leaves a permanent hole if this job is ever itself down for a full
   cycle. I lean toward backfilling loudly (option c) but it is your call.
3. **Nothing is on fire.** No environment I can check has hit this yet, and the existing
   `fiscalPeriodRunwayLow` finding already gives 60 days' warning today, soft and non-blocking. This
   can wait for a normal cycle; it does not need to jump the queue.
