# T-156 — `attendance_punches`: the append-only fact the whole phase rests on

> **Status:** ✅ **BUILT, 2026-08-30.** Spec written by the Opus planner (session `ianla-f9`, lane B); implemented on the `attendance` lane and verified by `ianla-e7` before merge — typecheck 0, unit 696, integration 1360/1360 against a database created empty for the run, build clean.
> **Depends on:** T-154 (`employments` — somebody to punch against), T-155 (`ShiftDay`), T-138
> (`sessions` — attribution).
> **Blocks:** T-157 (adjudication reads punches), T-182 (the ingestor's write target), T-166.
> **Does NOT depend on T-180.** The Postgres side of the punch is driven by the domain, not by
> Firestore; the ingestor adapts to whatever the spike finds. If T-180 fails, this table is still right.

## The one rule this table exists to hold

Bible §5.1, Lane B, and it is quoted rather than paraphrased because the whole design is in it:

> *"Events record **raw facts only** — 'staff X presented fingerprint at time T on device D.' They
> **never** carry a computed business outcome (late/OT/hours/pay). **Postgres adjudicates, always**,
> on the server, with the full ruleset."*

And bible §4.2 rule 9 names this table specifically:

> *"**Append-only where the audit trail matters** — ledger entries, stock movements, **attendance
> punches**. Correction = compensating entry, never `UPDATE`."*

⭐ **So: no `computed_hours`, no `is_late`, no `shift_start_hour`, no status that means "processed
into pay".** If a reviewer can point at a column here and ask *"what rule produced this value?"*, the
column is in the wrong table. Everything derived lives in `attendance_days` (T-157).

## Grounding — what v1 stores, and the three things it gets wrong

v1 has **no punch table**. It has `attendanceSessions` (the adjudicated day) with a `rawTapIds`
array pointing at import rows, and a separate `attendancePunchLog/{clientPunchId}` doc that exists
**only** as an idempotency marker (`attendance-clock.actions.ts:164-169,404`). The raw fact of a live
clock punch is therefore never stored as a first-class record — it is folded into the session on
arrival.

| v1 | Here | Why |
|---|---|---|
| The punch is consumed into the session; only first and last survive as `rawClockIn`/`rawClockOut`, middle taps as ids | **Every punch is a row, forever** | A day that adjudicated wrongly cannot be re-derived from a record that was overwritten by its own conclusion. This is what makes "recompute from truth" (discovery 15 §6) mechanically possible |
| Idempotency is a **marker document** written in the same transaction | Idempotency is a **`UNIQUE` constraint** | Bible §4.2 rule 10, verbatim: *"Idempotency keys are UNIQUE constraints… This replaces debounce/throttle guesswork."* The marker doc works; a unique index cannot be forgotten by a new write path |
| `DEBOUNCE_MS = 8000` blocks a second live punch in a time window | ⛔ **No debounce.** The unique key is the dedupe | The 8-second debounce **caused a production incident** on 2026-08-19: clock-OUT wrote its `lastClockPunchAt` stamp non-transactionally, so a concurrent clock-IN read a stale stamp and created a duplicate open session (`attendance-clock.debounce-race.test.ts` exists for this). Landmine #21: *"every temporal guard is a server/DB constraint; UI is a courtesy"* |
| `validateAtMs` **rejects and dead-letters** a punch older than 72h | **Always ingest; flag it** | Plan §5 D3. In v2 the event lives in Firestore, not a private IndexedDB, so it is never unreachable — the 72h cliff becomes a review flag, not data loss. Landmine #14 |

## Contract

### 1. `attendance_punches`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk `uuidv7()` | Time-ordered by construction, which is what this table is queried by |
| `orgId` / `storeId` | `uuid not null` | §4.2 rule 2 |
| `personId` | `uuid not null` → `persons` `on delete restrict` | |
| `employmentId` | `uuid not null` → `employments` `on delete restrict` | ⭐ Resolved **at ingest**, not at read. The employment a punch belongs to must not change if the person is later re-hired |
| `clientPunchId` | `text not null` | ⛔ **`UNIQUE`. The idempotency key.** Client-generated `crypto.randomUUID()`, and the Firestore inbox document id (T-180 Contract §1) |
| `occurredAt` | `timestamptz not null` | When the credential was presented. **Device clock** — see §3 |
| `shiftDay` | `date not null` | Computed on write from `occurredAt` via `toShiftDay`. Bible §6: *"the row has an explicit `business_date` computed on write — never re-derived per query at read time"* |
| `method` | `text not null` CHECK `('pin','nfc','qr','fingerprint','face','manual')` | How they identified |
| `assertedIntent` | `text not null` CHECK `('in','out','break_start','break_end')` | ⭐ See §2 — the name is the specification |
| `deviceId` | `text null` | The provisioned terminal. NULL for a manual back-office entry |
| `source` | `text not null` CHECK `('online','offline_replay','manual_entry','import')` | |
| `capturedBySessionId` | `uuid null` → `sessions` | The **verified** actor who worked the terminal, from `resolveActor`. v1 calls this `clockInByUid` and takes it as a client parameter — landmine #17 |
| `receivedAt` | `timestamptz not null default now()` | When the server first saw it. `receivedAt − occurredAt` **is** the offline lag, and it is the only honest measure of it |
| `supersedesPunchId` | `uuid null` → self | A correction points at what it corrects. §5 |
| `voidReason` | `text null` | Set **only** on the correcting row, never on the corrected one |
| `createdAt` / `createdBy` | | |

Indexes: `(store_id, shift_day)` · `(employment_id, occurred_at)` · `unique (client_punch_id)` ·
`(store_id, received_at)` for the ingest-lag monitor.

### 2. ⭐ `assertedIntent` — the column whose name carries the design

Bible §5.1's own example of a raw fact is *"staff X presented fingerprint at time T on device D"* —
**with no intent in it.** Intent is already an interpretation, and an offline terminal cannot make it
reliably: v1's own offline branch *"has no way to know if this is really a clock-IN or clock-OUT
(server state is unknown offline), so **both buttons are offered** and whichever the operator taps is
queued as-is"* (discovery 05 §1.2 step 4).

So the terminal records **which button was pressed**, because throwing that away loses real
information, and the name says exactly how much to trust it:

- The device **asserts**; the server **adjudicates**. T-157 may conclude a punch asserted `in` was
  the day's `out`, and records that it did.
- ⛔ **Nothing outside T-157 may read `assertedIntent` to decide anything.** A screen showing
  "clocked in at 09:02" reads `attendance_days`, not this column.

This is not pedantry: v1's terminal offering both buttons offline is precisely how a mistaken tap
becomes a wrong day, and the fix is for the server to be allowed to disagree.

### 3. `occurredAt` comes from a device clock, and the schema must not pretend otherwise

The terminal's clock can be wrong, and offline it cannot be corrected. Three defences, none of which
is "trust it":

1. `receivedAt` is server-side and always trustworthy. The lag is computable and monitorable.
2. ⛔ `check (occurred_at <= received_at + interval '5 minutes')` — a punch from the **future** is
   refused at the database. Five minutes is ordinary clock skew; an hour is a broken device.
3. A punch whose lag exceeds **72 hours** is ingested and **flagged for review** by T-157, never
   rejected (plan §5 D3). v1 rejects and dead-letters it; that is the data-loss cliff.

### 4. Append-only — enforced by trigger, not by discipline

```sql
create trigger attendance_punches_append_only
  before update or delete on attendance_punches
  for each row execute function refuse_mutation();
```

Modelled on `journal_lines_posted_immutable` (migration `0004`), which is the pattern this repo
already uses for the ledger. ⚠️ **DEF-036's lesson applies directly:** *"a guard written against the
states that exist today silently stops guarding when a new state is introduced."* This trigger takes
no state argument at all — it refuses every UPDATE and every DELETE unconditionally — so there is no
state for a future column to slip past.

### 5. A correction is a new row

There is no edit and no delete. To correct a punch, insert a new one with `supersedes_punch_id`
pointing at it and a `void_reason`. The adjudication ignores any punch that is superseded.

- `check (supersedes_punch_id is null) = (void_reason is null)` — both or neither.
- `unique (supersedes_punch_id) where supersedes_punch_id is not null` — one correction per punch;
  a chain of corrections corrects the correction, which stays readable.
- A punch may not supersede itself, and may not supersede one from a different employment.

### 6. `recordPunch` — the one write path

```ts
recordPunch(tx, input: {
  clientPunchId: string; employmentId: string; occurredAt: Date;
  method: PunchMethod; assertedIntent: PunchIntent;
  deviceId?: string; source: PunchSource; capturedBySessionId?: string;
}): Promise<{ punch: AttendancePunch; alreadyProcessed: boolean }>
```

⭐ **`alreadyProcessed: true` is a SUCCESS, not an error.** `on conflict (client_punch_id) do
nothing`, then read the existing row. A replay is a silent no-op success (bible §5.1: *"a replay is a
silent no-op"*), because the ingestor will legitimately re-deliver events and an error would make it
retry forever.

⛔ **One writer per table** (§4.2 rule 8). The ingestor, the online terminal path and the manual
back-office entry all call `recordPunch`; none of them writes the table directly. This is the rule v1
broke everywhere and the bible calls *"the single most expensive lesson from ERP-rebuild."*

### 7. Capability

Recording a punch is not a privileged act — **it is the thing a staffer does**, authenticated by
their own credential. Reading *someone else's* punches is `manage_attendance`, which already exists.
**No new capability.** Filing a `manual_entry` punch on someone else's behalf **is**
`manage_attendance`.

## Invariants

1. `UPDATE` and `DELETE` are refused on every row, by every path including raw SQL.
2. The same `clientPunchId` twice yields one row and `alreadyProcessed: true` the second time.
3. `shiftDay` always equals `toShiftDay(occurredAt)` — including for a 01:30 punch, which lands on
   the previous day.
4. A punch more than 5 minutes in the future is refused.
5. A punch 80 hours old is **accepted** and its lag is computable. (⭐ The v1-divergence test.)
6. A correction supersedes exactly one punch; a second correction of the same punch is refused.
7. `voidReason` and `supersedesPunchId` are both-or-neither.
8. No column in this table is derived from a business rule. **Asserted as a test** that reads
   `information_schema.columns` and compares against a pinned allow-list — so adding
   `computed_hours` here fails a test rather than a code review.
9. A punch cannot reference an employment in a different store.
10. Deleting an employment or a person with punches is refused by FK.

> ⭐ **Invariant 8 is the unusual one and it is deliberate.** Every other guard in this file protects
> data; that one protects the *architecture*, and it is the only mechanism that will still be working
> in a year when somebody adds "just one denormalised field for the roster screen."

## Tests

Integration, real Postgres, **`shareat_test_b`**. Fixtures: a plain punch · the same
`clientPunchId` replayed (one row, `alreadyProcessed`) · a 01:30 punch (previous shift day) · a
future punch (**refused**) · an 80-hour-old punch (**accepted**) · an UPDATE by raw SQL (**refused**)
· a DELETE by raw SQL (**refused**) · a correction · a second correction of the same punch
(**refused**) · a `voidReason` with no `supersedesPunchId` (**refused**) · a cross-store employment
(**refused**) · the column allow-list.

⚠️ **Confirm the two raw-SQL refusals fail first** — write the trigger after the test, and watch the
UPDATE succeed once. A trigger test that never saw the mutation go through has not proven the trigger
is what stopped it.

## Out of scope

**Adjudication** — T-157; this table stores facts and computes nothing · **The Firestore inbox and
the ingestor** — T-182, and `recordPunch` is deliberately transport-agnostic so it does not need to
know · **Break allowance arithmetic** — T-157. ⭐ Note that breaks need **no new machinery** here:
they are punches with a different `assertedIntent`, which is how v2 gets an offline break path that
v1 does not have at all (discovery 15 §1: *"v1 has **no offline path for breaks at all**"*) ·
**The missed-clock-out sweep** — T-166 · **Any UI** — schema and service.

## Done when

- [ ] All ten invariants pass on `shareat_test_b`, with the two trigger tests seen failing first.
- [ ] Migration hand-written, **0070–0089**, journal row `previous.when + 86400000`.
- [ ] Classified in `cutover/classification.ts` **and** `rls/registry.ts` — ⭐ **own first commit**.
- [ ] `npm run typecheck` · `npm test` · `npm run test:integration` green, real output reported.
- [ ] Self-reviewed line by line.
