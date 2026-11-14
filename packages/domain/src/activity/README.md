# Activity
## Overview
The server half of the offline event envelope (T-402 S3): `recordClientEvents` accepts a batch of device-originated events inside the caller's sale transaction and writes them to the audit log. The device never writes the log; every attested value comes from the server.

## Interface
- `client-events.ts`: `recordClientEvents(tx, input)`, types `ClientEventIn`, `ClientEventResult`, `RecordClientEventsInput`.

## Invariants
- `tx` is required: the batch rides with the sale, so a rollback drops the events too.
- Org and store come from the terminal identity, the uploader from the session, and source is `'pos'`; the envelope is built by explicit pick of the seven R10 fields (never a spread), so a device cannot inject `actorPersonId`, `orgId`, `source`, `category`, `retention` or `deviceId`.
- No `authorize()` here (the sale's path is the gate) and no HTTP route.
- Throws for the whole batch only for an uploader from another org or store than the terminal's, a source other than `'pos'`, or database errors. Per event it returns `accepted`, `replayed` or `refused` with the writer's code; refusals happen before any SQL can fail so the transaction stays usable.
- Failure events (`security.event_store_mismatch`, `security.event_replay_conflict`) go through the outbox in their own transaction so they survive the sale rolling back.

## Side Effects
- Writes audit-log events via `auditLogRepo.appendClientEvent` in the caller's transaction.
- Failure events are written in a separate transaction through the outbox.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
