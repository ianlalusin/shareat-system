# T-140 — The month-end scheduler: the thing v1's stopped scheduler proves matters

> **Status:** ✅ **BUILT, 2026-08-27.** Written before implementation (bible §1.2a).
> **Closes:** T-124 §12.1, T-125's half of the same question, and the live half of **DEF-044**.
> **Depends on:** `runDepreciation` (T-124), `amortisePrepaidItem` (T-125), the `system` principal
> (T-120 / ADR-008 §9).

## 1. What is missing, exactly

Both runners exist, are idempotent per `(item, period)`, and are safe to re-run. **Nothing calls
either of them without a human pressing a button.**

> ⭐ **We have reproduced v1's exact shape.** v1's seed data claims depreciation is *"auto-generated
> by the depreciation cron"* and **no such cron has ever existed** — nothing anywhere calls
> `processMonthlyDepreciationAction` but two UI buttons. It stopped for two months, ₱35,483.98 a
> month went unbooked, and it was found by an **audit**, not by anybody noticing.

## 2. ⭐ The design decision: the scheduler is NOT a person

`run_depreciation` and `run_amortisation` are admin-only, and `authorize()` takes a real `Actor`
with an active role. A scheduler has no session. T-124 §12.1 names this as *"the design decision,
not the cron syntax."*

**The answer is that the scheduler acts as a `system` principal and never manufactures a person.**

Three reasons, and the first is the one that matters:

1. ⛔ **A service person holding an admin role is a standing credential that can do everything an
   admin can do** — approve expenses, void sales days, change the chart of accounts — forever,
   which nobody logs into and nobody watches. The narrower control is not a role grant; it is that
   **the scheduler's entry point can call exactly two functions**. A capability check would make it
   *look* governed while actually widening what a compromised scheduler could reach.
2. `authorize()` answers *"may this **person** do this?"*. A scheduler is not a person, and
   inventing one to satisfy a question that does not apply is how a fiction becomes load-bearing.
3. `journal_entries.posted_by` is **nullable**, so the ledger can record *"posted by no person"*
   honestly rather than attributing a machine's work to a human who was asleep.

The `system` principal already exists for precisely this — ADR-008 documents it as *"Migrations,
crons, the ETL and the audit"* — and carries its own standing rule: ⛔ **it must never be reachable
from a request handler.**

### What that costs, and how it is paid

One implementation must not become two (v1's amortisation runners drifted for exactly this
reason). So the gate moves to the **boundary**, not the body: the human entry point authorises and
then calls the same posting code the system entry point calls. Nothing is copied.

## 3. ⭐ A failure is NOT derivable, and that is the whole problem

Everywhere else in this project a figure is derived and never stored. **This is the deliberate
exception, and it is worth stating so it does not read as a lapse:**

| | Derivable from the ledger? |
|---|---|
| A month that POSTED | ✅ Yes — the entry is right there |
| A month that FAILED | ⛔ **No. A failure leaves no trace by construction** |
| A run that never happened at all | ⛔ **No, and this is DEF-044 exactly** |

A scheduled run that fails quietly is **worse than the button**, because nobody is even expecting
to press anything. So the run's outcome is recorded in `scheduler_runs`: what job, what org, what
period, how many posted, skipped and failed, and **the reason for every failure**.

⚠️ The most likely failure is mundane and will happen: *"no fiscal period covers 2026-06-30."*
That must arrive as a visible line item, not an exception in a log nobody reads.

## 4. What triggers it

A **CLI command** — `npm run month-end` — invoked by the host's cron or a systemd timer.

Deliberately not an HTTP route with a shared secret: POS already carries that landmine (its
`gcloud` job output *echoes* `CRON_SECRET` into the console), and an HTTP trigger adds an
authenticated public surface to protect for no gain. Deliberately not in-process `node-cron`
either: it dies with the process and fires N times on N instances.

## 5. Rules

1. Runs **per org**, every org, one at a time. One org failing must not stop the next.
2. `tx = null` for the posting loops, so **each item gets its own transaction** — one bad asset
   cannot roll back the ones that succeeded. T-124 §12's reasoning applies unchanged: the register
   is derived, so a partial run is incomplete, never inconsistent.
3. Defaults to **last completed month**. Running it twice is safe and is how you catch up.
4. Records exactly one `scheduler_runs` row per (job, org, run) — including a run that posted
   nothing, because *"it ran and there was nothing to do"* and *"it never ran"* must be
   distinguishable. **That distinction is the entire point.**
5. Exit code is non-zero when any org failed, so the host's cron mailer notices.

## 6. Done when

- [x] `scheduler_runs` in the schema, classified in `cutover/classification.ts` **and**
      `rls/registry.ts`, with RLS policies in the migration.
- [x] System entry points for both runners, sharing the human path's posting code.
- [x] `npm run month-end`, runnable and idempotent — **run twice against dev**: 2 postings the
      first time, 0 the second, and the ledger holds exactly 2 entries.
- [x] The last run and its failures surfaced on `/fixed-assets` and `/prepaid` — verified
      reading *"Amortisation last ran 2026-08-27 for 2026-08 · 0 posted, 1 already done, no
      failures · cron"*.
- [x] Integration tests: idempotency across two runs, a recorded failure, per-org isolation, and
      a test that a no-op run still records a row. 7 tests.
- [x] Gates: typecheck · unit 545 · integration 851.
