# T-114a — The Firestore reader, and the first real capture from v1

> **Status:** spec ready. **Depends on:** T-112 (framework, done), Ian's read-only keys (both
> supplied 2026-08-23; ERP verified at `roles/datastore.viewer`).
> **Blocks:** T-114b (analysis + audit report), T-115 (Stage 2 load).
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.

## Why T-114 is split, and why this half comes alone

The phase plan has one T-114: *"Stage 1 — analysis mode + audit report."* It is two jobs with
different risk profiles, and merging them would hide the risky one inside the interesting one.

**This half is the first time anything we have written reads live production.** Cost, permissions,
volume, and pagination are real and none of them are visible from here. It deserves its own gate.

**And T-114b cannot be honestly specced yet.** The analysis design depends on what the landed data
actually contains — how many journal legs exist, which `sourceType`s really occur and in what
proportion, how many groups have a source document at all, how many stores are live. Writing that
spec before looking would be inventing, which is the exact failure bible §3.6 exists to prevent.
**T-114a produces the evidence T-114b is planned from.**

---

## ⚠️ It reads PRODUCTION. Four rules that are not negotiable

| | |
|---|---|
| **Read-only, structurally** | Implement T-112's `SourceReader`, which declares no write method. Do not add one. Do not import anything that offers `.set()`, `.update()`, `.delete()`, or a batch writer, beyond what the query API unavoidably exposes |
| **Never a full sweep by default** | Every run names its stores and collections explicitly. There is no "read everything" default and no flag that means it |
| **Count before you read** | Firestore's `count()` aggregation is far cheaper than reading documents. **Report the count and stop** unless the caller explicitly opts into fetching. A surprise six-figure read bill is a real outcome of getting this wrong |
| **Resumable** | Page with a cursor and record progress. An interrupted capture must resume, not restart — restarting re-pays for every document already read |

**Do not attempt a full-history capture in this task.** The deliverable is a proven path and a
bounded first sample, not a complete load.

---

## Scope

Create a **new package** — `packages/etl-firestore`:

```
packages/etl-firestore/package.json          @shareat/etl-firestore — firebase-admin lives HERE
packages/etl-firestore/src/index.ts
packages/etl-firestore/src/client.ts         credential loading -> an initialised app
packages/etl-firestore/src/reader.ts         FirestoreSourceReader implements SourceReader
packages/etl-firestore/src/plan.ts           the count-first capture plan
packages/etl-firestore/tests/plan.test.ts    unit — no network, no credential
packages/etl-firestore/tests/reader.test.ts  unit — against a fake Firestore surface
scripts/capture.ts                           the CLI entry point
tsconfig.json · vitest.config.mts            path aliases for the new package
```

Modify only: `packages/etl/src/index.ts` (re-export nothing new — leave it alone if unneeded),
`package.json` (a `capture` script), `tsconfig.json`, `vitest.config.mts`.

**Do not modify** `packages/etl/src/*` (the framework is done), `packages/db/**`, `packages/domain/**`,
`convert.ts`, `leg-mapping.ts`, the corpus, or anything under `apps/`.

**Do not touch `PROJECT_BIBLE.md`** — §14 reserves amendments to the planner. Report instead.

### Why a separate package, and not just `firebase-admin` in `packages/etl`

T-112 invariant 22 asserts `packages/etl` declares **no Firebase dependency**, because the
read-only guarantee should be a fact about the dependency graph rather than a promise about
behaviour. Adding `firebase-admin` to `packages/etl` would dissolve that guarantee for the whole
package — **including the analysis code in T-114b, which must never be able to reach production.**

Isolating the adapter keeps invariant 22 true as written, and confines everything that can talk to
Firestore to one small package that does nothing else. Standard ports-and-adapters, and here it
buys a real guarantee rather than a diagram. **Invariant 22's test must still pass unchanged.**

---

## Contract

### 1. Credentials come from the loader that already exists

Use `loadCaptureCredentials` from `packages/etl/src/capture.ts` — it already resolves
`CAPTURE_ERP_SA_KEY_FILE` / inline, validates the JSON is a service account, and never leaks key
material into an error. **Do not re-implement credential handling, and do not read
`FIREBASE_SERVICE_ACCOUNT_KEY`** — that is the app's own auth credential for a different project
and a different purpose.

**Both keys are now supplied** (2026-08-23): `secrets/erp.sa.json` for
`studio-7300228488-a394e` and `secrets/hub.sa.json` for `shareat-hub-v2`. The ERP project's
service account is confirmed at **`roles/datastore.viewer`** and nothing else.

**This task targets the ERP project only.** The hub/POS project is out of scope here even though
its key is present — one production system at a time, and the audit report is about v1's books.

### 2. `FirestoreSourceReader implements SourceReader`

```ts
new FirestoreSourceReader({ credential, sourceSystem: 'erp_v1', pageSize?: number })
```

- `listCollections()` returns the collection paths the plan asked for — **not** a live
  `listCollections()` sweep of the database.
- `readDocuments(collectionPath)` is an `AsyncIterable`, paging with a cursor
  (`orderBy(FieldPath.documentId()).startAfter(last)`), default page size **500**.
- Each yielded `SourceDocument` carries `docPath` (the full Firestore path — the natural key),
  `docId`, `collectionPath`, `storeCode`, and `payload` (the document data, unmodified).
- **Firestore `Timestamp`, `GeoPoint`, `DocumentReference` and `Buffer` values must be converted
  to a stable JSON form before landing.** A `Timestamp` that serialises as `{_seconds, _nanoseconds}`
  in one SDK version and something else in the next would silently change every content hash and
  manufacture a whole-database "the source changed" finding. Convert Timestamps to ISO-8601 strings,
  references to their path string, and **pin it with a test** — this is the same class of hazard as
  T-112's canonical-key-order rule and it is more likely to bite.

### 3. The capture plan — count first, always

```ts
planCapture({ storeCodes, collections }) → CapturePlan
```

A plan is a list of `(storeCode, collectionPath)` targets. Running it has two phases:

1. **Count.** One `count()` aggregation per target. Print a table: target, document count,
   and the total. **Then stop**, unless `--fetch` was passed.
2. **Fetch.** Only with `--fetch`. Streams through `runCaptureMode` from T-112, which lands
   everything append-only and content-hashed.

`--limit N` caps documents fetched per target, so a first run can be genuinely small.

### 4. The CLI

```
npm run capture -- --store <code> --collection journal --collection expenses
npm run capture -- --store <code> --collection journal --fetch --limit 200
```

- No arguments → print usage and exit non-zero. **Never a default that reads anything.**
- `--store all` is **not** implemented in this task. Name stores explicitly.
- Prints the run id, and on completion the reconciliation row T-112 already writes.

### 5. What lands is REAL data, and that is correct

The landing table holds live payloads including staff names and customer identifiers. That is
right for a migration — this is not the pseudonymised corpus path (`pseudonymise.ts`, T-117),
which exists for a different purpose (committed test specimens).

**Consequence to respect, not to solve here:** `etl_source_documents` now holds PII and must never
be exported, dumped into a shared artifact, or copied into a test fixture. Note it in
`secrets/README.md`; do not build an anonymisation layer in this task.

---

## Invariants the tests must prove

**No network, no credential needed for any of these.** Use a fake Firestore surface — an object
exposing `collection()`, `orderBy()`, `startAfter()`, `limit()`, `get()`, `count()` — not a mock of
`firebase-admin` itself.

**Reader**
1. `readDocuments` yields every document across **more than one page**, in id order, with no
   duplicate and no gap at the page boundary. *(A cursor bug that drops or repeats exactly one
   document per page is the classic failure and passes a single-page test.)*
2. An empty collection yields nothing and does not throw.
3. `docPath` is the full Firestore path; `storeCode` is carried through.
4. A Firestore `Timestamp` lands as a stable ISO-8601 string, **not** `{_seconds,_nanoseconds}`.
5. A `DocumentReference` lands as its path string; a `GeoPoint` lands as a stable object.
6. The same document read twice produces byte-identical JSON — **so its content hash is stable**.

**Plan**
7. A plan with no targets is rejected, naming the problem.
8. Count mode issues **one `count()` per target and reads zero documents** — assert the fake's
   document-read call count is exactly zero.
9. `--fetch` is required to read; without it the plan reports and stops.
10. `--limit N` stops at exactly N per target.

**Safety**
11. `FirestoreSourceReader` exposes no write method — assert the instance has no `set`, `update`,
    `delete`, `add`, or `batch` member.
12. `packages/etl/package.json` still declares **no** Firebase dependency (T-112 invariant 22 must
    still pass, unchanged).
13. Missing credentials produce the existing skip result, not a crash.

**Integration — real Postgres, fake Firestore**
14. A planned fetch through `runCaptureMode` lands documents, and re-running lands nothing new.

## Out of scope

The analysis and the audit report (T-114b) · the load (T-115) · DEF-042's `reasonCode` on
`convert.ts` (T-114b) · a full-history capture · `--store all` · the hub/POS project · any
anonymisation of landed data · any UI.

## Done when

- [ ] All 14 invariants pass with **no network and no credential**.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green (**every existing test
      still passes, T-112 invariant 22 included**) · `build` succeeds with the dev server stopped.
- [ ] **A real count run against v1 has been executed and its output reported** — one store,
      `journal` and `expenses`. Counting only; do **not** pass `--fetch` without saying so.
- [ ] Self-reviewed line by line; committed with a message explaining *why*.
- [ ] Any spec defect **reported, not silently worked around**.

> **The count output is the point of this task.** It is the first hard number anyone has about how
> big v1's journal actually is, and T-114b's whole design — batching, runtime, whether full-history
> analysis is even affordable — is planned from it.
