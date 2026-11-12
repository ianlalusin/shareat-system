Claimed by DeepSeek deepseek-flash, 2026-11-07 23:22 (Asia/Manila)

> **Re-issued 7 Nov 2026 by the POS design lane (Opus), full body restored.** The earlier copy lost everything except
> its header in a file move, and PR #188 was correctly stopped. This version includes the earlier amendments: the
> `verifiers` store, `verifier-store.ts` and `meta.ts`. Use the **fresh** branch and worktree named below. Never
> reuse `wt-t530a` or `wt-t530b` or their branches.

# T-530a — POS v2 device store: the tablet's offline outbox and snapshot cache (IndexedDB)

| Field | Value |
|---|---|
| Planner | POS design lane (Opus), for BOSS, 7 Nov 2026 |
| Builder | <app and model> |
| Branch | `wo/t530c-pos-device-store` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t530c` (the builder creates it and works only there; run the worktree completeness check from BUILDER-PROMPT.md step 5 before editing) |
| Risk class | **medium**: client-side storage logic with tests. No money arithmetic, no database schema, no sign-in or permissions. A bug here could lose an unsent sale, so the tests are strict |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

The new POS runs on one store tablet and must keep selling when the internet drops. Every till action (seat a table,
add items, take payment) is first written **on the tablet**, into a queue called the **outbox**, and then sent to the
server. The tablet also keeps its last good copy of the menu and settings, the **snapshot**, so it can sell offline.

This work order builds that storage. It is one small library over the browser's IndexedDB, tested against a fake, and
also stores two things a later slice uses:
- opaque PIN-verifier records;
- a few small keyed values.

The screens and the network calls that use it already exist (T-526/T-527). They use an in-memory **stub** that this
work order replaces.

## 2. Read first (and nothing else is required)

- `AGENTS.md`, section "Building from a work order".
- `docs/RULES.md`.
- `docs/plans/pos-v2-design.md` §5.1, the decisions **A2**, **A3** and **A6** in §5.2, and §5.4 ("Offline: what works
  and what does not", including the "Limits stated plainly" line).
- `docs/GLOSSARY.md` entries **outbox** and **terminalSeq**. ⚠ The name `receiptSeq` is banned by a guard test; never use
  it.
- The old v1 code, **as requirements only**. Read it to learn the rules; do not copy its Firestore payloads.
  - `apps/pos/src/lib/terminal/db.ts`: the "one opener" rule, `globalThis.indexedDB` read lazily, and closing on
    `versionchange`.
  - `apps/pos/src/lib/terminal/counter.ts`: a number that is never reused.
  - `apps/pos/src/lib/outbox/README.md`.
  - `apps/pos/src/test-helpers/fakeIdb.ts`: the fake IndexedDB for tests. You copy it in step 1.
- **If `apps/erp/src/lib/pos-device/` already exists on `origin/main`**, T-526 has merged with its stub. Read
  `index.ts` and `stub.ts` there: your real modules must export **the same names and signatures**, because the T-526 and
  T-527 tests import them through `@/lib/pos-device`. Also read `pin-verifier.ts`, which is T-526's own file. **Do not
  edit it.**

## 3. What to build

Everything goes in `apps/erp/src/lib/pos-device/`. It is plain TypeScript: no React, no network calls, and no imports
from `apps/pos` or `packages/db`. Read `indexedDB` **lazily** from `globalThis` inside functions, never at import time,
so tests can install the fake. Every "now" comes in as an argument; never call `Date.now()` inside the library.

1. **Test helper.**
   - Copy `apps/pos/src/test-helpers/fakeIdb.ts` unchanged to `apps/erp/tests/helpers/fake-idb.ts`. It has no imports.
   - Use it in every test with `vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 2 }))`.
   - If the fake lacks something you need (for example indexes, for `verifiers`), add it **in the copy** and say what
     under Builder notes.
2. **`types.ts`**, the server contract, exactly:
   ```ts
   export type PosEventKind = 'stand.opened' | 'lines.added' | 'heads.set' | 'refill.requested' | 'line.cancelled'
     | 'discount.added' | 'discount.removed' | 'discount.applied_to_all' | 'session.voided' | 'sale.completed';
   export interface PosEvent { seq: number; kind: PosEventKind; personId: string; occurredAtDevice: string; payload: Record<string, unknown> }
   export type NewPosEvent = Omit<PosEvent, 'seq'>;
   export type PosEventResultStatus = 'applied' | 'duplicate' | 'conflict' | 'quarantined' | 'retry';
   export interface PosEventResult { seq: number; status: PosEventResultStatus; error?: string; storedKind?: string }
   /** What the caller's network function returns for one POST /api/pos/events. */
   export type SendOutcome =
     | { kind: 'ok'; stateVersion: number; results: PosEventResult[] }
     | { kind: 'http'; status: number }          // 400, 401, 409, 413, 415, 5xx...
     | { kind: 'network' };                      // no connection / timeout
   export interface CachedSnapshot { body: unknown; etag: string; fetchedAtMs: number }
   export interface StoredVerifier { personId: string; employeeId: string; salt: string; hash: string; iterations: number; createdAtMs: number }
   export interface DrainReport { stopped: 'empty' | 'retry' | 'http' | 'network'; status?: number; sent: number; removed: number; conflicts: PosEventResult[]; stateVersion: number | null }
   ```
3. **`db.ts`** is the **only** place that opens this database.
   - `DB_NAME = 'shareat-pos-v2'`, `DB_VERSION = 1`.
   - Stores:
     - `outbox`, keyPath `'seq'`;
     - `meta`, out-of-line keys, holding the counters `nextSeq` and `nextTerminalSeq` and the `app.*` keys of step 7;
     - `snapshot`, out-of-line key `'current'`;
     - `verifiers`, keyPath `'personId'`, plus an index `byEmployeeId` on `'employeeId'`.
   - `openDeviceDb(): Promise<IDBDatabase>`:
     - creates any missing store in `onupgradeneeded` and never touches existing rows;
     - closes itself on `versionchange`;
     - with no IndexedDB, rejects with `Error('This device cannot store sales (no IndexedDB).')`.
   - No other file may call `indexedDB.open`.
4. **`outbox.ts`**
   - `enqueue(event: NewPosEvent): Promise<PosEvent>`:
     - gives the event the next `seq` from `meta.nextSeq` (starting at 1) and increments the counter;
     - stores the event, all in **one** `readwrite` transaction over `meta` and `outbox`;
     - resolves only after the transaction's `complete` event, so a resolved promise means the event is on disk;
     - two racing enqueues never get the same `seq`.
     - It validates first and rejects a bad event without writing anything. Valid means:
       - `kind` is one of the ten;
       - `personId` is non-empty;
       - `occurredAtDevice` parses as an ISO time;
       - `payload` is a plain object with no key `storeId` or `pairingId`.
   - `reserveTerminalSeq(): Promise<number>` returns the next receipt number from `meta.nextTerminalSeq` (starting at 1).
     It is durable in the same way and never returns the same number twice, even across a reopen.
   - `resumeAbove(server: { lastSeq: number; lastTerminalSeq: number }): Promise<void>` sets
     `nextSeq = max(nextSeq, lastSeq + 1)` and `nextTerminalSeq = max(nextTerminalSeq, lastTerminalSeq + 1)`. It never
     lowers a counter. This is how a reinstalled tablet avoids reusing a number the server already has.
   - `listPending(limit: number): Promise<PosEvent[]>` returns events in ascending `seq` order.
   - `countPending(): Promise<number>`.
   - `applyResults(results: PosEventResult[]): Promise<{ removed: number[]; conflicts: PosEventResult[]; retryFrom: number | null }>`:
     - **deletes** each event whose status is `applied`, `duplicate`, `conflict` or `quarantined`;
     - **keeps** `retry`, and keeps every event whose seq is not in `results`;
     - `retryFrom` is the first `retry` seq, or null.
   - `drain(send: (events: PosEvent[]) => Promise<SendOutcome>, opts?: { batchSize?: number }): Promise<DrainReport>`:
     - `batchSize` defaults to 100 and is capped at 100, the server's protocol limit.
     - The loop:
       1. take up to `batchSize` pending events, and stop with `{stopped:'empty'}` when there are none;
       2. call `send`;
       3. on `ok`, call `applyResults`. Stop with `{stopped:'retry'}` if `retryFrom` is not null or if `results` is
          shorter than the batch. Otherwise loop.
     - On `http`, stop with `{stopped:'http', status}` and keep everything.
     - On `network`, or if `send` throws, stop with `{stopped:'network'}` and keep everything.
     - **Single flight:** a second `drain` called while one is running returns the running promise. It never sends
       twice.
5. **`snapshot-cache.ts`**
   - `saveSnapshot(s: CachedSnapshot): Promise<void>` replaces the stored snapshot. The caller uses it only after a
     successful 200.
   - `touchSnapshot(fetchedAtMs: number): Promise<void>` updates only `fetchedAtMs`, after a 304. With nothing stored,
     it does nothing.
   - `readSnapshot(): Promise<CachedSnapshot | null>`.
   - `isSnapshotUsable(s: CachedSnapshot | null, nowMs: number, maxAgeMs: number): boolean` is pure: true when `s` is
     not null and `nowMs - s.fetchedAtMs <= maxAgeMs`.
   - There is **no** function that clears or blanks the snapshot. A failed refresh must never erase the last good copy
     (design A6).
6. **`verifier-store.ts`**: plain storage of opaque records that T-526 creates. **No cryptography, no PIN handling, and
   no sign-in rule here.**
   ```ts
   export function putVerifier(v: StoredVerifier): Promise<void>                  // replaces by personId
   export function getVerifierByEmployeeId(employeeId: string): Promise<StoredVerifier | null>
   export function deleteVerifier(personId: string): Promise<void>
   export function listVerifiers(): Promise<StoredVerifier[]>
   ```
7. **`meta.ts`**: small keyed values for later slices, such as the offline sign-in miss counter. These are **never** the
   counters `nextSeq` or `nextTerminalSeq`, which only `outbox.ts` touches.
   ```ts
   export function getMeta<T>(key: string): Promise<T | null>      // key must start with 'app.' - otherwise reject, write nothing
   export function setMeta<T>(key: string, value: T): Promise<void> // same rule; values are structured-clone data
   ```
8. **`index.ts`** re-exports the public API.
   - **If T-526's stub is on `main`:** replace the stub's exports with your real modules under the **same names**,
     **delete `stub.ts`**, and keep exporting `pin-verifier.ts` unchanged.
   - If the folder is not on `main`, create `index.ts` fresh.
   - **`README.md`**, at most 10 lines, covers:
     - the one-opener rule;
     - that the outbox does not survive "clear data" or an uninstall (design §5.4);
     - that nothing here talks to the network.

**Not to build:**
- `fetch`, a service worker, screens or React hooks;
- online detection;
- the ₱50,000 warning, the X-slip or the update gate;
- any PIN cryptography: that is T-526's `pin-verifier.ts`, which you must not touch.

## 4. Files you may touch

| File | Change |
|---|---|
| `apps/erp/src/lib/pos-device/types.ts` | new |
| `apps/erp/src/lib/pos-device/db.ts` | new |
| `apps/erp/src/lib/pos-device/outbox.ts` | new |
| `apps/erp/src/lib/pos-device/snapshot-cache.ts` | new |
| `apps/erp/src/lib/pos-device/verifier-store.ts` | new |
| `apps/erp/src/lib/pos-device/meta.ts` | new |
| `apps/erp/src/lib/pos-device/index.ts` | new, or edit if T-526's stub version exists |
| `apps/erp/src/lib/pos-device/stub.ts` | delete, only if it exists |
| `apps/erp/src/lib/pos-device/README.md` | new |
| `apps/erp/src/lib/pos-device/db.test.ts` | new |
| `apps/erp/src/lib/pos-device/outbox.test.ts` | new |
| `apps/erp/src/lib/pos-device/snapshot-cache.test.ts` | new |
| `apps/erp/src/lib/pos-device/verifier-store.test.ts` | new |
| `apps/erp/src/lib/pos-device/meta.test.ts` | new |
| `apps/erp/tests/helpers/fake-idb.ts` | new: a copy of `apps/pos/src/test-helpers/fakeIdb.ts` |

The repo copy of this work order (`docs/tasks/530a-pos-device-store.md`) is always allowed.

⛔ **Any file not in this table is off limits.** That includes:
- `apps/erp/src/lib/pos-device/pin-verifier.ts`;
- everything under `packages/`;
- every other file in `apps/erp`, including `apps/erp/src/app/**` and `apps/erp/package.json` (add **no** dependency;
  the fake replaces `fake-indexeddb`);
- `apps/pos`, `apps/customer`;
- `PROJECT_BIBLE.md` and `docs/`, except the work-order copy;
- migrations;
- every existing test.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `db.test.ts` — "opens version 1 with four stores" | `outbox` (keyPath `seq`), `meta`, `snapshot`, `verifiers` (keyPath `personId`, index `byEmployeeId`) exist |
| `db.test.ts` — "no IndexedDB → the plain refusal" | the exact error sentence |
| `db.test.ts` — "reads indexedDB lazily" | the module imports with no `indexedDB` defined; the file text has no top-level `const x = indexedDB` |
| `outbox.test.ts` — "seq starts at 1 and counts up" | three enqueues → 1, 2, 3 |
| `outbox.test.ts` — "racing enqueues never share a seq" | 50 `Promise.all` enqueues → 50 distinct seqs 1..50 |
| `outbox.test.ts` — "survives a reopen" | enqueue, close, open a new connection on the same fake factory → the event and the counter are still there |
| `outbox.test.ts` — "a failed transaction writes nothing" | abort the transaction via the fake → the counter did not move, no event stored |
| `outbox.test.ts` — "refuses a bad event" | each invalid field (unknown kind, empty person, bad time, payload with `storeId`, payload with `pairingId`, array payload) rejects and stores nothing |
| `outbox.test.ts` — "terminal numbers are never reused" | reserve 1, 2; reopen; reserve → 3 |
| `outbox.test.ts` — "resumeAbove only raises" | server lastSeq 40 → next enqueue is 41; then resumeAbove 10 → next is still 42 |
| `outbox.test.ts` — "applyResults removes and keeps by status" | applied, duplicate, conflict and quarantined are removed; retry is kept; an unlisted seq is kept; conflicts are returned; `retryFrom` is right |
| `outbox.test.ts` — "drain sends in order and empties" | 250 events with a fake `send` that applies everything → batches of 100, 100, 50 in seq order, `stopped:'empty'`, 0 pending |
| `outbox.test.ts` — "drain stops on retry" | retry at seq 7 → stops; seq 7 and later still pending, earlier ones removed |
| `outbox.test.ts` — "drain stops on http, network and throw" | each keeps every event; the report says why |
| `outbox.test.ts` — "short results stop the drain" | results for 60 of 100 → the other 40 are kept, and the drain stops |
| `outbox.test.ts` — "single flight" | two `drain` calls at once → `send` is called once per batch, never twice |
| `snapshot-cache.test.ts` — "save, read, touch" | round trip; touch updates only `fetchedAtMs`; touch with nothing stored leaves null |
| `snapshot-cache.test.ts` — "never blanks" | the module exports no clear or delete function (check `Object.keys` of the module) |
| `snapshot-cache.test.ts` — "usable window" | exactly at `maxAgeMs` → true; 1 ms later → false; null → false |
| `verifier-store.test.ts` — "put, get by employee id, replace, delete, list" | round trip; a second put for the same personId replaces it; an unknown employee id → null; the module source contains no `crypto`, `subtle` or `pin` (read the file as text) |
| `meta.test.ts` — "app keys round-trip; counters are off limits" | set and get an `app.x` key that survives a reopen; `getMeta('nextSeq')` and `setMeta('nextSeq', 9)` reject and change nothing |
| existing T-526/T-527 tests, if T-526 is on `main` | they still pass against your real modules (they import through `@/lib/pos-device`) |

Plus, every time:
```bash
npm run typecheck
```
```bash
npx vitest run apps/erp/src/lib/pos-device
```
```bash
npx vitest run --project unit
```

The full unit project has about 11,300 tests and takes a while. One test, `packages/etl/tests/capture.test.ts`, fails
on machines whose `.env.local` is fully filled in; that failure is not yours.

**Guard tests this change will likely move.** Report these; do **not** edit them:
- the production-caller ratchet (`docs/production-caller-baseline.txt`, `tests/unit/production-caller-ratchet.test.ts`).
  `reserveTerminalSeq` and others gain or lose callers, and this is **expected**;
- `tests/unit/t328-*`, which may trip on key enumeration such as `startsWith('app.')`;
- `tests/unit/client-bundle-boundary.test.ts`;
- `tests/unit/glossary-trap-names.test.ts`;
- `tests/unit/t371-census-selftest.test.ts`;
- any test that lists the folders of `apps/erp/src/lib` or scans for `indexedDB` or `Date.now`.

If any existing test fails, **do not edit it**. Paste its name and output under Builder notes and open the PR as a
**draft**. There is no Postgres in this work order, so there are no integration tests.

## 6. Done means

- [ ] Every step in §3 built, inside the §4 file list only.
- [ ] Every §5 test written and passing; typecheck clean; the full unit project's result pasted (pass and fail counts).
- [ ] Smoketest: **not applicable**, because the library has no screen of its own. Write "N/A, library only".
- [ ] One commit per logical step.
- [ ] This work order copied into the worktree as `docs/tasks/530a-pos-device-store.md`, with the real check output
  under **Builder notes**.
- [ ] Branch pushed; **one PR opened** against `main`, with `T-530a` in its title and a body ending "Built by <app>
  <model> from a work order".
- [ ] The work order moved from `current\` to `done\` with the PR link at its top.
- [ ] **Stop there.** You do not merge, deploy or close anything.

## 7. Forbidden — every work order, no exceptions

1. ⛔ Never merge, rebase onto, force-push or delete any branch except your own `wo/` branch. Never push to `main`.
   Never enable auto-merge.
2. ⛔ Never work in `C:\Users\ianla\webapps\shareat-system` itself. Only run `git fetch` and `git worktree add` from
   it. Work only in your own worktree, with a real `npm ci` install, never links.
3. ⛔ Never run `git worktree remove --force` or `rm -rf` on a worktree. Leave it in place when finished.
4. ⛔ Never invent a number (migration, DEF, task or bible row).
5. ⛔ Never edit the reference repos (`ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website`) or anything under
   `inactive projects`. Read them freely.
6. ⛔ Never hard-code a business value. The snapshot age limit is an argument. The 100-event batch cap is the server's
   protocol limit and is allowed.
7. ⛔ Never edit `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md` decisions, or `knowledge/`.
8. ⛔ Never touch a production server. Never paste passwords, keys or database URLs anywhere.

## 8. If you get stuck

Write the step, the exact error output and what you tried under **Builder notes**, in both the `current\` file and the
repo copy. Push, open the PR as a **draft**, move the work order to `done\` with "BLOCKED" at the top, and go on to the
next one.

## 9. Audit checklist (for the Codex audit and the Claude fixer, not the builder)

- [ ] The diff touches only §4 files; no new dependency; `pin-verifier.ts` untouched
- [ ] `enqueue` and `reserveTerminalSeq` write the counter and the row in ONE transaction and resolve on `complete`
- [ ] No path deletes a `retry` event or an event missing from `results`; no function blanks the snapshot
- [ ] `indexedDB` is read lazily; only `db.ts` opens the database; no `Date.now()` in the library
- [ ] `meta.ts` refuses non-`app.` keys; `verifier-store.ts` has no crypto
- [ ] The T-526/T-527 tests pass against the real modules (stub deleted)
- [ ] No §7 rule broken; no `receiptSeq`
- [ ] Money, auth or schema touched? Then send it back to the planner

## Builder notes

Built by DeepSeek deepseek-flash, 2026-11-07/08, from `origin/main` at `f5f0944`, in worktree
`C:\Users\ianla\webapps\wt-t530c` on branch `wo/t530c-pos-device-store` (the re-issued names).

`apps/erp/src/lib/pos-device/` did **not** exist on `origin/main` (T-526 is not merged), so
`index.ts` is new, there is no `stub.ts` to delete, `pin-verifier.ts` was never present, and the
T-526/T-527 tests this order mentions do not exist yet. Everything is plain TypeScript: no React, no
network, no import from `apps/pos` or `packages/`, no `Date.now()` (checked with grep), and
`indexedDB.open` appears only in `db.ts`.

### What is there

| File | What it does |
|---|---|
| `db.ts` | the one opener: `shareat-pos-v2` v1 with `outbox` (keyPath `seq`), `meta` (out-of-line), `snapshot` (out-of-line), `verifiers` (keyPath `personId` + index `byEmployeeId`); reads `indexedDB` lazily; closes on `versionchange`; the exact no-IndexedDB refusal |
| `outbox.ts` | `enqueue`, `reserveTerminalSeq`, `resumeAbove`, `listPending`, `countPending`, `applyResults`, `drain`; every write is one `readwrite` transaction resolving on `tx.complete`; single-flight drain, batch cap 100 |
| `snapshot-cache.ts` | `saveSnapshot`, `touchSnapshot`, `readSnapshot`, pure `isSnapshotUsable`; nothing can clear or blank it |
| `verifier-store.ts` | `putVerifier`, `getVerifierByEmployeeId` (via the index), `deleteVerifier`, `listVerifiers`; stores bytes, does no secret handling |
| `meta.ts` | `getMeta` / `setMeta`, `app.*` keys only — the two counters are unreachable from here |
| `index.ts`, `README.md` | the public surface; the one-opener rule, the non-backup caveat, no network |
| `types.ts` | the server contract exactly as §3 gives it |

**⚠️ Two deliberate notes.**

1. **`nextSeq`/`nextTerminalSeq` are "the number to hand out next"**, per §3 step 4 ("gives the event
   the next `seq` … starting at 1 and increments the counter"). `enqueue` therefore reads the stored
   value (absent → 1), uses it as the `seq`, and stores `seq + 1`. `resumeAbove` raises the stored
   value to `max(stored, server + 1)`, which is what makes a reinstalled tablet's next event
   `server + 1`.
2. **The fake IndexedDB copy gained indexes** (allowed by §3 step 1, "if the fake lacks something
   you need (for example indexes, for `verifiers`), add it in the copy"). The `verifiers` store needs
   a real index in `db.ts`, so the copy now supports `store.createIndex(name, keyPath)` inside a
   versionchange transaction, `store.indexNames`, and `index(name).get / getAll` as a filter over the
   store's rows. `apps/erp/tests/helpers/fake-idb.ts` is otherwise `apps/pos/src/test-helpers/fakeIdb.ts`
   unchanged — including its timing, which is what makes "resolves only on complete" testable.

### Checks — real output

`npm run typecheck`

```
> shareat-system@0.1.0 typecheck
> tsc --noEmit
```
exit 0, clean.

`npx vitest run apps/erp/src/lib/pos-device`

```
 ✓ apps/erp/src/lib/pos-device/db.test.ts (3 tests) 58ms
 ✓ apps/erp/src/lib/pos-device/snapshot-cache.test.ts (4 tests) 361ms
 ✓ apps/erp/src/lib/pos-device/verifier-store.test.ts (2 tests) 512ms
 ✓ apps/erp/src/lib/pos-device/meta.test.ts (1 test) 403ms
 ✓ apps/erp/src/lib/pos-device/outbox.test.ts (14 tests) 43524ms

 Test Files  5 passed (5)
      Tests  24 passed (24)
```

Every §5 case is present and green: stores + index, the no-IndexedDB refusal, lazy import, seq
counting and the 50-way race, reopen, the aborted transaction, six invalid events, terminal numbers,
`resumeAbove`, `applyResults`, the four drain stops, short results, single flight, snapshot
round-trip / touch / no-clear / window, verifier round-trip / replace / delete / list / no-secret
source, and the `app.*` key rule.

⚠️ The 250-event drain case takes ~25 s locally: each `enqueue` is an open + a readwrite transaction,
and Windows' timer resolution turns the fake's `setTimeout(0)` steps into ~15 ms each. The numbers
themselves are the order's (250 events, batches of 100/100/50); the file sets
`vi.setConfig({ testTimeout: 60_000 })` so the bulk cases are not cut off at 5 s and left running
into the next test.

`npx vitest run --project unit --maxWorkers=6`

```
Tests  total 11590  failed 122  passed 11464  pending 4
```

This machine was under heavy load during the run — **639 MB free RAM and 28 `node` processes at the
time** — and most failures are vitest's `STACK_TRACE_ERROR` (a worker that died without a stack) or
a 5 s timeout on a tree-walking test. I re-ran them solo with a longer timeout and they pass:
`app-boundaries` 6.1 s, `glossary-trap-names` 10.6 s, `client-bundle-boundary`, `pos-v2-offline-guards`
(36), `pos-v2-copy` (20), `pos-v2-server-boundary` (20), `pos-v2-money-guards` (17) — all green. The
`deploy-pos-failed-build` / `t455-s9a-ops` failures are the usual ones that need `bash` on Windows.

### Guard tests that moved — NOT edited

**`tests/unit/production-caller-ratchet.test.ts`** — 14 exported names newly joined the
zero-production-caller set. This is the movement §5 predicts: this is a library whose callers are
T-526/T-527, and **T-526 is not merged on `main`**, so nothing in production imports it yet.
`enqueue`, `listPending`, `applyResults` and `openDeviceDb` are not in the list; the 14 are:

```
countPending, deleteVerifier, drain, getMeta, getVerifierByEmployeeId, isSnapshotUsable,
listVerifiers, putVerifier, readSnapshot, reserveTerminalSeq, resumeAbove, saveSnapshot,
setMeta, touchSnapshot
```

Output:

```
AssertionError: 14 name(s) newly joined the zero-production-caller set:
  countPending — NOT tracked anywhere else. Give it a real caller, or confirm the gap is known...
  ...
Regenerate with:
  node scripts/production-caller-census.mjs --names > docs/production-caller-baseline.txt
```

I did **not** regenerate `docs/production-caller-baseline.txt` and did not give the functions fake
callers: the honest reading is "known gap, blocked on T-526", which is BOSS's call to baseline.

One other failure is not a guard: `packages/domain/tests/t375-s0-census-script.test.ts` expected exit
code 2 from a child script and got `3221226505` (`0xC0000409`), a crashed child process under memory
pressure — not related to these files.

### Smoketest

**N/A, library only.** There is no screen of its own (the order says the same), and no signed-in ERP
session is available to this builder.

### Commits

- `T-530a: the device database, its contract, and the test fake`
- `T-530a: the outbox - numbering, durability, validation, results, drain`
- `T-530a: snapshot, verifier records, app.* keys, and the public surface`
- `T-530a: 24 tests over the device store`
