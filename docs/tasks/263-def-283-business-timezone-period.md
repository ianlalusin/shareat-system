# T-263 — DEF-283: `lastCompletedPeriod()` decides the month in UTC, and the bible forbids exactly that

> **Status: RESERVED by the orchestrator, 2026-09-10.** Number reserved so no peer takes it.
> Nothing built. ⚠️ **This is a SMALL change with a WIDE blast radius** — one function, two live
> scheduler jobs, and a set of existing tests that currently encode the defect as correct. Read
> "The tests are the hard part" before touching the function.

## Goal, in one sentence

Make `lastCompletedPeriod()` (`packages/domain/src/scheduler/index.ts:196`) derive the period from
the **business timezone** instead of raw UTC, so that a job firing at 02:00 Asia/Manila on the 1st
closes the month that just ended rather than the one before it.

## Why this is not a style preference

`packages/core/src/datetime.ts` is the project's single sanctioned date module, and its own header
says why:

> §12 landmine 7: server runtimes are UTC, so a bare `toLocaleTimeString` silently shifts
> Philippine times by 8 hours. **This module is the only sanctioned way to format or bucket a
> business date on the server.**
>
> §12 landmine 26: v1 had FOUR coexisting date idioms, one with no timezone pinning at all.
> **There is exactly one here. Do not add a second.**

⛔ **`lastCompletedPeriod()` is the second one.** It calls `getUTCFullYear()` / `getUTCMonth()`
directly and never touches `BUSINESS_TIMEZONE` or `toBusinessDate()`. It is not a helper that
happens to use UTC — it is an unpinned date idiom in the function that decides which month gets
closed.

## What it costs today — measured, not argued

`runDepreciation` posts dated at `endOfPeriod(period)`, so the *entries* are always dated correctly.
The defect is **which period is chosen**:

| When the job fires | UTC instant | period chosen | correct? |
|---|---|---|---|
| 02:00 UTC on the 1st (pre-DEF-241) | `2027-03-01T02:00Z` | `2027-02` | ✅ |
| **03:00 Asia/Manila on the 1st (committed by DEF-241)** | `2027-02-28T19:00Z` | **`2027-01`** | ⛔ |
| 02:00 Asia/Manila on the 15th (current) | `2027-03-14T18:00Z` | `2027-02` | ✅ |

⛔ **The middle row is the defect and it is silent.** January is already closed, the job is
idempotent, so it no-ops — and **February is never closed by cron at all.** No error, no alert.
That is DEF-044's shape: the exact failure this job exists to prevent.

⭐ **It has never bitten because `docs/ops` does not deploy (DEF-194) and the corrected unit was
never installed.** The bug is live in git and dead on the droplet.

## The second victim, which is easy to miss

**`runFindingObservation` uses the same function** (`packages/domain/src/findings/index.ts:276`)
and its timer fires at **01:30 Asia/Manila** — which is *always* the previous day in UTC. Most days
the month is the same and nothing is wrong. **On the 1st of every month it asks about the wrong
period**, quietly, and has been doing so since it shipped.

⚠️ Fixing the function fixes both. **Check the findings behaviour deliberately rather than assuming
it is a free win** — that function unions `lastCompletedPeriod()` with earlier still-open periods,
so the blast radius there is different from month-end's.

## The tests are the hard part — read this before editing them

`packages/domain/tests/integration/scheduler.test.ts` asserts the **current, wrong** behaviour:

```ts
expect(lastCompletedPeriod(new Date('2026-08-01T02:00:00Z'))).toBe('2026-07');   // stays correct
expect(lastCompletedPeriod(new Date('2026-08-31T23:59:00Z'))).toBe('2026-07');   // ⛔ becomes wrong
expect(lastCompletedPeriod(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12');   // stays correct
```

⛔ **The middle line is the defect written down as an expectation.** `2026-08-31T23:59Z` is
**2026-09-01 07:59 in Manila** — the business month is September, so the last completed period is
**August**, not July. After the fix that line must read `'2026-08'`.

⚠️ **Do NOT simply flip the expectations until they pass.** For each assertion, state in a comment
what the instant is *in Manila* and why the expected period follows. A test changed to match new
behaviour without that reasoning is indistinguishable from a test loosened to make a red go away —
and this project has been bitten by exactly that (a baseline tuned toward a number rather than
measured). **Watch the changed assertions fail against the old function first, for the right
reason.**

Also check: `packages/domain/tests/integration/finding-occurrences.test.ts:206` has a comment
asserting *"On 1 October, `lastCompletedPeriod()` is September"* — verify that still holds under
the fix and correct it if not.

## ⛔ SPEC AMENDMENT, orchestrator, 2026-09-10 (night) — THERE IS A SECOND COPY OF THIS FUNCTION

**The spec above says "two live callers". Re-derived at dispatch, that undercounts, and the missing
item is not another caller — it is a SECOND INDEPENDENT IMPLEMENTATION of the same function, with
the same name, computing the same concept, in the app layer.**

`apps/erp/src/app/findings/lib.ts:22` defines its own `lastCompletedPeriod(now)` with its own body
(`Date.UTC(...)` + `setUTCMonth(-1)`), and `:29` defines `selectablePeriods(now)` on the same raw-UTC
idiom. It is not a re-export. Its live callers:

| Consumer | Uses |
|---|---|
| `apps/erp/src/app/findings/page.tsx:32` | app copy — the month the findings page opens on |
| `apps/erp/src/app/page.tsx:50` | app copy — the dashboard's findings tile |

So the full population, re-derived rather than reasoned:

| Implementation | Live callers |
|---|---|
| `packages/domain/src/scheduler/index.ts:196` | `runMonthEnd` (`scheduler/index.ts:222`), `runFindingObservation` (`findings/index.ts:276`), **and `scripts/month-end.ts:32`** — the CLI the systemd unit actually invokes, which computes the period itself rather than letting `runMonthEnd` default |
| `apps/erp/src/app/findings/lib.ts:22` | `findings/page.tsx:32`, `page.tsx:50` |

### Why this changes the scope rather than being logged and left

⛔ **Fixing only the domain copy ships a screen that disagrees with the job.** Both copies return
identical values today (verified across eight instants), so the two are consistent-and-wrong. Fix one
and, for the 00:00–08:00 Manila window on the 1st of each month, **the job records August while the
findings page and the dashboard show July.** That window is not rare — it is every month, and it is
exactly when someone looks to see whether month-end ran.

⛔ **And the app copy is independently defective right now.** It has the same defect for the same
eight hours a month, on screen, for every user — before any change to the domain function.

### The trap inside the widened scope — measured, so the lane does not have to find it the hard way

`selectablePeriods` must move **in the same change** as the app's `lastCompletedPeriod`. The page does
`sp.period && periods.includes(sp.period) ? sp.period : lastCompletedPeriod()`. Fix the default without
fixing the list and, at `2026-08-31T23:59Z`, the default becomes `2026-08` while the list still offers
`2026-07` downward — **the page opens on a month it rejects**, which is the precise thing
`findings-page-lib.test.ts:36` exists to prevent. ⚠️ **That test will not catch it**: its instant is
20:00 Manila, where both idioms agree.

### Two of the spec's own open questions, answered by measurement — do not re-litigate them

1. ⭐ **`finding-occurrences.test.ts:206` needs NO change.** Its `NOW` is `2026-10-05T00:00:00Z` =
   **2026-10-05 08:00 Manila**, same month either way, so `lastCompletedPeriod()` is `2026-09` before
   and after. The comment's claim *"On 1 October, `lastCompletedPeriod()` is September"* still holds.
   Verify it yourself; do not take this on trust — but it is not expected to move.
2. ⭐ **All three instants in `apps/erp/tests/findings-page-lib.test.ts` are unchanged by the fix**
   (`2026-08-30T12:00Z` → 20:00 Manila, `2026-08-01T00:00:01Z` → 08:00 Manila, `2027-01-15T00:00Z` →
   08:00 Manila). ⛔ **Which means the existing app tests cannot detect this defect at all.** Fixing the
   app copy therefore costs zero test churn — and a green suite there proves nothing until you **add a
   boundary case inside the 00:00–08:00 Manila window on the 1st**.

⚠️ A useful extra case the spec does not list: `2026-12-31T17:00:00Z` = **2027-01-01 01:00 Manila**.
The current function returns `2026-11`; a Manila-derived version returns `2026-12`.

⛔ **CORRECTION, orchestrator, made after lane B's test comment stated it more precisely than this
section originally did.** This paragraph first read *"wrong by TWO months, not one, because it crosses
the year as well"*. **That was wrong and it was mine.** The returned answer `2026-11` is **one** month
off the correct answer `2026-12` — exactly the same magnitude as the other boundary case, not double it.
What is actually distinctive about this instant is different and still worth a test: the old function
**never saw the year turn at all.** It read the current business month as `2026-12` when the true one
was `2027-01`, so it was two months behind the *current month* while being one month off the *answer*.
⭐ The lane was briefed with my wrong version, did not adopt it, and wrote the accurate account into the
committed test comment instead — which is the second time this week a lane corrected the orchestrator's
arithmetic rather than deferring to it.

### Amended scope — this replaces the Scope list below

- `packages/domain/src/scheduler/index.ts` — the function only.
- `packages/domain/tests/integration/scheduler.test.ts` — the assertions above.
- `packages/domain/tests/integration/finding-occurrences.test.ts` — only if the fix changes it (it is
  not expected to; say so either way).
- **`apps/erp/src/app/findings/lib.ts`** — `lastCompletedPeriod` and `selectablePeriods`, together.
  ⭐ **Prefer deleting the duplicate over fixing it twice**: re-export the domain function (`@shareat/domain`
  is already a dependency of the app, and this direction is the sanctioned one — RULES rule 13) and derive
  `selectablePeriods` from it. Two copies of one rule is what produced this defect.
- **`apps/erp/tests/findings-page-lib.test.ts`** — add the boundary case; keep the three existing
  instants, which should stay green untouched.
- A unit test is welcome if you can express the boundary cases without a database.

⚠️ **Still out of scope, unchanged:** moving the timer, `fiscal_periods`/T-264, and any other date idiom
— log a third one, do not fix it here.

## Scope

- `packages/domain/src/scheduler/index.ts` — the function only.
- `packages/domain/tests/integration/scheduler.test.ts` — the assertions above.
- `packages/domain/tests/integration/finding-occurrences.test.ts` — only if the fix changes it.
- A unit test is welcome if you can express the boundary cases without a database.

## Out of scope

- ⛔ **Moving the month-end timer.** `docs/ops/shareat-month-end.timer` currently runs on the 15th,
  which is immune to this defect by distance. Moving it back toward the 1st is a **separate ops
  change that happens AFTER this ships** — and it is Ian's, since he chose the 15th for a business
  reason (channel remittances land up to the second week).
- ⛔ **The fiscal-period lock (DEF-284 / T-264).** Different problem entirely: nothing can create or
  close a period. Do not touch `fiscal_periods`.
- Any other use of dates anywhere. ⚠️ **If you find a third unpinned date idiom while you are in
  there, LOG IT (RULES §13 row 164) and do not fix it here.**

## Done when

- `lastCompletedPeriod()` derives the month via `packages/core/src/datetime.ts`, not raw UTC.
- Every changed test assertion carries a comment stating the instant **in Manila** and why the
  expected period follows, and was watched failing against the old function first.
- `runFindingObservation`'s behaviour at a month boundary is stated explicitly — changed or
  unchanged, with the reasoning.
- typecheck clean · unit green · integration green against real Postgres · self-reviewed line by
  line · report ends with a `FOR IAN` block.
- ⚠️ The report says plainly whether the month-end timer is now safe to move back to the 1st.

See `docs/DEFECTS-REGISTER.md` DEF-283, DEF-241, DEF-194, DEF-044; `PROJECT_BIBLE.md` §12 landmines
7 and 26; `packages/core/src/datetime.ts`; `docs/ops/shareat-month-end.timer`'s header.
