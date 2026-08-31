# T-199 — The missed clock-out sweep, and the alarm that notices it stopped

> **Status:** specced 2026-08-31 · closes **DEF-119**, and the sweep half of **DEF-116**
> Ian, 2026-08-31: *"1. lets do it"* — the sweep **and** the staleness alarm
> **Depends on:** T-140 (the scheduler pattern, `system` principal, `scheduler_runs`), T-157
> (`computeDay`), T-195 (`/attendance` — where a swept day lands)
> **Reference read at source:** `ERP-rebuild/src/lib/attendance/auto-clock-out.ts` (185 lines,
> pure), `src/lib/actions/attendance-sweep.actions.ts`

---

## 1. ⭐ There is no architecture question here — T-140 already answered it

T-140 §4 decided how anything scheduled runs in v2, and the reasoning holds unchanged:

> A **CLI command** — `npm run month-end` — invoked by the host's cron or a systemd timer.
> Deliberately **not** an HTTP route with a shared secret: POS already carries that landmine (its
> `gcloud` job output *echoes* `CRON_SECRET` into the console), and an HTTP trigger adds an
> authenticated public surface to protect for no gain. Deliberately **not** in-process `node-cron`
> either: it dies with the process and fires N times on N instances.

So this task **reuses**, and adds nothing architectural: `npm run attendance-sweep`, the `system`
principal, one `scheduler_runs` row per (job, org, run) including no-ops, per-org isolation, and a
non-zero exit code so the host's mailer notices.

⚠️ **One difference from month-end, and it drives the schedule:** the cutoff is a *wall-clock hour
per store* (v1: all three stores on **02:00**). So the timer fires **hourly** and each store decides
whether its hour has passed. A daily timer could not serve two stores on different hours.

### 1.1 ⛔ The scheduler is not the reliability problem — §4 is

Three times, in three systems, the **code was fine and the schedule was never turned on**:

| | |
|---|---|
| v1 depreciation | Seed data claims a cron. **None ever existed.** Two months, ₱35,483.98/month unbooked, found by an audit |
| POS holiday calendar | Route shipped, **never scheduled**. No store ever had one |
| POS weather | Two `gcloud` regions, job name ≠ route name, output echoes the secret |

**A better scheduler does not fix this.** §4's detector does.

---

## 2. What the sweep does — and the rule that matters most

v1 states it, and it is the one thing to copy verbatim:

> **The staffer is clocked out, but the time is not captured.** Nobody observed them leaving, so no
> `rawClockOut` is written and the session is closed as `missing_out` — after which
> `halfDayOnMissingTap` decides what it pays. **Inventing a clock-out time would put a number
> nobody witnessed into the audit record.**

⭐ **v2 needs to do LESS work than v1 to honour this**, because the shapes differ. v1 closes a
*session* and must decide what to write into it. v2 has punches and a derived day: an `in` with no
`out` is **already** `missing_out`, and `resolveStatus` already calls it `open`. So the sweep
**writes no punch at all.** It settles the *status*: this day is finished, and it will never get an
out.

| | Before the sweep | After |
|---|---|---|
| Status | `open` — *"a shift still running"* | `needs_review` — *"a day nobody settled"* |
| Punches | untouched | ⛔ **untouched** — no fabricated out |
| Where it surfaces | nowhere | T-195's `/attendance` queue |
| What it pays | nothing, for ever | whatever `halfDayOnMissingTap` decides (§3) |

⚠️ `resolveStatus` already refuses to promote a `needs_review` day on recompute, and T-195 gave a
manager the only way to settle one. Those two facts are what make `needs_review` the right
destination rather than a new status.

### 2.1 Two rules, one record

| Rule | Meaning |
|---|---|
| `autoClockOutHour` | A wall-clock hour at which every still-open day is cleared, *"so the floor is empty before the store opens"*. Live at all three v1 stores: **02:00**. `null` = this store never auto-clears — the state every store is in today |
| `maxShiftHours` | The per-day backstop: open longer than the cap (**16h**) was clearly forgotten. Fires regardless of the hour |

⛔ **Both produce the identical record.** v1 says so and the reason is auditability: a day settled
by the sweep must not be distinguishable-by-accident depending on which rule caught it.

### 2.2 ⛔ `MIN_OPEN_MINUTES = 60` — copy the guard and its reason

v1's comment earns its place:

> Without this, a store whose cutoff hour sits near a real shift start would kill a shift that had
> just begun — and with `halfDayOnMissingTap` on, **pay it half a day for five minutes of work.**

⚠️ Note the shape: it is DEF-088 and DEF-111's family again — a rule that turns *a few minutes
present* into *money*. Anything the guard skips is caught by the next hour's sweep or by the
`maxShiftHours` backstop, so the guard costs nothing.

---

## 3. ⛔ DEF-119 — the dead column this task must wake up

`half_day_on_missing_tap` exists in the schema and **`grep -rn halfDayOnMissingTap
packages/domain/src/` returns nothing.** No reader, anywhere.

All three v1 stores have it **ON**. So today:

| | v1 | v2 |
|---|---|---|
| Staffer forgets to tap out | Half a day | ⛔ **₱0, for ever** |

⭐ **This one costs staff money**, which is the opposite direction to DEF-111 and arguably worse —
an underpayment nobody will report, because nobody can see it. `computeDay` must read the flag:
when the day's only anomaly is `missing_out` and the store has the rule on, credit
`halfDayMinutes` and set `isHalfDay`.

⚠️ **And it must NOT invent an end time to get there.** The half day is a credit, not a
reconstructed shift — the same distinction `unitsFor` now makes (T-194): a half day pays half the
daily rate, never the hours covered.

---

## 4. ⭐ The alarm — the half Ian actually asked for

> Ian: *"what is the best way to get the attendance sweep reliably running cheaply?"*

⛔ **A check that asks "did the cron run?" needs something else scheduled to ask it.** Turtles.

⭐ **So detect the missing OUTCOME, not the missing run.** *"Three shifts from two days ago are
still open"* is sitting in the data, is derived on read, and is true whether or not anything is
scheduled — including when the sweep itself is dead. `listFindings` already runs twelve detectors
on page load and `periodicPostingsMissed` is exactly this pattern for depreciation.

**One new detector: `openShiftsStale`.** An `open` day whose shift day is older than a small
threshold (2 days — past any night shift and any plausible offline replay).

| Severity | When |
|---|---|
| `soft` | Normally — a manager sees it and acts |
| `hard` | ⚠️ **When it would block a period close.** An open day is unpayable and unpaid; closing a period over it books a month that owes somebody wages |

⚠️ **This is the cheapest reliability in the whole task and it is worth naming as such**: it costs
one query, needs no infrastructure, and it is the control that would have caught all three
historical failures above.

---

## 5. Files

| File | Change |
|---|---|
| `packages/db/schema/attendance-config.ts` | ⭐ **New:** `autoClockOutHour` (`integer`, **nullable**, 0–23) and `maxShiftHours` (`integer not null default 16`) |
| `packages/db/migrations/0114_t199_attendance_sweep.sql` | ⛔ **0113 is taken by T-196** — take **0114**, `when` strictly greater. DEF-039/DEF-091 |
| `packages/domain/src/attendance/compute-day.ts` | ⛔ DEF-119 — read `halfDayOnMissingTap` (§3) |
| `packages/domain/src/attendance/sweep.ts` | **New.** Pure decision (`isDueForSweep`, cutoff arithmetic) + the transactional shell |
| `packages/domain/src/scheduler/` | The `attendance_sweep` job, beside month-end's, sharing `scheduler_runs` |
| `scripts/attendance-sweep.ts` · `package.json` | `npm run attendance-sweep` |
| `packages/db/src/repo/findings.ts` · `packages/domain/src/findings/index.ts` | `openShiftsStale`, added **alongside** the twelve — ⚠️ do not restructure that module, another session has a live finding against it (DEF-117) |
| `docs/ops/` | ⭐ **The systemd timer unit, committed.** §7 |

⚠️ **`autoClockOutHour` is nullable and defaults to null** — "this store never auto-clears" is the
state every store is in today, and DEF-087's lesson is that an unset value must not masquerade as a
chosen one. ⛔ v1's guard against `Number('') === 0` (midnight — *"the one hour where a floor is
most likely to still have people on it"*) becomes a CHECK constraint here, not a runtime coercion.

---

## 6. Tests

**Pure:** the cutoff arithmetic across midnight; a store with `null` never sweeps; the
`MIN_OPEN_MINUTES` guard; `maxShiftHours` fires independently of the hour.

**Integration:**
1. An open day older than the cutoff becomes `needs_review`; **its punches are unchanged and no
   `out` punch exists** — the invariant §2 exists for.
2. ⭐ A day open for **20 minutes** is left alone (the guard), and is swept on the next run.
3. `maxShiftHours` closes a 17-hour day at a store with `autoClockOutHour = null`.
4. ⛔ **DEF-119:** with `halfDayOnMissingTap` on, the swept day credits a half day; with it off, zero.
5. ⭐ A swept day appears in T-195's `/attendance` queue and can be verified there — end to end.
6. A no-op run **still records a `scheduler_runs` row.** *"It ran and there was nothing to do"* and
   *"it never ran"* must be distinguishable; T-140 calls that distinction the entire point.
7. One org failing does not stop the next.
8. ⭐ `openShiftsStale` fires for a 3-day-old open day and not for today's.
9. Running the sweep twice changes nothing the second time.

---

## 7. ⛔ Done when — and the step that has failed three times

- [ ] Gates: typecheck · unit · integration · build.
- [ ] Smoketested on 9008: a swept day is visible in `/attendance` and settleable.
- [ ] `npm run attendance-sweep` run **twice** against dev — second run posts nothing and still
      records a row.
- [ ] ⛔ **The systemd timer unit is COMMITTED to `docs/ops/`, with install instructions**, and the
      handoff says in plain words that *installing it on the droplet is a step nobody has done yet.*
      **This is the step that failed for v1's depreciation, POS's holiday calendar and POS's
      weather job.** A task that ships the code and calls itself done repeats it a fourth time.
- [ ] The `openShiftsStale` detector is live on `/findings`, verified by eye.
- [ ] **DEF-119 marked fixed**; DEF-116's sweep half marked closed.
- [ ] `docs/ROADMAP.html` updated.
