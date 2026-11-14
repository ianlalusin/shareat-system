# Sync (Firestore lanes)
## Overview
The transport-free domain half of the Postgres/Firestore edge. Lane A (`publisher.ts`) drains the mirror outbox into a `MirrorDriver`; Lane B (`ingestor.ts`) turns clock-terminal inbox events into punches or visible quarantine rows; `health.ts` answers "is the lane working and what is stuck?" for managers. Only `packages/sync-firestore` imports `firebase-admin`; this folder depends on the driver shapes only.

## Interface
- `index.ts`: re-exports `publisher`, `ingestor`, `health`.
- `publisher.ts`: `drainOutbox(tx, driver, { limit })` (default limit 500), types `MirrorDocument`, `MirrorDriver`, `DrainReport`.
- `ingestor.ts`: `ingestEvents`, types `InboxDriver`, `InboxEvent`, `IngestReport`.
- `health.ts`: `LANE_HEALTH` (outbox lag 15 min, unprocessed inbox 15 min, terminal silent 26 h), `LaneHealthError`, `laneHealth`, `listQuarantine`, `quarantineSentence`, `retryQuarantined`, `discardQuarantined`, types `LaneStatus`, `OutboxHealth`, `InboxHealth`, `TerminalHealth`, `LaneHealthReport`, `InboxLagReport`, `QuarantineView`, `QuarantineList`, `RetryResult`.

## Invariants
- The publisher runs as a scheduled job, never in the request path; a failed publish must not fail the business transaction that enqueued it.
- `MirrorDriver.publish` must be idempotent and never regress: a document with `srcVersion` greater than or equal to the incoming one is left alone. Tombstones carry no `data`.
- Outbox rows are published in entity priority order (credential, then roster, then day feed), then by id, so a kill switch never lags behind a roster row.
- The ingestor is an idempotent consumer: the client key sits behind a UNIQUE constraint and a replay is a success (`alreadyProcessed`), never an error.
- `face` and `manual` methods map to no credential and are refused at the inbox; face templates are never mirrored.
- One bad event never stops the batch: each event runs in its own savepoint, and even unexpected failures are quarantined, not lost. Events from the future beyond 5 minutes are refused.
- A new punch triggers an attendance-day recompute; a failed recompute (for example a day frozen by a paid run) is counted in the report, never thrown, and the punch stays recorded.
- Re-deliveries of a manager-discarded event are counted (`refusedDiscarded`), not silently skipped.
- Reports (`DrainReport`, `IngestReport`) are the evidence; "it ran without errors" is not.

## Side Effects
- Publisher: claims and marks `mirror_outbox` rows via `mirrorOutboxRepo`; calls the injected driver (network lives in the driver).
- Ingestor: writes punches, quarantine rows and attendance recomputes; touches `clockTerminalsRepo.touchLastSeen`; reads `Date.now()` for the future-skew check.
- Health: read-mostly; retry/discard write quarantine state. Authorizes `manage_attendance` (and `provision_clock_terminal` for terminal views). Reads the clock (`new Date()`) unless `now` is injected.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
