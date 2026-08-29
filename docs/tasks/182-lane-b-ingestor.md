# T-182 — Lane B: the inbox ingestor, and a quarantine that is never a dead end

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> ⚠️ **RENUMBERED 2026-08-30: was T-161.** Both this lane and the inventory lane had taken T-161; attendance moved because it is finished while inventory is still being written. ⛔ **Commit messages predating the rename still say T-161** — git history is not rewritten.
> **Depends on:** T-156 (`recordPunch` — the one writer), T-159 (the inbox path and its rule).
> **Blocks:** T-183 (the screen that reads the quarantine), and the phase's exit gate.

## The pattern: idempotent consumer

The event carries a client-generated key; the consumer writes behind a `UNIQUE` constraint; a replay
is a silent no-op. Bible §4.2 rule 10 states it directly — *"This replaces debounce/throttle
guesswork"* — and T-156 already built the target: `recordPunch` returns `alreadyProcessed: true` as
a **success**, because an ingestor that errors on a re-delivery retries forever.

## What v1 got wrong, and it is the whole reason this task has a second half

Landmine #14, from discovery 05 §6:

> *"**no admin/manager UI was found anywhere in the app that reads dead-lettered punches** out of a
> device's IndexedDB, inspects them, or lets a manager manually re-file the underlying attendance
> session. Recovery today appears to be entirely informal."*

⭐ **In v2 the event is in Firestore, not in a private device store**, so it is never unreachable —
which is what makes a real quarantine possible at all. Bible §5.4 rule 5: *"If an event cannot be
ingested, it is **quarantined and surfaced**, never dropped."*

## Contract

### 1. `inbox_quarantine`

| Column | Notes |
|---|---|
| `id` `uuid` pk | |
| `orgId` / `storeId` | |
| `clientPunchId` | ⭐ `unique` — the same key the punch would have used, so re-delivery of a quarantined event updates rather than piles up |
| `deviceId` → `clock_terminals` | Which terminal sent it |
| `rawEvent` `jsonb` | ⚠️ The event **exactly as received**. §11 rule 5: *"Dirty data is surfaced, not silently coerced"* — the whole point is that we could not interpret it, so it is stored uninterpreted |
| `reasonCode` | A CHECK-constrained closed set — see §3 |
| `reasonDetail` | Prose for a human |
| `firstSeenAt` · `lastSeenAt` · `attempts` | |
| `resolvedAt` / `resolvedBy` / `resolution` | `ingested` · `discarded` — and never a silent delete |

⛔ `rawEvent` is the one `jsonb` column in this phase and it earns it: it holds a shape we have by
definition failed to parse. Everything we *did* understand is a real column beside it.

### 2. The ingest loop

```ts
// packages/domain/src/sync/ingestor.ts — transport-free
ingestEvents(tx, events, { deviceId }): Promise<IngestReport>
// packages/sync-firestore — reads /inbox, stamps processedAt, deletes nothing
```

Per event, in order:

1. **Shape check.** Required fields present and typed. Failure ⇒ quarantine `malformed`.
2. **Terminal check.** `deviceId` names a terminal that is provisioned, activated and not revoked,
   for the store the event claims. Failure ⇒ quarantine `unknown_device` / `revoked_device`.
3. **Employment check.** The credential resolves to an open employment at that store. Failure ⇒
   quarantine `unknown_credential`.
4. **Method kill switch**, read from the config **in force on the punch's shift day**. Failure ⇒
   quarantine `method_disabled`.
5. `recordPunch`. `alreadyProcessed` is a **success**.
6. Stamp `processedAt` + the punch id on the Firestore document, and `lastSeenAt` on the terminal.

⭐ **Step 4 re-checks on every event including replays**, which is v1's `assertMethodEnabled` and
its one genuinely hard-won line: the check *"was previously skippable by supplying `atMs`"*, so a
backdated replay could use a method an admin had disabled.

### 3. Reason codes — a closed set, because a screen has to render them

`malformed` · `unknown_device` · `revoked_device` · `unknown_credential` · `method_disabled` ·
`store_mismatch` · `future_timestamp` · `internal_error`.

⚠️ **`too_old` is deliberately absent.** v1 rejects a punch past 72 hours and dead-letters it; plan
§5 D3 dissolved that — the event is reachable in Firestore, so ingest always accepts and T-157
raises `late_event_arrival` for a manager to confirm. **Ingest is not where a business judgement is
made.** Bible §5.1: events are raw facts; Postgres adjudicates.

### 4. ⛔ An event is never deleted from Firestore

`processedAt` is stamped; the document stays. Two reasons: a device offline during the stamp must
still see its own event, and *"an event with no `processedAt` after a threshold is an alertable
condition"* (§5.1) — which requires the un-stamped ones to still be there. Retention is a later,
separate decision with a number attached.

### 5. Re-delivery of a quarantined event

Bumps `attempts` and `lastSeenAt` and re-runs the checks. ⭐ **A quarantine can therefore heal
itself**: an event quarantined as `unknown_credential` at 09:00 ingests cleanly at 09:05 once the
staffer is enrolled, with no human action. That is the difference between a quarantine and a dead
letter, and it is the point of the whole design.

### 6. The report

```ts
interface IngestReport {
  seen: number; ingested: number; alreadyProcessed: number;
  quarantined: number; healed: number; byReason: Record<ReasonCode, number>;
}
```

§11 rule 3: *"'It ran without errors' is not evidence; the reconciliation report is."*

## Invariants

1. The same event twice yields one punch and `alreadyProcessed` the second time.
2. A malformed event is quarantined with its raw body intact, never dropped and never coerced.
3. An event from a revoked terminal is quarantined, not ingested.
4. A method disabled in the config **in force on the punch's shift day** is refused — including on a
   replay.
5. A quarantined event that later becomes valid **heals** on re-delivery, with no human action.
6. Nothing is ever deleted from the inbox; `processedAt` is stamped instead.
7. A punch older than 72 hours **ingests**, and is flagged downstream rather than refused here.
8. Ingesting 500 events where 499 are replays does 499 no-ops and one insert.
9. One malformed event does not stop the batch; the rest ingest.
10. The report's numbers add up to `seen`.

## Tests

Integration on **`shareat_test_b`**, driver faked for the arithmetic and an emulator pass end to
end. Fixtures: a clean punch · the same event twice · a batch of 500 with one new · malformed ·
unknown device · revoked device · unknown credential · disabled method · an out-of-order pair ·
a quarantined event healing · a 72-hour-old event ingesting · an event whose store disagrees with
its terminal.

⭐ **And the phase's exit gate, as a test**: an event written to the emulator while the client is
offline, replayed on reconnect, ingested, adjudicated, and the day correct. It belongs here rather
than only in T-184 — this is the half that can be tested without a browser.

## Out of scope

**The quarantine screen** — T-183 · **Retention/purge of processed inbox docs** — needs a number
from Ian; the table is append-only until it has one · **Alerting on un-stamped events** — the
condition is named in §5.1 and the query is trivial once T-183 exists · **The terminal** — T-184.

## Done when

- [ ] All ten invariants pass, including the offline round trip against the emulator.
- [ ] Migration hand-written in **0077–0089**; `inbox_quarantine` classified **and** RLS-registered —
      ⭐ **own first commit**.
- [ ] The report's fields are asserted, not just logged.
- [ ] `typecheck` · `npm test` · `npm run test:integration` green, real output reported.
