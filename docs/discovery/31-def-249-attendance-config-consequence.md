# 31 — DEF-249: what payroll and adjudication actually do against a store with no attendance config

> **Read-only trace. No source file was created or modified; this document is the only output.**
> Commissioned by the orchestrator (`system32-85`) 2026-09-10 as DEF-249's *consequence trace*,
> because the register's own remedy column says the production consequence *"is not yet known"* and
> that answer decides whether DEF-249 is a wiring bug or a live payroll risk.
>
> Method: bible §1.2d step 3 — **count the live data**, *"populated, consistent, and actually
> consumed by anything downstream?"* Every claim below cites `file:line` at HEAD on 2026-09-10, or
> the SQL that produced it. ⚠️ **The tests were deliberately not used as evidence**, for the reason
> DEF-249 itself records: all ten attendance test files hand-seed the config in their own fixtures,
> so the suite can only describe behaviour at a *configured* store.

---

## 0. The answer, stated as a conclusion

⭐ **DEF-249 is a WIRING BUG, not a live payroll problem. No money has been computed wrong for
anybody, and none can be.**

The reason is stronger than "payroll refuses", and it is the finding: **a store with no attendance
config cannot produce a single `attendance_days` row.** `upsertDay` has exactly one caller in the
whole tree — `adjudicateDay` (`packages/domain/src/attendance/adjudicate.ts:158`) — and
`adjudicateDay` loads the config *before* it computes anything (`adjudicate.ts:126` →
`getConfigForShiftDay` → throws). So the arithmetic that could be wrong never runs at all. Payroll
then has nothing to pay, and refuses out loud before it even looks
(`packages/domain/src/payroll/index.ts:156-162`).

⛔ **But the same trace makes DEF-249 worse than the register states, in a direction the register
did not consider.** At an unconfigured store attendance is not *degraded* — it is **entirely
inoperative**: no punch can be recorded, no day can be computed, no payslip can be produced, and no
alarm can fire. And **there is no code path in the running application that can give a store its
first attendance policy** (§4). Every store created through the ordinary path since the seed is
permanently attendance-dead, and stays that way whatever an administrator does in the UI.

**Severity: unchanged (⚠️). Urgency: not an emergency, but it blocks a whole module for every new
store, and it is a capability hole rather than a missing call.** It is Ian's decision only in the
sense that §4 changes what the fix has to be.

---

## 1. Why "fails quietly in the direction that looks fine" is not what happens

`getLiveConfig`'s error text (`packages/domain/src/attendance/config.ts:24-28`) is the sentence that
motivated this trace:

> *"Every store gets one at creation — a store without one is not "using defaults", it is
> unconfigured, and an unconfigured attendance policy fails quietly in the direction that looks
> fine."*

⭐ **That warning guards a path it does not sit on.** `getLiveConfig` has exactly **one** production
caller: `supersedeConfig` (`config.ts:74`). It is not on the payroll path, not on the adjudication
path, and not on the ingest path — each of those reads the config by a different route. So the
sentence is only ever shown to an administrator trying to *change* a policy that does not exist. It
is accurate prose about a hazard, attached to the one caller where the hazard cannot occur.

The two halves of its claim also fail differently:

- *"Every store gets one at creation"* — **false**, and that is DEF-249.
- *"fails quietly in the direction that looks fine"* — **false as it stands**, and this document is
  the evidence. Every money-bearing consumer refuses loudly. The quiet failures that do exist (§5)
  are a date window, a scheduler skip and a mirror publish, none of which touches pay.

The same untrue claim is asserted a second time as a schema comment,
`packages/db/schema/attendance-config.ts:117`: *"every store is created fresh and
`seedAttendanceConfig` inserts with no explicit values"*. It is load-bearing there — it is the
stated justification for T-197/DEF-112 defaulting `short_shift_half_day_ot` to **true** — and it is
repeated verbatim in the migration that shipped that default,
`packages/db/migrations/0111_t197_short_shift_default_on.sql:17`.
⚠️ The default itself is not wrong; what is wrong is that the mechanism it relies on to reach a
store does not exist, so no store has ever received the default the migration was written to give it.

---

## 2. The complete consumer map

Everything in the tree that reads `store_attendance_config`, and what each does when the row is
absent. Non-test, non-migration; produced by
`grep -rn "store_attendance_config" packages/domain/src packages/db/src apps/erp/src scripts`
plus the two domain accessors.

| # | Reader | Route | Behaviour with no config | Loud? |
|---|---|---|---|---|
| 1 | `supersedeConfig` | `config.ts:74` → `getLiveConfig` | **throws** `AttendanceConfigError`; ERP renders it as a red banner | ✅ loud |
| 2 | `adjudicateDay` | `adjudicate.ts:126` → `getConfigForShiftDay` | **throws** `AttendanceConfigError` before `computeDay` and before `upsertDay` | ✅ loud |
| 3 | `previewPayRun` | `payroll/index.ts:156` — `attendanceConfigRepo.findLive` **direct** | **throws** its own `Error`: *"this store has no attendance configuration, so there is no shift length to price overtime or night differential against. Configure attendance first."* | ✅ loud |
| 4 | `ingestOne` (offline replay) | `sync/ingestor.ts:320` — `findForDay` **direct** | **quarantines** the event as `internal_error`, detail *"No attendance config governed &lt;day&gt; at this store, so no punch can be judged against it."* The punch is **never recorded** | ✅ loud (visible on `/attendance/lane`) |
| 5 | `sweepStore` | `attendance/sweep.ts:114-119` — raw SQL | **`return { swept: [], leftOpen: 0 }`** — silent, and `leftOpen: 0` asserts something it never checked | ⛔ **silent** |
| 6 | the sweep scheduler | `scheduler/index.ts:321-327` — `join store_attendance_config … superseded_at is null` | the store is **not in the job's list at all**; the job records `posted: 0, skipped: 0, failures: []` — a clean success | ⛔ **silent** |
| 7 | `defaultRange` (`/attendance`) | `apps/erp/…/attendance/lib.ts:63-68` | **`return { from: today, to: today }`** — a one-day window instead of the payroll period, no banner | ⛔ **silent** |
| 8 | mirror publisher | `sync/publisher.ts:206-209` | `if (!config) return null` — no `mirror/{store}/config/current` document is published | ⛔ silent (see §5.3) |
| 9 | `premiumSettingsFor` (`/payroll`) | `apps/erp/…/payroll/lib.ts:66` | returns `undefined`; page renders no settings strip, no period picker, and `periodStart`/`periodEnd` fall back to **empty strings** (`payroll/page.tsx:59-66`) | ⚠️ mixed — see §3.3 |
| 10 | `liveConfigFor` (`/settings/attendance`) | `apps/erp/…/settings/attendance/lib.ts:18` | renders *"This store has no attendance config yet."* and **no form** | ✅ loud, but a dead end (§4) |

⚠️ **Row 6 is a peer lane's file.** `packages/domain/src/scheduler/index.ts` was named in my briefing
as live under another lane; I read it and did not touch it. The behaviour is at
`scheduler/index.ts:321-327` **as the file stood on disk when I read it on 2026-09-10**; if that lane
is mid-edit the line numbers may have moved. The `join` is the load-bearing part, not the line.

---

## 3. The four questions, answered

### 3.1 Does it throw, and does anything catch and swallow it?

**It throws on every money-bearing path, and nothing swallows it.** Traced through all three callers
of `adjudicateDay`:

- **`sync/ingestor.ts:361-378`** — `adjudicateDay` is wrapped in a `try/catch` that converts the
  error to an `adjudicationFailure` string, counted rather than thrown. ⭐ **This is the one place
  that genuinely could have swallowed it, and it is unreachable at an unconfigured store**: the
  config check at `ingestor.ts:320-325` quarantines the event and returns ~15 lines earlier, so
  `recordPunch` and the `adjudicateDay` call are never reached. The catch is therefore not a hole
  here — but note *why* it is not, because that is an accident of ordering rather than a designed
  guard.
- **`attendance/adjustments.ts:130`** (`recordAdjustment`) — propagates. Unreachable anyway: there is
  no `attendance_days` row to adjust.
- **`adjudicate.ts:247`** (`adjudicateRange`, the review screen and the sweep) — propagates. It
  iterates `attendance_punches`; there are none, so the loop body never runs.

Payroll never calls `getLiveConfig` at all — it reads `attendanceConfigRepo.findLive` directly
(`payroll/index.ts:156`) and raises its own error. That error reaches the user twice, correctly:
`apps/erp/src/app/payroll/lib.ts:29-32` catches it and returns `{ preview: null, error }`, rendered
as a red banner (`payroll/page.tsx:190`); and `postPayRunAction`
(`apps/erp/src/app/payroll/actions.ts:60-61`) catches and redirects with the same message.
⛔ **`postPayRun` cannot post a run**: it calls `previewPayRun` first (`payroll/index.ts:379`), so the
refusal happens before any `pay_runs` or `payslips` row is written.

### 3.2 Does it fall back to a default? Whose, and generous or stingy?

**No. There is no default-config fallback anywhere in this repo, and that is deliberate.**

Verified mechanically: `grep -rn "DEFAULT_ATTENDANCE_CONFIG|defaultAttendanceConfig|DEFAULT_CONFIG"
packages apps/erp/src scripts` returns **exactly one hit**, and it is a doc comment at
`packages/db/schema/attendance-config.ts:36` citing *v1's* constant in `ERP-rebuild` as the source
the column DEFAULTs were copied from. No merge-with-defaults object exists in v2.

⭐ That absence is the design, stated in the schema's own header (`attendance-config.ts:27-33`):
*"Every column is NOT NULL with a default, so 'unset' cannot exist"* — the defaults live in the
**database**, applied at INSERT, precisely so nothing has to merge them at read time the way v1's
optional `enabledCredentials` / `breakEnabled` do. The v2 design is coherent; the bug is that the
INSERT never happens.

**So the generous-vs-stingy question does not arise.** There is no default to be generous or stingy
with. ⚠️ Worth naming, because it is the near-miss: had anyone "helpfully" added a read-time default
merge, an unconfigured store would silently have been given `requiredHoursPerShift = 9`,
`shortShiftHalfDayOt = true`, `overtimeMultiplier = 1.25` and `nightDiffEnabled = true` — a full,
plausible, entirely fictional policy — and DEF-249 *would* be a live payroll problem. The refusal is
what keeps it from being one.

### 3.3 Does it silently skip the store, so payroll runs and reports success having paid nobody?

**Payroll: no.** `previewPayRun` throws before it reads a single day; `postPayRun` cannot reach the
insert. There is no path on which a run completes and reports success while having paid nobody at an
unconfigured store.

⚠️ **One near-miss on the payroll screen, and it lands the safe way.** With no config,
`payroll/page.tsx:59-66` gives `periodStart` and `periodEnd` **empty strings**, which are then passed
to `preview(...)`. That looks like the dangerous shape — an empty date range silently querying zero
days — but the config check at `payroll/index.ts:156` fires *before* `payableDays` is called, so the
banner the user sees is the correct one ("Configure attendance first"), not a misleading empty
result. The ordering is what saves it. It is not defended by anything else.

**The attendance sweep: yes, exactly that shape — twice, redundantly.**

1. `scheduler/index.ts:321-327` selects the stores to sweep with an **INNER JOIN** on
   `store_attendance_config … superseded_at is null`. An unconfigured store is not in the result set,
   so it is skipped before any per-store code runs. The job returns
   `{ posted: 0, skipped: 0, failures: [] }` — indistinguishable from a genuinely quiet night, which
   is precisely the signal DEF-240's work exists to make trustworthy. Same family as **DEF-250**.
2. `sweep.ts:114-119` then repeats the skip: `if (!policy) return { swept: [], leftOpen: 0 }`.
   ⛔ The `leftOpen: 0` is the part worth naming — it is not "I found nothing", it is an assertion
   that **zero days are still open**, made by a function that never looked at `attendance_days`.

⭐ **State the consequence narrowly, because the tempting statement is bigger than the evidence.**
At an unconfigured store there are no `attendance_days` rows *at all*, so today the sweep skips a
store on which there was provably nothing to sweep. The skip is a **latent** hazard, not a live one.
For it to bite, a store would need days *and* no live config simultaneously — and `supersedeConfig`
retires and inserts inside one transaction (`config.ts:98-107`), so it cannot leave a store in that
state. **I could not construct a reachable path to that combination and I am not asserting one
exists**; what I am asserting is that two independent layers would fail silently if it ever did.

### 3.4 Does required-hours / late / undertime / overtime degrade to something that LOOKS like a normal result?

**No. It cannot degrade, because it never executes.**

`computeDay` — the pure engine that produces required-hours, late, early-out, undertime, break-over,
night-diff and pending-overtime minutes — is reachable only through `adjudicateDay`
(`adjudicate.ts:146`), and `adjudicateDay` obtains the config at `:126` before it calls `computeDay`
at `:146` or `upsertDay` at `:158`. `policyFromConfig` (`adjudicate.ts:71-88`) reads thirteen fields
off the row; there is no branch that constructs a `DayPolicy` any other way.

⛔ **The single-writer property is what makes this provable rather than probable.**
`grep -rn "upsertDay" packages apps --include=*.ts` outside tests returns exactly two lines: the
definition at `packages/db/src/repo/attendance-days.ts:75` and the one call at `adjudicate.ts:158`.
`recordPunch` is the same shape — `packages/domain/src/attendance/punches.ts:82`, with exactly one
production caller, `sync/ingestor.ts:334`, which is downstream of the quarantine at `:320-325`. So
both tables that could hold a wrong number are unreachable without a config row.

---

## 4. ⭐ The finding the brief did not ask for: no store can ever GET a first config

DEF-249 is written as *"`createStore` never calls `seedAttendanceConfig`"*, which reads as one
missing line. The trace says it is broader than that: **nothing in the product can insert a first
`store_attendance_config` row.**

`seedAttendanceConfig` (`config.ts:114-121`) is the only function that inserts without an existing
live row to supersede. Its complete reference set, from
`grep -rn "seedAttendanceConfig(" apps/erp/src packages scripts .github` (excluding `node_modules`):

| Location | Kind |
|---|---|
| `packages/domain/src/attendance/config.ts:114` | the definition |
| 13 call sites across **10** integration test files | tests only |
| — | **no production caller** |

The 10 files: `attendance-adjudication`, `attendance-adjustments`, `attendance-config` (×2),
`attendance-credentials`, `attendance-review`, `findings`, `firestore-relay`, `inbox-ingestor` (×2),
`lane-health` (×2), `mirror-publisher`.
⚠️ **DEF-249's own count is wrong**: the row says *"TWELVE test callers"* and *"12 integration test
files"*; it is **13 call sites across 10 files**. Reported, not corrected — the register is not mine
to edit.

And the other candidate entry points are all empty:

- **`createStore`** — `grep -n "attendance" packages/domain/src/stores/service.ts` returns three
  hits, all of them prose in comments (`:13`, `:228`, `:292`); no import, no call. Confirms the row.
- **`scripts/bootstrap-org.ts`** — `grep -n "attendance"` returns **nothing**.
- **`scripts/dev-seed.ts`** — `grep -n "attendance"` returns **nothing**.
- **`/settings/attendance`** — the screen's only action is `updateAttendanceConfigAction`
  (`apps/erp/src/app/settings/attendance/actions.ts:46`), which calls `supersedeConfig`, which calls
  `getLiveConfig` at `config.ts:74` and throws when there is no live row. The page renders
  *"This store has no attendance config yet."* (`page.tsx:80-83`) with **no form beneath it**.
  ⛔ That is the dead end lane C hit, and it is not a UI omission — the action behind it could not
  have worked either.
- **No script, job or migration** inserts one: the only non-test writers of the table are
  `attendanceConfigRepo.insertConfig` (reached only from `supersedeConfig` and
  `seedAttendanceConfig`) and the migrations that created it.

⭐ **So the accurate statement of DEF-249 is: the "give a store its first attendance policy"
capability exists as a function, is exercised only by tests, and is wired to nothing.** Same family
as DEF-226/DEF-227, as the register says — but with the additional property that **no manual
workaround exists either.** An administrator who notices the problem cannot fix it from the product.

---

## 5. Counting the live data — bible §1.2d step 3

All three databases, read-only. `shareat_test_t240` was read only; nothing was written to it.

### 5.1 The three databases

```sql
select (select count(*) from stores) as stores,
       (select count(*) from store_attendance_config where superseded_at is null) as cfg_live,
       (select count(*) from attendance_punches) as punches,
       (select count(*) from attendance_days) as days,
       (select count(*) from payslips) as payslips;
```

| Database | stores | live config | punches | attendance_days | payslips |
|---|---:|---:|---:|---:|---:|
| `shareat_test_t240` | 4 | **0** | 0 | 0 | 0 |
| `shareat_test_qa` | 53 | **0** | 0 | 0 | 0 |
| `shareat_dev` | 5 | **2** | 4 | 13 | 1 |

⭐ **53 stores across 36 organisations in the QA database, and not one attendance config row.** That
is the DEF-249 population at scale, and it is what "no real store has ever been given an attendance
policy" looks like when counted rather than sampled.

### 5.2 ⭐ The correlation, in the only database that has any attendance data at all

`shareat_dev`, per store, ordered by creation date:

| Store | created | live cfg | cfg rows | attendance_days | punches |
|---|---|---:|---:|---:|---:|
| Malvar | 2026-08-31 | 1 | 2 | 0 | 0 |
| Lipa | 2026-08-31 | 1 | 3 | **13** | **4** |
| Smoketest Commissary | 2026-09-02 | **0** | 0 | 0 | 0 |
| ZZ-DEACTIVATED T-177 Smoketest | 2026-09-04 | **0** | 0 | 0 | 0 |
| ZZ-DEACTIVATED T-222 Smoketest | 2026-09-06 | **0** | 0 | 0 | 0 |

⛔ **The split is exactly on how the store was created, and the code predicts it.** The two stores
from the 2026-08-31 fixture hold **all five** config rows in the database — every one stamped
`created_at = 2026-08-31 04:42:42`, within 15 ms of each other, the first row of each pair carrying
`created_by = NULL`, i.e. one bulk insert rather than the application. Every store created
*afterwards*, through the ordinary path, has zero config **and** zero attendance data. The one
payslip in the tree belongs to Lipa, the configured store.

⚠️ **This is correlation with a mechanism, not correlation alone** — §3.4 shows the code cannot
produce a day without a config, and the data shows it never has. Read together they are the proof.

The 13 days at Lipa are `verified` 10 / `needs_review` 2 / `voided` 1 — a store whose attendance
works normally, which is the control this comparison needed.

### 5.3 What has *not* fired

- `inbox_quarantine` holds **1** row in `shareat_dev` (`unknown_device`) and **0** in
  `shareat_test_t240`. **No `internal_error` quarantine from a missing config has ever occurred in
  any of these databases** — the path at `ingestor.ts:320-325` is reachable by reading and has never
  been exercised. Stated plainly because it matters: that behaviour is **read from the code, not
  observed**.
- The mirror publisher's `if (!config) return null` (`publisher.ts:206-209`) is likewise unobserved.
  I did **not** establish what enqueues an `attendance_config` outbox row, so I cannot say whether
  that branch is reachable at an unconfigured store or dead. **Not proven.**
- `openShiftsStale` (`packages/db/src/repo/findings.ts:1423-1447`) — the one detector that would
  raise *"the nightly sweep is not running"* — scans `attendance_days`. At an unconfigured store that
  table is empty, so **the finding can never fire there.** ⛔ The defect is invisible to the findings
  system by construction, which is why it took a lane hitting a dead-end screen to find it.

---

## 6. ⛔ What this trace did NOT establish

Stated deliberately, because "this specific thing is not proven" is worth more than a confident guess.

1. **Whether any real production store exists at all.** I read `shareat_dev`, `shareat_test_qa` and
   `shareat_test_t240` — development and test databases. **I did not query the production database on
   `159.223.46.224`**, and the register's framing about "real money for real people" cannot be
   confirmed or denied from here. ⭐ It does not change the verdict: §3 shows no payroll path can
   compute a wrong figure regardless of which database it runs against. But if anyone wants the
   sentence *"no production store has an attendance config"*, that specific count has not been taken.
2. **Whether the mirror-publisher branch (`publisher.ts:206-209`) is reachable** at an unconfigured
   store — I did not trace what writes `mirror_outbox` rows with `entity = 'attendance_config'`.
3. **Whether a store can reach "has days but no live config"**, the state in which §3.3's silent
   sweep skip would actually hide something. I could not construct such a path and am not asserting
   one exists.
4. **`packages/domain/src/scheduler/index.ts` is a peer lane's live file.** I read it once; its
   content may have changed since. The `join` at `:324` is the claim, not the line number.
5. **No test was run and no gate was executed** — this lane was told not to, and did not.

---

## 7. New findings, `reported` — for the orchestrator to file, not me

Bible §13 row 164: log what you see even when it is not the task; verification not required.

| # | Finding | Where |
|---|---|---|
| 1 | **DEF-249's own count is wrong** — 13 call sites across **10** test files, not "twelve test callers / 12 integration test files". Same failure shape as DEF-243: a population counted once and never re-counted | `docs/DEFECTS-REGISTER.md:319` |
| 2 | **The sweep scheduler skips an unconfigured store silently and reports success**, via an INNER JOIN on `store_attendance_config`. Same shape as **DEF-250** — a job that runs, finds nothing, exits 0, and is indistinguishable from a quiet night | `packages/domain/src/scheduler/index.ts:321-327` |
| 3 | **`sweepStore` returns `leftOpen: 0` when it has no policy** — not "I found nothing" but a positive assertion that no day is still open, made without reading `attendance_days`. A caller aggregating `leftOpen` across stores is handed a number that was never measured | `packages/domain/src/attendance/sweep.ts:118-119` |
| 4 | **`defaultRange` silently collapses the attendance review window to a single day** when there is no config, with no banner — the genuine instance of the "quietly, in the direction that looks fine" shape this trace was sent to find. Harmless today only because the screen has nothing to show | `apps/erp/src/app/attendance/lib.ts:63-68` |
| 5 | **A missing attendance config quarantines as `internal_error`, which is classified `retryable: true` and whose copy says *"Retry; if it sticks, show the raw event."*** Retrying can never help — the config will not appear by itself. The specific `reasonDetail` is appended and is accurate, so the operator is not left blind, but the headline sentence points at the wrong action | `packages/domain/src/sync/health.ts:289-293` vs `packages/domain/src/sync/ingestor.ts:322-324` |
| 6 | **`getLiveConfig`'s warning guards the one path where the hazard cannot occur.** Its only production caller is `supersedeConfig`; payroll, adjudication and ingest each read the config by a different route and never see it. A comment describing a real risk, attached where the risk is not | `packages/domain/src/attendance/config.ts:21-31` |
| 7 | **T-197/DEF-112's default has never reached a store.** `short_shift_half_day_ot` was defaulted to `true` on the measured argument that it is worth ~9.2% of basic pay and all three v1 stores run it that way — and the justification, in the schema *and* in migration `0111`, is *"every store is created fresh and `seedAttendanceConfig` inserts"*. Since that never happens, the correction shipped and landed nowhere | `packages/db/schema/attendance-config.ts:108-120`, `packages/db/migrations/0111_t197_short_shift_default_on.sql:17` |

---

## 8. What the answer means for the fix — inputs only, not a design

The fix is a later task and not this lane's to choose. Four things this trace changes about it:

1. **It is not urgent in the money sense and should not be rushed.** Nothing is mispaid and nothing
   can be. ⛔ It *is* blocking: attendance and payroll are unusable at every store created through the
   ordinary path, and no administrator can unblock themselves.
2. **`createStore` alone is not sufficient.** It fixes stores created *after* the fix. The
   already-created ones (3 of 5 in `shareat_dev`, all 4 in `t240`, all 53 in QA, and whatever exists
   in production) still have no route to a first policy, because `/settings/attendance` can only
   supersede. Whatever is decided, **the "first policy" capability needs a reachable surface**, and
   that is a design question, not a wiring one.
3. **The register's *"do NOT backfill blindly"* warning is right, and this trace sharpens it.** An
   `effective_from` invented for an existing store is a date from which pay would be computed — but
   note the consolation: since **no store without a config has any attendance day at all** (§5.2),
   there is no history for a backfilled date to retroactively restate. The decision is about what
   date is *honest*, not about what it would silently rewrite. That is a smaller decision than the
   row feared, and it is still Ian's.
4. ⭐ **The caller-existence guard the register asks for would not have caught this**, and the reason
   is worth carrying into the fix: the register says the existing guards *"only check
   `packages/db/src/repo/*`"*. But `seedAttendanceConfig` is not repo code — it is domain code with
   ten enthusiastic test callers. A guard counting *callers* sees thirteen and is satisfied. The
   guard that would have caught it counts **production** callers, i.e. callers outside `tests/`.

---

## FOR IAN

**The short version: nobody has been paid wrongly, and nobody can be. This is a plumbing hole, not a
money hole.**

Payroll was asked to price shifts at a store that has no shift settings. It refuses, with a plain
sentence on screen — *"this store has no attendance configuration… Configure attendance first"* — and
it refuses before it writes anything. It never guesses, never uses a default, never pays zero. I
traced every route into it and checked the databases to confirm the code and the data agree.

**The real problem is bigger than the one written down, and it is this: a new store can never get
attendance switched on at all.** Creating a store does not give it attendance settings, and the
settings screen can only *change* settings that already exist — so it shows "This store has no
attendance config yet" and offers nothing to click. Nobody, including an administrator, can fix that
from inside the app. Every store made since 31 August is in that state: no clock-ins can be recorded,
no days computed, no payslips produced. In the QA database that is **53 stores out of 53**.

Two smaller things worth knowing. The nightly attendance sweep quietly skips these stores and reports
a clean run — harmless today because there is nothing at those stores to sweep, but it is the same
"green means nothing happened" pattern as DEF-250. And a pay rule you approved in August (the
short-shift half-day overtime, worth roughly 9% of basic pay) was shipped as a default for new
stores — and because new stores never get settings, that default has never actually reached one.

**Nothing needs a decision from you today.** When the fix is scoped, the one real question is what
date an existing store's first attendance policy should start from. Good news on that: because these
stores have no attendance history at all, choosing a date cannot silently restate anything anyone was
already paid — it just needs to be an honest date rather than a convenient one.

⚠️ One limit on the above: I read the development and test databases, not the live production one.
The conclusion that no money can be miscomputed holds regardless of database — it comes from the
code. The specific sentence *"no production store has attendance settings"* has not been counted.
