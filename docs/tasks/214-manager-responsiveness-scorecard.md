# T-214 — The manager responsiveness scorecard, and the clock findings do not have

> **Status**: specced 2026-09-06. The last Phase 6 slice (`docs/plans/phase-6-reporting-and-dashboards.md`
> §5.1, Wave 3). **Not implemented.**
>
> ⛔ **This is not a report over data that already exists.** The scorecard v1 ships cannot be ported,
> because **the input it depends on does not exist in v2 and cannot be derived** — see §2. Two thirds
> of this task is building that input; the score itself is about forty lines.

## 1. Why this exists

v1 scores manager responsiveness as a composite 0–100 and logs whether the report was opened at all
(`getManagerScorecardAction`, `insightViewLog`). T-135 decided to keep it, and said why:

> *"A finding nobody is accountable for is a finding nobody clears."*

with one caution, which is the reason it is safe here at all:

> ⚠️ *"A score people are measured on is a score people manage."* The failure mode is resolving
> findings without fixing causes — **which the derived model already makes impossible.** Keep the
> scorecard; it is safe **only because resolution now requires the condition to actually go away.**

⭐ **That sentence is load-bearing, and §3 shows it does not survive a naive port.** The obvious
translation of v1's algorithm re-opens exactly the hole T-135 closed.

## 2. ⛔ The blocker, established before any design: findings have no clock

v1's score needs three facts per finding: when it was **first seen**, when it was **resolved**, and
**by whom**. v1 has all three because it stores a daily insight slice per store and walks them.

**v2 has none of the first.** `DetectedFinding` is:

```ts
export interface DetectedFinding {
  kind: string; key: string; storeId: string | null;
  severity: 'hard' | 'soft'; detail: string;
}
```

No timestamp, and there cannot be one: a finding is a **pure function of current state**. Run the
detector today and it tells you the condition holds *today*. It cannot tell you it also held on
Tuesday, and almost none of the detectors can be re-asked "as of" a past date — they read live
balances, not an as-of ledger.

So of v1's three facts, v2 today has exactly one and a half:

| v1 needs | v2 source | Status |
|---|---|---|
| `resolvedBy` | `finding_acknowledgements.acknowledged_by` | ✅ exists, full history kept |
| `resolvedAt` | `finding_acknowledgements.acknowledged_at` | ✅ exists |
| `firstSeen` | — | ⛔ **nothing** |
| `raised in period` | — | ⛔ **nothing** |

⚠️ **Without `firstSeen` there is no speed-to-resolve component at all**, and without "raised in
period" there is no denominator. Both of the two surviving components need it. **This is the task.**

### Counting the live data first (§1.2d step 3)

Measured on `shareat_dev`, 2026-09-06:

| Quantity | Count |
|---|---|
| Findings currently firing | **5** (5 distinct kinds, 2 `hard`, across 3 stores) |
| `finding_acknowledgements` rows, ever | **0** |
| Persons | 9 |

⭐ **Read that second row twice.** Ship the scorecard against today's data and **every manager scores
null, every component is empty, and the screen is indistinguishable from a broken one.** That is not
a reason to skip the task; it is the reason §7's non-vacuity test is mandatory and why §5.4 exists.

## 3. ⭐ The design decision: score what was FIXED, never what was accepted

The naive port maps v1's `resolved` onto v2's `acknowledged`. **Do not do this.**

In v1, "resolved" was a manager asserting the problem was dealt with. In v2, acknowledging means
*"I accept this risk for now"* — the condition **still holds**, the finding is **still counted**, and
the acceptance **ages and expires** (T-135). These are opposite acts.

⛔ **So an action-rate that counts acknowledgements pays managers to accept risk.** A manager
maximises it by acknowledging everything on sight, having fixed nothing — the precise gaming T-135
believed the derived model had made impossible. It had, right up until a score was pointed at the
wrong column.

**The component that is actually safe is the one v1 could not build**: a finding whose condition
*stopped holding*. In v2 that is observable, unforgeable, and requires no honesty from anyone —
the detector simply stops returning the key.

| Component | v1 | **v2 — this task** |
|---|---|---|
| Action | findings *resolved* ÷ raised | **occurrences CLEARED ÷ opened** — cleared means the detector stopped reporting it |
| Speed | mean days first-seen → resolved | **mean days opened → closed** |
| Briefing coverage | opened-days ÷ days-with-findings | ⛔ **dropped** — no briefing exists (§4.5) |
| Acknowledgement | *(not scored in v1 either)* | ⚠️ **reported, never scored** — count + age. An ageing acceptance is a smell (T-135), not a credit |

### 3.1 The re-weighting is v1's own mechanism, not new arithmetic

v1 already normalises over whichever components are present:

```ts
if (actionScore != null) parts.push([0.4, actionScore]);
if (coverage    != null) parts.push([0.3, coverage]);
if (speedScore  != null) parts.push([0.3, speedScore]);
const wsum = parts.reduce((a, [w]) => a + w, 0);
const score = wsum > 0 ? Math.round(100 * Σ(w·v) / wsum) : null;
```

⭐ **So "two components re-weighted, not three with a zero term" needs no new code — it needs the
coverage part not to be pushed.** Keep v1's raw 0.4 / 0.3 and its `wsum` division, so the surviving
ratio is v1's own: action is 1.33× speed, i.e. **57% / 43%**. ⛔ Do **not** rewrite them as 0.5/0.5 —
that silently re-decides a weighting nobody asked to change.

⚠️ And keep the `null` behaviour exactly: a store with no closed occurrences scores `null`, **not
zero**. A zero says "responded badly"; a null says "nothing to judge", and a permanently-zero line is
the defect bible §16.9 names (*"report noise is a real control weakness"*).

### 3.2 ⚠️ The unit of scoring is the STORE — and this needs Ian (§9 Q1)

A cleared occurrence has **no actor**. Nobody clicks anything; the condition stops holding. So the
per-person attribution v1 had is not merely missing, it is **meaningless** for the safe component.

The scorecard is therefore computed **per store** and presented against the manager(s) scoped to it,
which is how the business is actually shaped — a store has a manager. Org-wide findings
(`store_id is null` — a trial balance belongs to no branch) are scored in a separate **org** row that
belongs to the admin, never spread across stores.

## 4. Goal

`/findings` gains the accountability half it was specced without: **for each store, how many of the
findings raised in a period got fixed, how fast, how many were merely accepted and how old those
acceptances are, and when a human last actually looked.**

## 5. Contract

### 5.1 `finding_occurrences` — the clock, and why it is not "storing findings"

New table. Migration **`0130`** (0129 is the last; ⚠️ verify before generating — a concurrent lane
may have claimed it, and `reference_migration_when_must_track_idx` applies).

| Column | Notes |
|---|---|
| `id` | `uuidv7()` |
| `org_id` | FK, restrict |
| `store_id` | FK, **nullable** — null is an org-wide finding, mirroring `finding_acknowledgements` |
| `finding_key` | the detector's stable key |
| `kind` | denormalised so the scorecard groups without re-deriving |
| `opened_on` | `date`, Manila. **`firstSeen`** |
| `last_seen_on` | `date`, Manila. Advanced by every run that still sees the key |
| `closed_on` | `date`, null while open. Set by the first run that does **not** see the key |
| `created_at` | |

- **Partial unique index** on `(org_id, coalesce(store_id,'…'), finding_key) where closed_on is null`
  — a key has **at most one open occurrence**, which makes the daily job idempotent and re-runnable.
- Index on `(org_id, opened_on)` for the period query.
- ⚠️ Manila dates via `MANILA_TODAY` (T-218's `sql-time.ts`). **Never bare `current_date`** — the
  standing guard `tests/unit/findings-single-clock.test.ts` will fail the build, correctly.

> ⭐ **This does not violate T-135, and the distinction must be in the file header or someone will
> "fix" it.** T-135 forbids storing a finding's **state**, because v1 stored `state` per finding and
> resolving one suppressed tomorrow's recompute *while the condition still held* (bible row 123).
> `finding_occurrences` stores an **observation** — "the detector reported this key on this day" —
> and ⛔ **nothing in the detection path ever reads this table.** It is evidence, not state. Detection
> stays exactly as pure as it is today; delete the table and every finding still fires identically.

### 5.2 The writer — a scheduler job, because the alternative is DEF-186

`recordFindingObservations(tx, orgId)`:

1. `listFindings(tx, orgId, { period })` — **the same machine as the screen**, never a second query
   that could disagree (T-135 invariant 7's reasoning).
2. For each key returned: `insert … on conflict do update set last_seen_on = MANILA_TODAY`.
3. For every open occurrence whose key was **not** returned: `closed_on = MANILA_TODAY`.

#### ⛔ 5.2a The closure rule, and the month-boundary bug it exists to prevent

`listFindings` takes a **`period`**, and the periodic detectors embed it in the key:

```ts
key: `depreciationNotBooked:${period}`   // e.g. depreciationNotBooked:2026-08
```

⚠️ **So a naive step 3 is wrong in a way that only shows up on the 1st of the month.** If the job
asks about `lastCompletedPeriod()` and nothing else, then when the period rolls to `2026-09` the key
`depreciationNotBooked:2026-08` is no longer returned — **and step 3 would close its occurrence as
though someone had fixed it.** August's depreciation is still unbooked. The month simply stopped
being asked about.

That single line would inflate `clearRate` at every month boundary, for the `hard` findings that
matter most, and it would look like managers improving.

**The rule: an occurrence may only be closed by a run that actually asked its question.**

1. The run asks about `lastCompletedPeriod()` **plus every earlier period that still has an open
   occurrence**. Bounded (it shrinks as things get booked), and it converges.
2. Step 3 closes an open occurrence **only if its key was in scope for this run** — for a
   period-suffixed key, only on the run that asked about that period.
3. Keys with no period suffix are always in scope and behave as §5.2 describes.

⚠️ Invariant 11 pins this, and it is the one test in this task most likely to be dropped as fiddly.
It is the one that protects the number the whole screen is about.

⛔ **The caller is named here on purpose.** A `recordFindingObservations` with no caller is DEF-186
exactly — `replenishAfterUsage` was built, tested, marked done, and invoked by nothing for weeks.
So this task is **not done** until:

- `'finding_observation'` is added to `SCHEDULER_JOBS` (`packages/db/schema/scheduler.ts`) **and**
  the `scheduler_runs_job_check` constraint is widened in migration `0130`. ⚠️ That schema file
  carries an explicit warning about *"a second lane widening the same constraint independently"* —
  read it before generating.
- `scripts/finding-observation.ts` + `"finding-observation"` in `package.json`, following
  `scripts/month-end.ts`: per org, one org's failure never stops the next, outcome written to
  `scheduler_runs` with a reason for every failure.
- It runs as T-140's **`system` principal**, not a person. A scheduler has no session, and
  `authorize()` answers *"may this person…"*.
- `docs/ops/shareat-finding-observation.{service,timer}` exist, **daily**, and `docs/ops/README.md`'s
  job table gains a row.

> ⛔ **Installing the timer is the finish line, not merging the code.** `docs/ops/README.md` says it
> because of DEF-044: v1's seed data claimed *"auto-generated by the depreciation cron"* and **no
> such cron ever existed** — two months and ₱35,483.98 went unbooked, and an audit found it, not a
> person. ⚠️ `provision.sh` installs units but does **not** enable them; the `systemctl enable --now`
> line must be added to the README's list too.

**Cadence: daily.** Not hourly (findings are day-grain and the detectors are not cheap), not weekly
(a 7-day resolution on `opened_on` makes the speed component meaningless against a 14-day scale).

### 5.3 `managerScorecard(tx, orgId, { from, to })`

Per store (plus one org row), over occurrences with `opened_on` between `from` and `to`:

| Field | Definition |
|---|---|
| `raised` | occurrences opened in the period |
| `cleared` | …of those, with `closed_on` set |
| `clearRate` | `cleared / raised`, null when `raised = 0` |
| `avgDaysToClear` | mean `closed_on − opened_on`, 1 d.p., null when `cleared = 0` |
| `speedScore` | `max(0, min(1, 1 − avgDaysToClear / 14))` — **v1's 14-day scale kept verbatim** |
| `score` | `round(100 · (0.4·clearRate + 0.3·speedScore) / wsum)` over present parts only; null if none |
| `stillOpen` | occurrences opened in the period still open — the number a manager acts on |
| `acknowledged` | live acknowledgements for this store ⚠️ **reported, not scored** |
| `oldestAcknowledgementDays` | `max(acknowledgementAgeDays)`. An ageing acceptance is a smell |
| `lastViewedAt` / `lastViewedBy` | from §5.5, or null — *"nobody has opened this"* is the finding |

⚠️ **`avgDaysToClear` uses whole Manila dates**, so a finding opened and cleared the same day is
**0 days**, not a fraction. Do not reach for `Date.now()`; `daysBetweenDates` in T-218's `sql-time.ts`
exists for exactly this and the single-clock guard enforces it.

### 5.4 ⛔ The screen must say the clock only started when the clock started

`finding_occurrences` begins empty. On the first run, the 5 findings that have held for weeks all
get `opened_on = today` and will read as brand-new. **There is no backfill and there cannot be one —
the history does not exist anywhere to recover.**

So the scorecard renders, above the table:

> *Ages are measured from **<first observation date>**, when this record began. Findings older than
> that are shown as starting then; their true age is not recoverable.*

⚠️ **This sentence is part of the deliverable, not a nicety.** A number that silently understates how
long a problem has been ignored is worse than no number, and this project has filed nine defects of
the shape *prose claiming something the code does not do*.

### 5.5 The view log

`finding_views`: `id · org_id · person_id · viewed_on (date, Manila) · created_at`, unique on
`(org_id, person_id, viewed_on)` so a day counts once however many times the page is refreshed.

Written from `/findings`' page load. ⚠️ **Three rules, because this is a write on a read path:**

1. It **must not** run inside the render's read transaction.
2. A failure **must not** fail the page — the log is accountability, the page is the work.
3. It records *that* someone looked, and is **not scored** (§3). Scoring page-opens pays people to
   open pages.

### 5.6 Routes

`/findings/scorecard`, linked from `/findings` — not a new nav group. ⚠️ DEF-139 and DEF-181 were both
screens reachable only by typing the URL; a link is part of shipping.

## 6. Scope — files this task may create or modify

```
packages/db/schema/findings.ts            findingOccurrences, findingViews
packages/db/schema/scheduler.ts           + 'finding_observation'
packages/db/migrations/0130_*.sql         tables, indexes, RLS, job-check widening
packages/db/src/rls/registry.ts           both new tables (the build stops you otherwise)
packages/db/src/cutover/classification.ts both new tables
packages/db/src/repo/findings.ts          occurrence upsert/close, scorecard query, view log
packages/domain/src/findings/index.ts     recordFindingObservations, managerScorecard, logFindingView
scripts/finding-observation.ts            the CLI entry point
package.json                              the script
docs/ops/shareat-finding-observation.*    service + timer
docs/ops/README.md                        the job table row + the enable line
apps/erp/src/app/findings/                scorecard page, link, view-log call
```

## 7. Invariants

1. **A key has at most one open occurrence** — enforced by the partial unique index, not by code.
2. **The job is idempotent**: running it twice on the same day changes nothing the second time.
3. **A finding that stops firing closes its occurrence** on the next run, with no human action.
4. **A finding that reappears after closing opens a NEW occurrence** — it regressed; it is not the
   old one continuing. ⭐ This is strictly better than v1, which had no occurrence identity at all.
5. **Acknowledging a finding changes no occurrence.** Acceptance is not resolution (§3).
6. **Nothing in the detection path reads `finding_occurrences`** — provable by deleting the table's
   rows and asserting `listFindings` returns exactly the same feed.
7. `score` is **null**, never 0, when there is nothing to judge.
8. Org-wide findings (`store_id is null`) never contribute to a store's score.
9. Every date is Manila, via `sql-time.ts` — the single-clock guard must stay green.
10. A view-log failure never fails `/findings`.
11. ⭐ **A period-suffixed occurrence is not closed by a run that asked about a different period**
    (§5.2a). Roll the clock past a month boundary with `depreciationNotBooked:<prev>` still unbooked
    and assert the occurrence is **still open** — this is the invariant that keeps `clearRate`
    honest, and the easiest one to skip.

## 8. Tests

Each watched fail first (T-135's own discipline, and DEF-178's lesson that a test which has never
been seen red is not known to work).

- Invariants 1–5, 7–8 and **11**, integration, against real Postgres.
- ⭐ **Invariant 11 gets its own scenario**, because it is a month-boundary bug and no ordinary test
  crosses one: open a `depreciationNotBooked:<prev>` occurrence, run the job for the *next* period,
  and assert the occurrence is still open and `clearRate` did not move.
- **Invariant 6 is the important one** and needs the deliberate deletion, not an argument.
- ⭐ **A non-vacuity test**: with occurrences seeded, the scorecard returns a **non-null** score for
  at least one store. Given §2's live counts (0 acknowledgements), a scorecard that returns all-nulls
  is exactly what a broken one returns, and nothing else in the suite can tell them apart.
- The re-weighting: a store with clear-rate but **no** speed data scores on clear-rate alone, and the
  result equals `100·clearRate` — proving `wsum` normalisation, not a hidden zero term.
- ⚠️ A **regression pinning the weights**: assert the two-component score of a store with
  `clearRate=1, speedScore=0` is **57**, not 50. That is the ratio v1 chose; a future edit that
  "tidies" the weights to 0.5/0.5 must go red.
- The scheduler job appears in `scheduler_runs` with an outcome, including on failure.

## 9. Open questions — for Ian

1. ⭐ **Is a per-STORE score acceptable, given a cleared finding has no actor (§3.2)?** It is called
   the *manager* scorecard, and v2 cannot attribute a fix to a person the way v1 attributed a click.
   **Recommendation: yes — score the store, list the manager(s) beside it.** It measures the thing
   that matters (do problems at this branch get fixed?) and cannot be gamed by clicking.
2. **Should acknowledgement ever be scored, even negatively?** Right now it is reported only.
   **Recommendation: not in this task.** A negative weight for accepting risk punishes the honest
   acknowledgement T-135 wants people to make. Revisit once there is real data — today there is none.
3. **Does the view log get scored later?** The phase plan drops the coverage component because there
   is no briefing; `/findings` views are a plausible substitute. **Recommendation: build the log, do
   not score it yet.** Let it accumulate data first, then decide with numbers instead of a guess.

## 10. Out of scope — with reasons

- **Backfilling occurrence history** — impossible, the data never existed (§5.4).
- **The AI briefing and its open-coverage component** — no briefing exists in Phase 6 (§4.5).
- **Notifying anyone.** A scorecard nobody is told about is a weaker control, but delivery is its own
  problem and T-135 put it out of scope for the same reason.
- **Per-person attribution of fixes.** See §3.2 — not deferred for effort, absent by construction.

## Done when

typecheck clean · every test watched fail first, then green · `npm run test:integration` green on an
isolated lane DB · `npm run build` exit 0 with the dev server stopped · **the daily job run once by
hand against `shareat_dev`, and a second time to prove idempotence** · smoketested on 9008: the
scorecard renders, states its start-of-record date, and a store with no data reads *null*, not 0 ·
`docs/ops/README.md` carries the new job row **and** its `systemctl enable --now` line · the RLS
registry and cutover classification updated (the build enforces both) · self-reviewed line by line ·
committed with a message explaining *why* · `FOR IAN` block naming the three open questions.
