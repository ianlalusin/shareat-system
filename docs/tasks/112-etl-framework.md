# T-112 — The ETL framework: runs, landing, quarantine, reconciliation

> **Status:** ✅ **COMPLETE 2026-08-23** — 22/22 invariants, +4 added closing DEF-041.
> See the notes at the end: **invariant 5 as I wrote it was too weak**, and the implementer found
> a real spec gap (DEF-042) it was right to refuse to work around.
> **Was:** spec ready. **Depends on:** T-103, T-105, T-107, T-113, T-118 (all done).
> **Blocks:** T-114 (Stage 1 analysis + audit report), T-115 (Stage 2 load).
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.

## Goal

The durable, re-runnable harness the whole migration rides on: a **run ledger**, a **landing
table** that snapshots v1 before anyone interprets it, a **quarantine** that can be aggregated
and re-driven, and a **reconciliation** that proves no source document silently vanished.

T-112 builds no mapping and produces no report. It builds the thing that makes the mapping
re-runnable and the report trustworthy.

---

## The one decision that shapes everything: land the raw document BEFORE converting it

**v1 is live and mutating.** An analysis run today and a load run in December do not read the
same data. Transform straight from Firestore and the audit report and the load are not
reproducible against the same input — so any disagreement between them is **unattributable**:
did the mapping change, or did the source change? Nobody can tell, and that is exactly the
question the whole migration exists to answer.

So the pipeline is **capture → land → convert**, never read → convert.

Three consequences, all of them load-bearing:

| | |
|---|---|
| **Reproducibility** | A conversion run in December re-reads the *same bytes* the analysis run saw in September. A difference in output is then, necessarily, a difference in *our* code |
| **Cost and blast radius** | v1 is production. Analysis re-runs a hundred times against landed data with **zero** Firestore reads. Only `capture` touches the source at all |
| **Source drift becomes a FINDING** | A document that changed between runs is recorded, not overwritten. *"These 14 expense docs were edited after we analysed them"* is a fact worth having, and it is only available if landing is append-only |

---

## Scope

Create or modify **only**:

```
packages/db/schema/etl.ts                          the four tables
packages/db/schema/index.ts                        re-export
packages/db/migrations/0008_*.sql                  a NEW migration — see the DEF-039 warning
packages/db/src/repo/etl.ts                        the ONLY place ETL SQL is written
packages/db/src/index.ts                           re-export the repo
packages/etl/src/source-reader.ts                  the read-only source interface + a fixture reader
packages/etl/src/run.ts                            the orchestrator
packages/etl/src/reconcile.ts                      the reconciliation computation
packages/etl/src/index.ts                          re-export
packages/etl/package.json                          exports map only
packages/etl/tests/reconcile.test.ts               unit — no database
packages/etl/tests/integration/etl-run.test.ts     real Postgres
```

**Do not modify** `packages/db/schema/journal.ts`, `accounts.ts`, `fiscal-periods.ts`, the seed,
`postEntry`, `reverseEntry`, `convert.ts`, `leg-mapping.ts`, `taxonomy.ts`, `capture.ts`, the
corpus, or anything under `apps/`. Migrations `0000`–`0007` are applied and are **never edited**.

**Do not touch `PROJECT_BIBLE.md`** — §14 reserves amendments to the planner. Report instead.

### ⚠️ DEF-039 — read this before generating the migration

Migrations `0005`–`0007` carry **hand-picked** `when` values in
`packages/db/migrations/meta/_journal.json`. The last one (`1787492000000`) resolves to
**2026-08-23T13:33Z** — which at the time of writing was **five minutes** ahead of the wall
clock. drizzle-kit stamps a generated migration with the real time, and the migrator **sorts by
`when` and silently skips anything that sorts earlier**, exiting `0`.

Generate `0008`, then **immediately** run `packages/db/tests/migration-journal.test.ts`. If it
fails, correct the generated `when` so it sorts after `0007`. Do not assume the margin held.

---

## Contract

### 1. The source reader is read-only *by type*, not by convention

```ts
export interface SourceDocument {
  docPath: string;            // full path — the natural key, e.g. 'stores/ABC/journal/xyz'
  docId: string;
  collectionPath: string;     // 'stores/{storeId}/journal'
  storeCode: string | null;
  payload: Record<string, unknown>;
}

export interface SourceReader {
  readonly sourceSystem: string;                       // 'erp_v1'
  listCollections(): Promise<readonly string[]>;
  readDocuments(collectionPath: string): AsyncIterable<SourceDocument>;
}
```

**No write method is declared, so none can be called.** Bible §11 rule 4 — *the ETL never
mutates Firestore* — is enforced by the type, not by a code-review promise.

Ship a `FixtureReader` (an in-memory implementation over a plain object) for tests. **The
concrete Firestore reader is OUT OF SCOPE** for the same reason `capture.ts` gave: the
credentials (`CAPTURE_ERP_SA_KEY`, `CAPTURE_HUB_SA_KEY`, `CAPTURE_SALT`) are not present in this
environment, so any Admin-SDK code path would be unexercised and unreviewable. Leave it injected.

### 2. Landing is APPEND-ONLY, and content-hashed

`etl_source_documents`:

| column | |
|---|---|
| `id` | uuidv7 |
| `run_id` | the run that landed **this version** |
| `source_system`, `collection_path`, `doc_path`, `doc_id`, `store_code` | identity |
| `payload` | `jsonb` — the document exactly as read |
| `content_hash` | sha256 over **canonical** JSON (keys sorted, stable number formatting) |
| `captured_at` | |

**`UNIQUE (source_system, doc_path, content_hash)`.** Landing the identical document twice is a
no-op. Landing a **changed** document inserts a *second* row — it never overwrites the first.
"Current" is the row with the greatest `captured_at` for a `doc_path`, which is a view, not a
maintained flag (bible §4.2 rule 7).

> The canonical-JSON step is not a detail. Two serialisations of the same document that differ
> only in key order would hash differently and manufacture a phantom "the source changed"
> finding on every single run. Pin it with a test.

### 3. The run ledger

`etl_runs (id, source_system, mode, status, started_at, finished_at, started_by, notes, error)`

- `mode ∈ ('capture','analyze','load')` · `status ∈ ('running','succeeded','failed','aborted')`
- A run whose body throws is finalised as `failed` **with the error recorded** — in a `finally`,
  never left `running`. A crashed run that stays `running` forever would block every future run
  through the lock below, and the operator would have no idea why.
- **`UNIQUE` partial index on `(source_system, mode) WHERE status = 'running'`.** One run at a
  time. Two concurrent `capture` runs race on landing; this is trivial to add now and genuinely
  unpleasant to retrofit once there is history.

### 4. Quarantine — a reason CODE, not just prose

`etl_quarantine (id, run_id, source_system, doc_path, source_type, case_class, reason_code,
reason_detail, first_seen_at, last_seen_at, resolved_at, resolved_run_id)`

**`reason_code` is an enumerated string; `reason_detail` is the free text.** Prose alone cannot
be aggregated, and the audit report's entire value is in the aggregate:

> *"1,412 documents quarantined — 880 `unmapped_expense_category`, 407 `unbalanced_source_group`,
> 125 `missing_supplier_party`."*

That sentence is actionable. A log file of 1,412 distinct English sentences is not. **This is the
difference between a report Ian can work from and one he has to read.**

Two behaviours:

- **Re-drivable.** A later run that successfully converts a previously quarantined document
  **resolves** the row — sets `resolved_at` and `resolved_run_id` — and never deletes it.
  *The count of resolved quarantines over time is the migration's progress metric.*
- **Not duplicated.** A document that is still unconvertible on a re-run advances `last_seen_at`
  on the existing open row rather than inserting another.

`UNIQUE (source_system, doc_path, reason_code) WHERE resolved_at IS NULL`.

### 5. Reconciliation — the framework's actual product

`etl_reconciliation (run_id, source_type, source_count, landed_count, converted_count,
skipped_count, quarantined_count, entries_posted, source_amount_total, debit_total, credit_total,
computed_at)` — one row per `(run, source_type)`.

| | |
|---|---|
| **`converted + skipped + quarantined = landed`, exactly** | **HARD.** Every landed document lands in exactly one bucket. A document in none of them has silently vanished, and this equation is the only thing standing between us and that. Assert it; fail the run on violation |
| `source_count = landed_count` | **HARD.** A shortfall means a read failed. That is an error, never a warning |
| `debit_total = credit_total` | **HARD in `load` mode.** The ledger already guarantees it; asserting it here catches a *framework* bug rather than a ledger bug |
| `source_amount_total` vs `debit_total` | **Recorded, never gated.** These are *expected* to differ — a sales day's `totalSales` is not the sum of its debits once discounts and comps split out. T-114 documents the expected relationship per source type. T-112 computes and stores the numbers; it does not judge them |

### 6. Three modes, and `analyze` must run offline

| mode | |
|---|---|
| `capture` | Read and land. **No conversion.** The only mode that touches the source |
| `analyze` | Convert landed documents, classify, quarantine, reconcile. **Writes nothing to the ledger** |
| `load` | Everything `analyze` does, plus post through `postEntry` |

**`analyze` must complete with a reader that throws if it is called at all.** That is the payoff
of §2, and it is an invariant below rather than an aspiration.

### 7. Idempotency and re-runnability

- Re-running `capture` over unchanged data lands nothing, and says so.
- Re-running `analyze` writes that run's reconciliation and **never mutates a prior run's rows**.
- Re-running `load` posts no duplicates — `postEntry`'s `idempotencyKey` already guarantees it;
  derive the key from the source document, never from a timestamp (T-105 §3).
- **The framework never deletes a run's history.** Runs are append-only, like the ledger.

---

## Invariants the tests must prove

**Landing**
1. A new document lands as one row carrying a content hash.
2. Re-landing the byte-identical document inserts **no** new row, and the run reports it unchanged.
3. Canonical hashing: the same document with its keys in a different order hashes **identically**
   and does not manufacture a phantom change.
4. A **changed** document inserts a second row; both survive; "current" resolves to the later one.
5. The framework never UPDATEs or DELETEs a landed row.

**Runs**
6. A run records start, finish and status.
7. A run whose body throws is finalised `failed` with the error recorded — **not** left `running`.
8. A second run of the same `(source_system, mode)` is rejected while one is `running`.
9. Finishing a run releases the lock; the next run starts cleanly.

**Quarantine**
10. An unconvertible document quarantines with a reason **code** and a detail.
11. `GROUP BY reason_code` returns usable counts — the aggregate the audit report is built from.
12. A re-run that now converts a previously quarantined document **resolves** the row, recording
    the resolving run, and does not delete it.
13. A still-unconvertible document advances `last_seen_at` instead of inserting a duplicate.

**Reconciliation**
14. `converted + skipped + quarantined = landed`, exactly.
15. A deliberately induced accounting error — a document dropped between land and classify —
    makes that equation fail and **fails the run**. The regression test for invariant 14.
16. A read failure makes `source_count ≠ landed_count` and fails the run.
17. In `load` mode, `debit_total = credit_total`.
18. Reconciliation is persisted per `(run, source_type)` and readable after the process exits.

**Modes**
19. `analyze` posts nothing — `journal_entries` is unchanged across the run.
20. **`analyze` completes with a reader that throws on every method** — proving it works purely
    from landed data.
21. A repeated `load` run posts no duplicate entries.

**Structural**
22. `packages/etl/package.json` declares **no** Firebase/Firestore dependency — the read-only
    guarantee is a fact about the dependency graph, not a promise.

---

## Out of scope

The concrete Firestore reader (credentials absent — see §1) · the v1→v2 mapping (T-113, done) ·
the audit report's content and narrative (T-114) · the opening-balance/detail load strategy
(T-115) · any UI · any change to the journal schema, `postEntry`, `reverseEntry`, or `convert.ts`.

## Done when

- [ ] Migration `0008` applies cleanly, re-running is a no-op, and
      `migration-journal.test.ts` **passes** (DEF-039 — verify, do not assume).
- [ ] All 22 invariants pass; the unit ones with **no database**.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green (**every existing test
      still passes**) · `build` succeeds with the dev server stopped.
- [ ] `packages/etl` still imports nothing from `apps/`, and now imports nothing from Firebase.
- [ ] Self-reviewed line by line; committed with a message explaining *why*.
- [ ] Any spec defect **reported, not silently worked around**.


---

## Implementation notes — resolved 2026-08-23

**1. My invariant 5 was phrased as a convention, not a constraint — DEF-041.**
It read *"the framework never UPDATEs or DELETEs a landed row."* That is a statement about
**our code's behaviour**, and the implementer satisfied it exactly and honestly: its test greps
`repo/etl.ts` for `.update(etlSourceDocuments)`. Verifying the report rather than accepting it
turned up the obvious consequence — a plain `UPDATE` rewrote a landed payload from 100 to
999999, and a plain `DELETE` removed the row, both silently.

That matters more than my wording implied. **This whole task's central argument** — land before
you convert, so the September bytes are the December bytes — rests on the landed row being
immutable. A payload that can be silently rewritten destroys the argument **without a signal**:
reconciliation still balances, every count still ties, and the audit report quietly describes
data that no longer exists.

Closed by migration `0009_etl_landing_immutable.sql`, a `BEFORE UPDATE OR DELETE` trigger —
the same treatment DEF-031 got, for the same reason. INSERT stays open, because landing is
**append-only, not frozen**, and a test asserts re-landing a changed document was not collateral
damage of the fix.

> **The general lesson, worth carrying into every future spec: an invariant phrased as "our code
> does not do X" is a convention. Phrase it as what the DATABASE refuses, or it is not an
> invariant.** Bible §15 and RULES.md §6.3 already say this; my own spec did not follow it.

**2. The implementer found a real spec gap and correctly refused to work around it — DEF-042.**
§4 requires an aggregable `reason_code`, but `convert.ts` emits only a free-text sentence and no
code. Deriving one by pattern-matching that prose would have been exactly the guessing bible §11
rule 5 forbids. It instead made `reasonCode` an explicit required input on the `Converter` seam
and reported the gap. **T-114 must extend `convert.ts` to emit an enumerated `reasonCode`
alongside its existing `reason`** — not classify by regex over the text.

**3. Two disclosed departures from the literal Scope, both accepted.**

| | |
|---|---|
| "Current" document resolution is a typed `selectDistinctOn` query, not a literal `CREATE VIEW` | Same *derive, never maintain a flag* principle, one fewer database object. Accepted |
| `packages/etl/package.json` gained `@shareat/db` and `@shareat/domain` as dependencies, where Scope said "exports map only" | `run.ts` genuinely writes through the repo and posts through `postEntry`. **Leaving them undeclared would have been a dishonest dependency graph** — the right call, and reported rather than done quietly |

**4. Verified independently, not taken on trust.** typecheck clean · 236 unit · 217 integration ·
`npm run build` succeeds · migration journal strictly ascending (`0009` at 1787494634426 after
`0008` at 1787493293449) · all four `etl_*` tables present in both databases · the three partial
unique indexes confirmed in the applied SQL (landing identity, one-run-at-a-time, open-quarantine).
