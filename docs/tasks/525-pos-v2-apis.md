# T-525 — POS v2 APIs: events inbox, snapshot, state poll

> **Status:** spec written 7 Nov 2026 by the POS design lane (Opus planner). Not built.
> **Depends on:** T-523 (schema, PR #169), T-524 (domain, `02d621a` on `lane/t524-tests`), T-539 (rule keys, 0241)
> for real VAT, SC/PWD and day-start values. Until T-539 lands, tests inject `deps.readRules` as T-524 does.
> **Migration:** none. Every table it needs exists (T-523). If the builder finds one is truly needed, stop and ask the
> orchestrator for a number (the next free one is 0242).
> **Design:** `docs/plans/pos-v2-design.md` §5.1, A3–A6, §5.4. **Bible:** rows 276, 351, 356, 430, 431. **Model:** Sonnet
> builder, Sonnet auditor (money + auth).

## Goal

Give the store tablet three doors into the ERP:

1. **`POST /api/pos/events`**: the outbox drains here. Each typed event runs one T-524 domain function in its own
   transaction. A replay is harmless. A refused event is **quarantined and shown**, never dropped (row 276, A4).
2. **`GET /api/pos/snapshot`**: everything the tablet needs to sell offline, as one closed list (row 430), behind an ETag.
3. **`GET /api/pos/state?since=N`**: the 3-second poll. It answers 304 when the store's `state_version` is unchanged (A5).

**v1's goal (§1.2d):** never stop selling, never lose or double a sale. v1 wrote raw Firestore documents, so a retried
write could double, and a rejected write vanished. **v2 beats it:** `UNIQUE (pairing_id, seq)` makes every replay a no-op,
the server recomputes every bill (T-524), and a refusal becomes a visible quarantined row with a manager action.

## Out of scope (each with its reason)

| Out | Why |
|---|---|
| Server phones and the kitchen screen writing through `/api/pos/events` | They are online-only ERP browsers (A9). They call the T-524 functions through Server Actions in T-527/T-529, with `pairingId = null`. No outbox, so no inbox |
| The quarantine **screen** | T-526 shell / T-533. This slice ships the domain functions and their tests only |
| `xslip.printed`, refunds, tender corrections, Z | X-slip is T-530. Refunds, corrections and Z are online-only requests (A4), not events |
| Setting `pos_stores.mode` | The switch runbook (T-533). Tests set it through the repo |
| Live push (SSE, WebSocket, LISTEN/NOTIFY) | A5: Lipa peaks at 12 receipts an hour; polling costs nothing |
| A rate limiter | Every write needs a paired-tablet secret. Body and batch caps (R2) bound the cost |
| Seq-gap enforcement | A missing earlier event makes a later one refuse and quarantine. When the earlier one arrives, the manager replays the later one (R6). Blocking on gaps could wedge a tablet forever |

## R1 — Where the code lives

- `apps/erp/src/app/api/pos/{events,snapshot,state}/route.ts`: thin. Read the cookies, cap the body, call the domain,
  map the result to HTTP. No SQL and no business rule here.
- `packages/domain/src/pos/inbox.ts`: `applyPosEvents`, the kind → function table, the person check (R4), quarantine,
  `replayQuarantinedEvent`, `discardQuarantinedEvent`.
- `packages/domain/src/pos/snapshot.ts`: `buildPosSnapshot`.
- `packages/db/src/repo/pos-v2.ts`: new helpers only, listed in R9.
- Cookies: `readPosTabletToken` (existing, `apps/erp/src/lib/session.ts`) for the device. The person session cookie
  (`shareat_session`) through the existing `currentSession()`.
- Every route answers with `cache-control: no-store` (except the snapshot, see R7) and JSON `{ok, ...}`.

## R2 — `POST /api/pos/events`: the envelope

- **Device auth:** `resolvePosTablet(null, token)` from the `shareat_pos_tablet` cookie. Null → **401**
  `{ok:false, error:"This tablet is not paired. Ask a manager to pair it again."}`. `orgId`, `storeId` and `pairingId`
  come from the pairing only. Any `storeId` or `pairingId` inside a payload is a validation failure (R3).
- **No person session cookie is required.** Offline events are sent hours later, after the session may have ended. Each
  event names its person; R4 checks them.
- **CSRF:** require `content-type: application/json`, else **415**. The cookie is `SameSite=Lax`, so a cross-site form
  POST carries no cookie anyway.
- **Caps:** body ≤ 512 KB (read with a capped reader like `readCappedText` in the lobby handlers), else **413**.
  1–100 events per batch, else **400**.
- **Store mode:** `pos_stores.mode = 'off'`, or no `pos_stores` row → **409** `"The POS is not switched on for this store."`.
  Nothing is processed and the device keeps its outbox.
- **Body:** `{events: [{seq, kind, personId, occurredAtDevice, payload}]}`. `seq` is a positive integer. `kind` is one of
  R3's list. `personId` is a uuid. `occurredAtDevice` is an ISO time. `payload` is an object. A malformed envelope →
  **400** with the first problem in one sentence, and nothing is processed.
- **Order:** events run in ascending `seq`, each in its **own** top-level transaction (`withOrgPrincipal`). Never a
  savepoint: 0240's append guard refuses a receipt child written in a savepoint (T-524 builder note 2).
- **Answer: 200** `{ok:true, stateVersion, results:[{seq, status, error?}]}`, one result per event processed, where
  `status` is one of:

| status | Meaning | The device |
|---|---|---|
| `applied` | Written now | Drops it from the outbox |
| `duplicate` | Same `(pairing, seq)` already stored with the same kind and payload | Drops it |
| `conflict` | Same `(pairing, seq)` already stored with a **different** kind or payload. Nothing is written; the response includes the stored kind | Drops it, logs it, and shows "A sale number was reused on this tablet. Tell a manager." A device bug; never silent |
| `quarantined` | The domain refused it. A quarantined `pos_events` row now holds it | Drops it. The manager sees it (R6) |
| `retry` | A temporary failure (R5). **Processing stops here**; later events are not attempted | Keeps it and everything after it, and tries again later |

## R3 — Kinds and payloads

The kind picks the T-524 function. The payload is the function's input **minus** `storeId` and `pairingId`, which come
from the pairing. Validate every payload with a strict schema (unknown keys refused) before calling the domain. A
payload that fails validation is **quarantined** with code `POS_EVENT_INVALID`, so a bad event is visible and never blocks
the queue.

| kind | T-524 function |
|---|---|
| `stand.opened` | `openStand` |
| `lines.added` | `addLines` |
| `heads.set` | `setHeadsCashier` |
| `refill.requested` | `requestRefill` |
| `line.cancelled` | `cancelLine` |
| `discount.added` | `addLineDiscount` |
| `discount.removed` | `removeLineDiscount` |
| `discount.applied_to_all` | `applyPresetToAllLines` |
| `session.voided` | `voidUnpaidSession` |
| `sale.completed` | `completeSale` |

- `heads.confirmed` and `line.served` are **not** tablet kinds. They come from the server phone and the kitchen screen
  (A9, out of scope).
- `session.voided` from the tablet: an offline void carries `offline: true` and no PIN. T-524 already requires
  `approve_pos_correction` on the actor in that case (row 356). An online void with a manager PIN carries
  `approval.pin`. The `pos_events.payload` stored for that event **must have the PIN removed** before insert
  (`approval: {pinGiven: true}`). A PIN never lands in a table.
- Unknown kind → quarantined with `POS_EVENT_UNKNOWN_KIND`. This is the forward-compatibility path: an old server never
  drops a newer tablet's event.

## R4 — Who did it: the person check (per event)

The tablet signs a person in offline with its device-only verifier (A6), so the server cannot see that PIN. It checks
the person instead, at receive time, in the event's transaction. **All four must hold, else the event is quarantined
with `POS_EVENT_PERSON_REFUSED`:**

1. `personId` is an active person in the pairing's org.
2. `accessRepo.personMaySignInAtStore(personId, storeId)` is true **now**. A staffer removed since stops being able to
   push events. Their already-applied events stay.
3. The person has had at least one PIN session **on this pairing**: a `sessions` row with `device_id = pairingId`,
   `store_id = storeId`, `credential_kind = 'pin'`, and `issued_at` within `POS_OFFLINE_SIGNIN_WINDOW` (7 days) before
   `occurredAtDevice`. Ended sessions count, except `ended_reason = 'revoked'`. This is how the server knows the device
   verifier was really made for that person on that tablet.
4. `occurredAtDevice` is within `POS_DEVICE_CLOCK_SKEW` (±3 days) of the server clock. This closes T-524 re-audit R2:
   it caps a wrong or tampered tablet clock that would otherwise pick the business day and the rate date.

Then the actor is `{personId, orgId}` and the domain's own `authorize()` decides the capability, as it does online.
`POS_OFFLINE_SIGNIN_WINDOW` and `POS_DEVICE_CLOCK_SKEW` are security constants beside `PIN_SESSION_TTL_MS`, not business
settings. Each gets a one-line comment saying why.

## R5 — Applying one event (the transaction)

In one top-level transaction:

1. Insert the `pos_events` row (`status = 'applied'`, the stored payload per R3). On 23505 for
   `pos_events_pairing_seq_unique`, roll back. In a new read, compare the stored `kind` and `payload` with the sent ones:
   equal → `duplicate`, different → `conflict`. Compare the PIN-stripped payload on both sides.
2. Run R4, then the domain function with `deps` (the injected rules reader in tests, the default reader in production).
3. Commit → `applied`.

When step 2 throws:
- **A domain refusal** (`RefusalError`, `AuthorizationError`, a validation failure from R3, or R4) → roll back. In a
  second transaction, insert the row with `status = 'quarantined'` and `error = "<CODE>: <sentence>"` (the table has one
  `error` text column; no migration). Result `quarantined`.
- **Retryable** → roll back, insert nothing, result `retry`, stop the batch. Retryable means:
  - a serialization or deadlock failure (40001, 40P01);
  - a connection error;
  - the refusal codes in the closed list `RETRYABLE_POS_CODES`, which starts as `['RULES_NOT_WIRED']`. A missing setup
    is not the event's fault, so quarantining it would bury good sales.
- **Anything else** (a bug) → roll back, log it with the event's `(pairingId, seq, kind)` and no payload, and result
  `retry`. Never quarantine an unknown error as if it were the event's fault. Never drop it.

The domain functions already bump `state_version`. The inbox does not bump it again. `stateVersion` in the answer is read
after the batch.

The insert in step 1 makes a replay a no-op **before** the domain runs, so it does not rely on every domain function's own
replay check. Those checks stay as the second line of defence.

## R6 — Quarantine review (domain only; the screen is later)

- `listQuarantinedEvents` exists (repo). Wrap it as a domain read `listPosQuarantine(tx, actor, {storeId})`. Capability
  `approve_pos_correction`, store-scoped. It returns seq, kind, person display name, occurredAtDevice, receivedAt and
  error. It returns the payload too, with no PIN, because the PIN is stripped at insert.
- `replayQuarantinedEvent(tx, actor, {storeId, eventId})`: capability `approve_pos_correction`. It re-runs the stored
  event through R4 and R5 step 2 **as the original person**. The resolving manager is recorded in `resolved_by` and the
  audit row.
  - On success: set `resolved_by`, `resolved_at` and `resolution = 'replayed'` (the only columns the frozen trigger
    allows). Audit `pos.event_replayed`.
  - On refusal: leave the row unresolved and return the new sentence.
  - A replay of a stored online void cannot re-check the PIN, which was never stored. Refuse it with "Ask the manager to
    void this table again from the till."
- `discardQuarantinedEvent(tx, actor, {storeId, eventId, reason})`: capability `approve_pos_correction`. The reason is
  required (1–200 chars). Set `resolution = 'discarded'`. Audit `pos.event_discarded` with the reason. The row is never
  deleted.
- An already-resolved row → refuse "This event was already handled."
- Register both audit actions in the catalogue, with `clientSources: ['erp']`.

## R7 — `GET /api/pos/snapshot`

- **Auth:** the paired-tablet cookie only (R2's 401). The staff list is needed **before** anyone signs in. No person
  session is required.
- **Store mode `'off'`** → 409, as in R2.
- **Body: the closed list (row 430, bible §5.3).** Nothing outside it:

| Key | Contents |
|---|---|
| `store` | `{storeId, name, mode, terminalNo}`. `terminalNo` is this pairing's `pos_terminals.terminal_no`. No terminal row for this pairing → 409 "This tablet has no till number yet. Ask a manager." |
| `menu` | `loadStoreMenu(tx, orgId, storeId)` → `{menu, contentHash, nextChangeAt}`. Call it directly, not `loadMenuForTerminal`, which resolves through v1's terminal link |
| `stands` | Active stands: `{id, label, sortOrder}` (whatever the T-523 columns are) |
| `tenders` | This store's **active** tenders: `{id, name, kind}`. Keyed by id (T-375) |
| `discountPresets` | Active presets: `{id, name, valueType, value}` |
| `rules` | `readRules(tx, orgId, businessDate)` → `{vatPercentBasisPoints, scPwdPercentBasisPoints, businessDayStartHour}`. The device needs them to print a bill offline. `RULES_NOT_WIRED` → 503 "The POS business rules are not connected yet. Ask an admin." |
| `staff` | People who may sign in at this store now: `{personId, displayName, employeeId, posCapabilities}`. `employeeId` is the 3-digit staff code number (row 381). `posCapabilities` is the subset of `[record_sale, request_pos_refill, serve_pos_ticket, confirm_pos_heads, approve_pos_correction]` that `authorize()` grants them at this store, so the tablet can grey out an offline void for a non-manager. **No PIN material of any kind** (A6) |
| `device` | `{pairingId, lastSeq, lastTerminalSeq}`: the highest `pos_events.seq` stored for this pairing (any status), and the highest `pos_sales_receipts.receipt_seq` for this terminal. A reinstalled tablet resumes both counters above these and never reuses a number (DEF-587) |
| `businessDate` | `currentBusinessDate(storeId)` |

- **ETag:** `"<sha256 of the canonical JSON body>"` (reuse the menu's canonical-JSON helper). If `If-None-Match` matches
  → **304** with no body. Headers: `cache-control: private, no-cache`, `x-next-change-at` from the menu.
- The tablet fetches it at sign-in and every 5 minutes. It never blanks a good snapshot on a failed fetch (A6, T-508).
  That is T-530's rule; state it in the route's doc comment.

## R8 — `GET /api/pos/state?since=N`

- **Auth:** a live person session (`currentSession()`).
  - The store is the pairing's when the tablet cookie is present and resolves.
  - Otherwise it is the `storeId` query parameter. This is how the server phone and kitchen screen poll.
  - Store scope is checked by the domain reads' existing `requireStoreScope`.
  - No session → 401. Wrong store → 403.
- **Cheap path first:** read `pos_stores.state_version` (one indexed row). If `since` equals it → **304**, no body, and
  no other query runs.
- **Otherwise 200** `{ok:true, stateVersion, openStands, kitchenQueue, refillQueue}`, from the T-524 reads
  `listOpenStands`, `listKitchenQueue` (optional `stationId` parameter) and `listRefillQueue`. Each read is only called
  if the actor holds its capability; a missing one gives `null` for that key, not a 403. A cashier's tablet gets stands;
  a kitchen screen gets its queue.
- `since` missing or not a non-negative integer → treat as −1 (always 200).

## R9 — New repo helpers (`packages/db/src/repo/pos-v2.ts`)

`insertPosEvent`, `getPosEventByPairingSeq`, `getPosEvent(id)`, `resolvePosEvent` (the 3 resolved columns only),
`maxSeqForPairing`, `maxTerminalSeq(storeId, terminalNo)`, `listActiveStands`, `listActivePresets`,
`getTerminalForPairing`, `hasPinSessionOnPairing(personId, storeId, pairingId, from, to)`, `getStateVersion`. Use the
active-tenders read if one fits; otherwise add `listActiveTendersForStore`. Explicit branded row types, as T-524 did.
Every query filters by `org_id` and `store_id`.

## R10 — Tests (tester writes first; every ✅ needs its ✗)

**Integration** (`packages/domain/tests/integration/t525-pos-inbox.test.ts`, plus route tests that call the route
handlers with a built `Request`):

- `stand.opened` + `lines.added` + `sale.completed` in one batch → three `applied`. The receipt exists, and the
  `pos_events` rows are `applied`. `stateVersion` is higher.
- The same batch sent again → three `duplicate`. Counts are unchanged; no second receipt, no second statutory row.
- Same seq, different payload → `conflict`, and nothing written.
- A refused event (e.g. `lines.added` on an unknown session) → `quarantined`, with an `error` that starts with its code.
  The events after it in the batch still run.
- `RULES_NOT_WIRED` (the default reader) on a `sale.completed` → `retry`. The batch stops and no `pos_events` row is
  written for it or after it.
- R4, each clause separately:
  - unknown person;
  - person not allowed at the store;
  - no PIN session on this pairing;
  - only a revoked session;
  - a session older than 7 days;
  - occurredAtDevice 4 days in the past and 4 days in the future.
  Each → `quarantined` `POS_EVENT_PERSON_REFUSED`.
- A Server (position defaults from 0240) sending `sale.completed` → quarantined by `authorize()` (no `record_sale`).
- A payload carrying `storeId` → quarantined `POS_EVENT_INVALID`. Unknown kind → `POS_EVENT_UNKNOWN_KIND`.
- An online void with a PIN: the stored payload has no `pin` key (assert on the raw row).
- Route envelope cases:
  - no cookie → 401;
  - a revoked pairing → 401;
  - text/plain → 415;
  - 101 events → 400;
  - more than 512 KB → 413;
  - store mode `'off'` → 409, with no rows written.
- Quarantine review:
  - a manager replays after the missing `stand.opened` arrives → `resolution = 'replayed'` and the line exists;
  - discard with no reason → refused;
  - discard → `'discarded'`, and the row is still there;
  - resolving twice → refused;
  - a cashier without `approve_pos_correction` → refused;
  - another store's manager → refused.
- Snapshot:
  - contains exactly the R7 keys (assert the key set);
  - `staff` has no key matching `/pin|hash|secret|salt/i`;
  - a second GET with the ETag → 304;
  - a price change → a new ETag;
  - no terminal row → 409;
  - `lastSeq` and `lastTerminalSeq` are right after a sale.
- State:
  - `since` = current → 304, and no list query runs (spy the repo);
  - after `lines.added` → 200 with the new version;
  - a kitchen-only person gets `openStands: null` and a queue;
  - no session → 401;
  - another store's id → 403.

**Census:** the new routes go through the existing route census and caller guards (domain-actions-have-callers loses the
`UNWIRED` rows for the functions now wired). Bump counts as each guard demands. Never weaken a guard.

## R11 — Gates

`npm run typecheck`, the unit project, and the integration files above plus t523, t524, t524-position-defaults,
t354-trigger-registry and t398-s6-migration, all on the lane's own `_test` DB. Never print a value from `.env.local`:
build the test DB URL inside the command. The full integration suite runs in CI.

## Open (for the planner, not Ian)

- **O1.** R4's 7-day window and ±3-day skew are proposals. They are safe against Lipa's data: 0 offline receipts in 91
  days, 1 ever. Change them only on a measured need.

## Rulings on the tester's questions (planner, 7 Nov 2026)

1. **Quarantine code:** `<CODE>` is the refusal's own code when it carries one (T-524 `refuse()` codes such as
   `RECORDED_DIFFERENTLY`). An `AuthorizationError` is stored as `POS_EVENT_NOT_ALLOWED`. Any other refusal with no code
   is stored as `POS_EVENT_REFUSED`.
2. **A wrong manager PIN** (`AuthenticationError` from `verifyPosManagerApproval`) is the event's fault. Quarantine it as
   `POS_EVENT_PIN_REFUSED`; never `retry`. Test it.
3. **State:** sign-in and store scope are checked **before** the 304 shortcut. 403 beats 304.
4. **R4 clause 3:** the PIN session must have been issued **at or before** `occurredAtDevice + 10 minutes`. The 10
   minutes absorb a tablet clock a little behind the server's. A session issued only later does not count. Test both
   sides of the edge.
5. **R4 clause 1:** an unknown person's quarantined row stores `person_id = NULL` (the column has an FK). The error
   sentence names the id that was sent.
6. **Audit `clientSources`:** omit it for `pos.event_replayed` and `pos.event_discarded`. They are server-only actions,
   and the catalogue's client list has no `'erp'`.
7. **Kinds:** a well-formed kind that is not in R3's list is quarantined (`POS_EVENT_UNKNOWN_KIND`). A kind that fails
   the table's pattern `^[a-z]+(\.[a-z_]+)+$` is a malformed envelope → **400**, nothing processed.

## Rulings after the build and the audits (planner, 7 Nov 2026)

1. **Codes.** A refusal's code is the leading `UPPER_SNAKE:` of its raw message. T-524's `RULES_NOT_WIRED` and
   `RECORDED_DIFFERENTLY` gained that prefix. An unknown person's sentence may name the uuid that was sent.
2. **Retry.** These are `retry` and are logged at warn: `RETRYABLE_POS_CODES`, any `AUDIT_*` or `UNKNOWN_AUDIT_*`
   refusal (a server fault), SQLSTATE 40001, 40P01 and classes 08, 25, 53 and 57, and unknown errors.
3. **The event's fault.** SQLSTATE classes 22 and 23 are quarantined as `POS_EVENT_INVALID`. A collision race in class
   23 is recovered by a manager replay. That is accepted, because it is rare.
4. **The tablet's queue never wedges.**
   - NUL characters and unpaired surrogates in keys or values are replaced with U+FFFD, and the event is quarantined
     `POS_EVENT_INVALID`.
   - Nesting deeper than 64 levels, and an `occurredAtDevice` outside the years 0001–9999, are quarantined the same way.
     The out-of-range time is stored as the received time.
   - If the quarantine insert itself fails with class 22, it is tried once more with payload `{"unstorable": true}`.
5. **PINs.** Any key matching `/pin/i`, at any depth and on any kind, is stored as `pinGiven: true`. A wrong manager PIN
   is charged once, in the quarantine transaction (`recordPosApprovalMiss`, server-only), so the 5-miss cap trips.
   ⚠ **Follow-up for T-527/T-528:** a direct Server Action calling T-524's `voidUnpaidSession` rolls back its own miss
   charge on a wrong PIN, so its caller must charge the miss the same way.
6. **Replay.**
   - A replay of `sale.completed` rethrows on any refusal, so no half-written sale commits.
   - A replayed event's clock skew is measured against `received_at`.
   - A `POS_EVENT_INVALID` row cannot be replayed, only discarded.
   - A replay of an online void is refused.
7. **Kept as built.**
   - Snapshot stands are `{id, number}`.
   - `employeeId` is the 3-digit string.
   - The audit source of the review actions is `'web'`.
   - Senior and PWD holder names and IDs stay in the `pos_events` payload. The table is purge-class, and the same data
     sits in `statutory_discount_records`.
