# T-160 — Lane A: the transactional outbox and the mirror publisher

> **Status:** Spec written 2026-08-29 by the Opus planner (session `ianla-f9`, lane B).
> **Depends on:** T-159 (the paths and their rules), T-154, T-155.
> **Blocks:** T-163 — a terminal with nothing mirrored has nothing to match a credential against.

## The pattern, named before the design (bible §0.2)

**Transactional outbox.** The row change and its publish intent commit in **one** transaction; a
relay drains the outbox afterwards. Bible §15.4 already forbids dual-write, and this is the
sanctioned way to keep that promise — a post-commit hook loses the publish when the process dies
between the two, and there is no way to tell afterwards that it did.

## Contract

### 1. `mirror_outbox`

| Column | Notes |
|---|---|
| `id` `bigserial` pk | ⭐ Not uuid v7. The relay reads **in insertion order** and a monotonic integer is the cheapest possible watermark |
| `orgId` / `storeId` | Scoping, and the publisher's batching key |
| `entity` | `roster` · `attendance_config` · `day_feed` — a CHECK-constrained closed set |
| `entityId` | The Postgres PK. ⭐ **It is also the Firestore document id** — §5.1's *"deterministic… it is the Postgres primary key"* |
| `op` | `upsert` · `delete` |
| `srcVersion` `bigint` | §5.1: *"The publisher writes only when `srcVersion` is newer"* |
| `enqueuedAt` · `publishedAt` · `attempts` · `lastError` | |

- `index (published_at nulls first, id)` — the drain query, and it is the only one that matters.
- ⛔ **No payload column.** The relay re-reads the row at publish time, so a queue that falls behind
  publishes *current* truth rather than replaying a stale snapshot. A mirror is allowed to be
  stale; it is not allowed to be **wrong**.

### 2. `srcVersion` — one global sequence

A dedicated `mirror_version_seq`. Not `updated_at`: two rows updated in the same millisecond are
indistinguishable, and clock skew between writers makes "newer" unanswerable. A sequence is a total
order by construction.

### 3. The hot set, and only the hot set

Bible §5.3's list is **closed**. This task publishes three of the six:

| # | Entity | Status here |
|---|---|---|
| 1 | Active roster (name, position, staffId) | ✅ from `v_active_employments` |
| 2 | Fingerprint templates + matchToken | ⛔ **Not here** — enrolment is T-164 |
| 3 | Store attendance config | ✅ ⭐ **priority** — see §4 |
| 4 | On-shift roster + current-day punch feed | ✅ |
| 5 | Clock-terminal identity | — T-159, and it is not mirrored; it *is* the auth |
| 6 | Punch events | — Lane B, T-161 |

⛔ **Nothing else. Ever.** Adding a seventh needs a bible amendment (§5.3), and there is already one
pending: a **card id** is not in item 1, and D1 makes card the only browser-viable offline mode.
**Until Ian amends §5.3, this task cannot publish card ids and the offline card path stays blocked.**
That is the phase's critical path and it belongs in the report, not in a comment.

### 4. Config is published FIRST, always

Landmine #15: v1 does not cache attendance config offline, so *"a terminal keeps accepting a
credential method an admin has just disabled and the rejection surfaces only at sync time, as a
silent dead letter."* Bible §5.3 marks item 3 **priority**.

So the drain orders `attendance_config` ahead of everything else in each batch. ⚠️ A kill switch that
arrives after the roster is a kill switch that did not work.

### 5. Tombstones, never hard deletes

§5.1: *"Deletions are **tombstones** (`deletedAt`), never hard deletes — an offline device must be
able to learn that a record went away."* A terminated employment publishes `{ deletedAt, srcVersion }`
and the document stays. ⚠️ A hard delete is invisible to a device that was offline when it happened:
it simply keeps the stale row forever.

### 6. The relay

```ts
// packages/domain/src/sync/publisher.ts — transport-free, driver-injected
drainOutbox(tx, driver, { limit }): Promise<{ published: number; failed: number }>
// packages/sync-firestore — the ONE place firebase-admin is imported (T-159 §1)
```

- Idempotent and replayable: publishing an already-current document is a no-op by `srcVersion`.
- A failure increments `attempts` and records `lastError`; the row stays unpublished and is retried.
- ⛔ **A row is never dropped.** §5.4 rule 5 — quarantined and surfaced, never silently discarded.
- ⚠️ **Runs as a scheduled job, not in the request path.** A publish that fails must never fail the
  business transaction that enqueued it — that would reintroduce the dual-write coupling the outbox
  exists to remove.

## Invariants

1. A change and its outbox row commit together, or neither does.
2. A published document's id equals its Postgres PK.
3. Re-running the drain publishes nothing new and changes nothing.
4. A stale queue publishes CURRENT truth, not the value at enqueue time.
5. `attendance_config` is published before any other entity in the same batch.
6. A delete publishes a tombstone; the document survives with `deletedAt`.
7. A publish failure leaves the row unpublished, with `attempts` and `lastError` set.
8. Only the three named entities are ever published — asserted against a pinned allow-list, the
   same shape as T-156's column guard.
9. No client can write a mirror path (T-159's rules; re-asserted here end to end).
10. A drain of an empty outbox is a no-op that reports zero rather than erroring.

## Tests

Integration on **`shareat_test_b`** with a fake driver for the arithmetic, plus an emulator pass for
the real Firestore write. Fixtures: an employment change enqueuing exactly one row · a config
supersede jumping the queue · a termination producing a tombstone · a driver that throws · a
re-drain changing nothing · a stale row publishing current truth · an attempt to enqueue an
unlisted entity (**refused**).

## Out of scope

**Biometric templates** — T-164 · **Card ids** — blocked on the §5.3 amendment · **The ingestor** —
T-161 · **Real-time listeners** — the terminal reads the mirror through the SDK's own cache; a
push channel is not needed and would be a second delivery path · **Backfilling an initial mirror** —
a one-off enqueue-everything script, and it is T-163's problem when a terminal is first provisioned.

## Done when

- [ ] All ten invariants pass.
- [ ] Migration hand-written in **0077–0089**; `mirror_outbox` classified **and** RLS-registered —
      ⭐ **own first commit**.
- [ ] The entity allow-list is a test, not a convention.
- [ ] `typecheck` · `npm test` · `npm run test:integration` green, real output reported.
- [ ] ⚠️ **The §5.3 card-id amendment is restated to Ian as still blocking.**
