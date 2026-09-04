# T-204 — Wire the Firestore sync relay to actually run, and bootstrap a fresh attendance day: closes DEF-132 and DEF-134

> **Status:** ✅ **Built, 2026-09-04.** Closes DEF-132 and DEF-134 — see their rows in
> `docs/DEFECTS-REGISTER.md` for the full account, including DEF-151, a real
> `packages/sync-firestore` bug found and fixed along the way (an empty-but-set
> `FIREBASE_SERVICE_ACCOUNT_KEY` defeated `??` and failed every real driver call). All gates green
> (typecheck · unit 942/943 · integration 79 files/2117 tests on `shareat_test_204` · `npm run
> build` exit 0) and the CLI verified by hand against real `shareat-hub-v2` Firestore. **Not
> installed anywhere** — this task ships `docs/ops/shareat-firestore-relay.{service,timer}`
> (2-minute cadence), matching the attendance sweep's own still-pending state; installing either is
> a separate, later step. **Not committed — Ian's call.**
> **Depends on:** T-181 (`drainOutbox`, `packages/domain/src/sync/publisher.ts`), T-182
> (`ingestEvents`, `packages/domain/src/sync/ingestor.ts`), T-157 (`adjudicateDay`,
> `packages/domain/src/attendance/adjudicate.ts`), T-159/T-181 (`createFirestoreMirrorDriver`,
> `packages/sync-firestore`), T-140 (the scheduler pattern this follows —
> `packages/domain/src/scheduler/index.ts`, `scripts/attendance-sweep.ts`,
> `docs/ops/shareat-attendance-sweep.{service,timer}`).
> **Blocks:** the entire offline clock-terminal story (T-159/180-185/200) in any real deployment —
> without this, punches written to Firestore never reach Postgres.

## Why this exists — two related gaps, one fix touches both

**DEF-132.** `createFirestoreMirrorDriver` and `createFirestoreTerminalDriver`
(`packages/sync-firestore`) are imported nowhere outside their own package. `drainOutbox` and
`ingestEvents` are architecturally sound and fully tested (fake driver + emulator) but nothing —
no cron script, no API route, no instrumentation hook — ever calls either against **real**
Firestore. `docs/ops/README.md`'s own job table lists only month-end and the attendance sweep;
the sync relay isn't even named as owed.

**DEF-134.** T-157's own spec text asserts *"the ingestor, the manager screen, the payroll preview,
the roster — call `adjudicateDay` and nothing else recomputes."* None of the three do.
`upsertDay` (the function that creates the FIRST `attendance_days` row for a day) is only reachable
through `adjudicateDay`, whose only real caller is `recordAdjustment` — itself reachable only via a
UI route that requires a **pre-existing** `dayId`. A day nobody has touched before is never
computed.

**Why one task:** the ingestor is exactly where a punch first lands, so it is also exactly where a
fresh day should first get computed — DEF-134's fix is a few lines inside the function DEF-132's
fix is wiring up to actually run. Building the CLI job without the adjudicate call would ship a
relay that files punches nobody's roster or payroll screen would ever show correctly until a
manager happened to open that day.

## Goal

A scheduled job, runnable both by a host timer and by hand, that: publishes Postgres's outbox to
the Firestore mirror (Lane A) and ingests Firestore's inbox into Postgres, adjudicating each day a
new punch lands in as it goes (Lane B) — for every org, recording itself in `scheduler_runs` exactly
as month-end and the attendance sweep already do, so "it ran and did nothing" and "it never ran" are
still tellable apart.

## Scope — files this task may create or modify

**New:**
- `packages/sync-firestore/src/index.ts` — **modify**, add `createFirestoreInboxDriver()` (Contract
  §1). (Listed separately from "modify" below because it's the one change to an otherwise
  hands-off file — the existing two factories are correct and untouched.)
- `packages/domain/src/scheduler/index.ts` — **modify**, add `runFirestoreRelay` alongside
  `runMonthEnd`/`runAttendanceSweep` (Contract §3)
- `packages/domain/src/sync/ingestor.ts` — **modify**, `ingestOne` calls `adjudicateDay` after a
  genuinely new `recordPunch` (Contract §2)
- `packages/db/schema/scheduler.ts` — **modify**, extend `SCHEDULER_JOBS`
- `packages/db/migrations/01NN_t204_scheduler_relay_jobs.sql` (next free number — check
  `packages/db/migrations/` before numbering; **0124** as of this spec's writing) — hand-written,
  widening `scheduler_runs_job_check`, journalled per DEF-069 (`previous.when + 86400000`, never
  `Date.now()`)
- `scripts/firestore-relay.ts` — the CLI entry point, matching `scripts/attendance-sweep.ts`'s shape
- `docs/ops/shareat-firestore-relay.service` / `.timer` — matching the attendance-sweep unit pair
- `docs/ops/README.md` — **modify**, add the job to the table (§4)

**Do not touch:** `packages/domain/src/sync/publisher.ts` (`drainOutbox` is correct and complete —
this task calls it, doesn't change it), `packages/domain/src/attendance/adjudicate.ts`
(`adjudicateDay` is correct and complete — same), `firebase/firestore.rules` (no rule change is
needed; the Admin SDK bypasses rules entirely, which is what makes an unconstrained inbox read safe
here even though a client `list` is refused — T-159's own rules already say so), any migration
before the one this task adds.

## Contract

### 1. `packages/sync-firestore` — the inbox driver, T-182's own missing half

T-182's Contract §2 already named this and never built it: *"`packages/sync-firestore` — reads
`/inbox`, stamps `processedAt`, deletes nothing."*

```ts
// packages/domain/src/sync/ingestor.ts (or a new small file in the same directory if that reads
// cleaner — implementer's call, but keep the interface in packages/domain per the established
// rule: domain owns the shape, packages/sync-firestore owns the SDK)
export interface InboxDriver {
  /** Unprocessed /inbox docs, capped at `limit`. No ordering guarantee. */
  readUnprocessed(input: { limit: number }): Promise<{ docId: string; data: unknown }[]>;
  /** Stamp processedAt (+ the punch id, when there is one) on one document. Never deletes. */
  markProcessed(input: { docId: string; punchId: string | null }): Promise<void>;
}
```

```ts
// packages/sync-firestore/src/index.ts — new export, same file, same `db()` helper already there
export function createFirestoreInboxDriver(): InboxDriver {
  return {
    async readUnprocessed({ limit }) {
      const snap = await db().collection('inbox').where('processedAt', '==', null).limit(limit).get();
      return snap.docs.map((d) => ({ docId: d.id, data: d.data() }));
    },
    async markProcessed({ docId, punchId }) {
      await db().collection('inbox').doc(docId).update({
        processedAt: FieldValue.serverTimestamp(),
        ...(punchId ? { punchId } : {}),
      });
    },
  };
}
```

⚠️ **Deliberately no `orderBy` and no composite index.** `where('processedAt','==',null)` alone
needs no `firestore.indexes.json` entry — Firestore auto-indexes single-field equality. Adding an
`orderBy(occurredAt)` would need a composite index, which needs a real deploy
(`firebase deploy --only firestore:indexes`) against the shared `shareat-hub-v2` project, and this
project has already recorded a live incident of a blind index deploy deleting ~44 unrelated indexes
(`reference_pos_firestore_indexes_drift`). Not worth it for a job that reprocesses whatever's left
every run regardless of order. If ordering turns out to matter later, that's a deliberate follow-up
with its own deploy step, not a default here.

⚠️ **A quarantined event is still "processed"** for this driver's purposes — `markProcessed` with
`punchId: null` on anything `ingestEvents` decided *not* to turn into a punch (malformed, unknown
device, etc.), same as a successfully-ingested one. T-182 invariant 6 (*"nothing is ever deleted
from the inbox; `processedAt` is stamped instead"*) already establishes that a quarantined event
keeps its document — this driver just needs to stop re-reading it every run. The **quarantine
table itself**, not the Firestore flag, is what T-183's screen reads to let a manager act on it —
this task does not change that.

### 2. `ingestor.ts` — `ingestOne` calls `adjudicateDay`, closing DEF-134's own gap

Immediately after the existing `recordPunch` call (`ingestor.ts:288-296`), before `return`:

```ts
if (!alreadyProcessed) {
  // ⭐ DEF-134: this is the ONLY place in the running system that computes an attendance_days row
  // for a day nobody has touched before — the ingestor is where a punch first lands, so it is
  // also where the day it belongs to should first get computed. A REPLAY does not re-adjudicate:
  // the day was already computed when the punch first arrived, and adjudicateDay refuses to
  // recompute a FROZEN day (a day already locked into a pay run) — a redelivered old punch must
  // never throw on a day payroll has already closed.
  try {
    // ⭐ ANOTHER SAVEPOINT — same reasoning as the outer loop's own comment above: adjudicateDay
    // touches the database, and a thrown error already aborts the enclosing transaction on
    // Postgres. Without this nested savepoint, a frozen-day refusal here would abort the SAME
    // transaction recordPunch just committed within, discarding the punch that was correctly
    // recorded a moment ago. The punch write must survive even when the recompute doesn't.
    await tx.transaction((inner) => adjudicateDay(inner as Tx, {
      employmentId: employment.id,
      shiftDay,
    }));
    report.adjudicated++;
  } catch (error) {
    // Not fatal to the punch — it is already safely recorded. Counted, not thrown, not silently
    // dropped either.
    report.adjudicationFailed++;
    report.adjudicationFailures.push({ clientPunchId, detail: String(error).slice(0, 300) });
  }
}
```

`IngestReport` gains three fields: `adjudicated: number`, `adjudicationFailed: number`,
`adjudicationFailures: { clientPunchId: string; detail: string }[]`. Update every existing test
that asserts the report shape (T-182's invariant 10 — *"the report's numbers add up to `seen`"* —
still holds for the existing fields; the three new ones are additive, not a replacement for any of
them).

⚠️ **Report a spec defect if this turns out not to fit.** T-157's `adjudicateDay` signature is
`(tx, input)` with no `Actor` — confirmed by reading `adjudicate.ts:94` before writing this spec,
so no `authorize()` call stands in the way of a machine caller. If it has since grown one, or if
`shiftDay` (already computed a few lines above the `recordPunch` call, step 4 of the existing
function) has drifted out of scope by the time this is implemented, say so per bible §3.4a rather
than working around it.

### 3. `packages/domain/src/scheduler/index.ts` — the orchestration, same shape as month-end

```ts
export interface RelayResult { outcomes: JobOutcome[]; hadFailures: boolean; }

export async function runFirestoreRelay(
  drivers: { mirror: MirrorDriver; inbox: InboxDriver },
  options: { orgId?: string; trigger?: 'cron' | 'manual'; limit?: number } = {},
): Promise<RelayResult>
```

Two jobs per org, both added to `JobOutcome['job']` and `SCHEDULER_JOBS`: `'mirror_publish'` and
`'inbox_relay'`. `period` recorded the same way the attendance sweep already does — the `YYYY-MM`
this run happened in, since neither job has a period of its own.

**`mirror_publish`**, per org: `withOrgPrincipal(org.id, tx => drainOutbox(tx, drivers.mirror, {
limit }))`. `posted = report.published`, `skipped = report.skipped`, `failed = report.failed`
(`DrainReport`'s own shape — reuse it, don't reinvent).

**`inbox_relay`** is different in kind from every other job here: it is **not** naturally
per-org, because `/inbox` is one flat Firestore collection and an event carries a `storeId`, not
an `orgId`. Resolve org membership in Postgres, as a `system` connection (RLS bypassed, sees every
org — the same pattern `schedulerRepo.listOrgsToRun` already uses), **before** opening any
org-scoped transaction:

1. `drivers.inbox.readUnprocessed({ limit })` — once, not once per org.
2. `transaction(tx => storesRepo.orgIdsForStoreIds(tx, [...distinct storeIds in the batch]))` — a
   new small repo function (`packages/db/src/repo/stores.ts` likely already has a `stores` query to
   extend, or add one) returning `Map<storeId, orgId>`, read as `system` so it sees every org's
   stores in one query.
3. Group events by resolved `orgId`. **An event whose `storeId` matches no known store is left
   un-stamped and excluded from every group** — it will be re-read next run, and if it never
   resolves, that is itself worth surfacing later (a `staleUnresolvedInboxEvent`-shaped finding
   would be the natural home, following the `openShiftsStale` pattern in `docs/ops/README.md` —
   **not built by this task**, named here so it isn't lost).
4. Per resolved org: `withOrgPrincipal(orgId, tx => ingestEvents(tx, thatOrg'sEvents))`.
5. For every event `ingestEvents` actually decided (ingested, already-processed, OR quarantined —
   **not** the unresolved-org group from step 3), call `drivers.inbox.markProcessed`. An
   `internal_error` quarantine still counts as decided — T-182 invariant 6 already established that
   quarantining is not losing the event, and re-reading it forever would defeat the point of the
   `limit`.
6. `JobOutcome` for `inbox_relay`: `posted = ingested` (using `IngestReport.ingested`, matching how
   month-end already reports "created" rather than "considered" — DEF-044's own lesson, cited in
   this same file), `skipped = alreadyProcessed + refusedDiscarded`, `failed = quarantined` — and
   record `report.adjudicationFailed` somewhere visible in the outcome (extend `JobOutcome` or fold
   into `failures` — implementer's call, but it must not be silently dropped; bible §15.6,
   observability from day zero).

⚠️ **One org's `mirror_publish` or `inbox_relay` failing outright must not stop the next org's**,
matching every existing job in this file — wrap each org's work the same way
`runDepreciationJob`/`runSweepForOrg` already do (`try { ... } catch (err) { failRun(...) }`).

### 4. `scripts/firestore-relay.ts` — the CLI, matching `scripts/attendance-sweep.ts`

```ts
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runFirestoreRelay } from '@shareat/domain';
import { createFirestoreMirrorDriver, createFirestoreInboxDriver } from '@shareat/sync-firestore';

config({ path: '.env.local' });
// same arg()/main() shape as attendance-sweep.ts: --org=, --manual, non-zero exit on any failure.
// drivers = { mirror: createFirestoreMirrorDriver(), inbox: createFirestoreInboxDriver() }
```

`npm run firestore-relay` — add the script to the root `package.json` next to `attendance-sweep`.

**Cadence — pick one and say why, this is not dictated by any existing doc.** The attendance sweep
is hourly because its cutoff is wall-clock-per-store; this job has no such anchor — punches and
mirror updates are useful as soon as possible, but nothing breaks if a run is a few minutes late
(idempotent, and Firestore is durable storage in the meantime, not a queue that drops). Something
in the **1–5 minute range** via `OnCalendar` (e.g. `*:0/2` for every two minutes) is a defensible
default matching what a real clock terminal's UX needs (a punch should reach the roster within a
couple of minutes, not by the next hour). State the choice and the reasoning in the report — this
is Ian's to override, not a fixed requirement.

`docs/ops/shareat-firestore-relay.service` / `.timer`: copy the attendance-sweep pair's shape
exactly (`Type=oneshot`, `WorkingDirectory=/srv/shareat`, `ExecStart=/usr/bin/npm run
firestore-relay`, `User=shareat`, log to `/var/log/shareat/firestore-relay.log`, `Persistent=true`
on the timer).

### 5. `docs/ops/README.md`

Add a row to the jobs table for `firestore-relay`, and update the precondition section's framing if
it still reads as though only month-end and the attendance sweep are owed — the relay is now a
third named, pending install, **not yet installed anywhere** (the droplet still has no
`/srv/shareat` as of this doc's last verification — do not claim installation happened; a fresh
check is this task's job, not an assumption carried over).

## Invariants

1. `mirror_publish` never regresses a mirror document — inherited from `drainOutbox`/`MirrorDriver`,
   unchanged by this task; assert it still holds through the real driver, not just the faked one.
2. `inbox_relay` never loses an event — every event read is either ingested, quarantined, or left
   for a future run (never silently dropped), matching T-182 invariant 6.
3. A REPLAYED punch never re-triggers adjudication; a NEW punch always does, unless the day is
   frozen, in which case the punch still lands and the adjudication failure is visible in the
   report, never silent.
4. One org's job failing outright does not stop another org's, for both `mirror_publish` and
   `inbox_relay`.
5. Running the relay twice in a row with no new data in between changes nothing and reports zero
   new work on the second run (idempotency, inherited from the two functions this task wires
   together — prove it holds end to end, not just per-function).

## Tests

Integration, real Postgres. **This lane's database is `shareat_test_204`** — T-202 and T-203 are
running concurrently on `shareat_test_202` and `shareat_test_203`; do not use `shareat_test` or
`shareat_test_b`. Create it (`psql -U postgres -p 5435 -c "CREATE DATABASE shareat_test_204;"`),
apply every migration including this task's own new one, then point `TEST_DATABASE_URL` at it.
Run `ListAgents` first — **this is the ONE lane in this batch of work that touches a migration**;
confirm no unrelated peer session is mid-migration on the shared `packages/db/migrations/`
directory before writing the new migration file, and stage it as its own commit-worthy change
(don't touch it again after `db:migrate` reports it applied — DEF-069's own rule: an applied
migration is never edited, a new one is written instead). The existing
fake-driver tests for `drainOutbox`/`ingestEvents` are untouched and must stay green; add:

- `runFirestoreRelay` with fake `mirror`/`inbox` drivers: multi-org batch, one org's inbox events
  resolved correctly by `storeId`, an unresolved `storeId` left un-stamped and excluded, a
  `scheduler_runs` row per org per job even when there was nothing to do (DEF-044's own lesson).
- `ingestOne` (or `ingestEvents`) additions: a new punch adjudicates and produces an
  `attendance_days` row that did not exist before · a replay does not call `adjudicateDay` again
  (assert via a spy, or via a day whose absence of a second row/update proves it) · a punch for an
  already-frozen day still records the punch and reports the adjudication failure without
  quarantining the punch or losing it.

⚠️ **The real Firestore driver** (`createFirestoreInboxDriver`, `createFirestoreMirrorDriver`)
connects to the REAL `shareat-hub-v2` project via the `.env.local` service account — there is no
Firestore emulator harness in this repo's ingest/mirror path today (T-159/T-180's emulator harness
covers **rules**, not this job). Verify the CLI script end-to-end by hand against real Firestore
**only with test data you clean up afterward** (a manually-written throwaway `/inbox` doc, deleted
or left permanently stamped after; never against a real terminal's live events), and say plainly in
the report that this was a manual, not automated, verification — the integration suite above covers
the logic with fakes, not the real SDK call.

## Out of scope — with reasons

**Retention/purge of processed inbox docs** — T-182 already named this as needing "a number from
Ian"; still true, still not this task's call · **Alerting on stale unresolved-org or un-stamped
events** — named in §3 step 3, a real follow-up, not invented here · **Installing the systemd
timer on the droplet** — `docs/ops/README.md`'s own precondition section: `/srv/shareat` does not
exist as of the last verification, so there is nothing to install onto yet; this task ships the
unit files, matching the attendance sweep's own "pending install" state, not a live install ·
**A Firestore emulator harness for this job** — would be valuable, is a real gap, is not this
task's scope (T-180's spike built one for rules only) · **Reprocessing already-frozen days'
adjudication failures automatically** — a manager's call via T-158's adjustment flow, unchanged by
this task.

## Done when

- [x] `typecheck` clean.
- [x] `npm test` clean. (942 passed, 1 pre-existing skip unrelated to this task.)
- [x] `npm run test:integration` green on the assigned lane, real output reported. (79 files, 2117
      tests, green on `shareat_test_204`.)
- [x] Migration applied to both `shareat_dev` and the test database used, verified against
      `information_schema` per DEF-069, not by trusting the exit code. (`0124`, verified via
      `pg_constraint` on both.)
- [x] `npm run build` succeeds with the dev server stopped first. (Exit 0; port 9008 was occupied
      by a concurrent lane's dev server earlier in the session — waited for it to free rather than
      stopping someone else's server.)
- [x] `scripts/firestore-relay.ts` run manually against real Firestore at least once, with
      cleaned-up test data, and its output reported verbatim. (Also found and fixed DEF-151, a
      real pre-existing bug in `packages/sync-firestore` blocking every real call — see
      DEF-132/151's rows.)
- [x] Self-reviewed line by line (§9).
- [x] `docs/DEFECTS-REGISTER.md` DEF-132 and DEF-134 rows both updated with what shipped and this
      task's number.
- [x] `docs/ops/README.md` updated per §5.
- [x] This file's status line updated.
