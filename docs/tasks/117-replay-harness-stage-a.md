# T-117 — Replay harness, Stage A: the specimen corpus

> **Status:** spec ready. **Depends on:** T-101, T-102, T-103 (all done).
> **Feeds:** T-104 (constraint tests), T-112/T-114 (bulk ETL), and ultimately ADR-005's
> December dual-run gate.
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.

## Goal

Build a harness that captures a **small, coverage-driven corpus of real production
transactions**, converts them into the new relational shape, and replays them in CI forever —
so the schema is tested against what the business actually produces, not against what I
imagined.

## Why a corpus and not a bulk replay

Ian, 2026-08-23: *"we don't have to do it all — say we just get 5 sales dine in, 5 sales à la
carte, those with different history like with void, discount, normal, cancelled tickets, etc,
so all edge cases from real scenario will be covered."*

That is the right instinct and it is better than a bulk replay for this purpose. **A hundred
thousand ordinary receipts teach you one thing.** Fifty receipts spanning void, discount, comp,
cancelled, re-rung and split-payment teach you everything the schema has to survive.

This is bible §15.2 — golden-master characterisation testing — sourced automatically from
production instead of invented by a planner.

**It does not replace the bulk ETL (T-114).** The corpus answers *what shapes exist*; the bulk
run answers *how much is broken*, which is the audit that feeds Ian's 2026 close. Different
questions, both needed.

---

## Scope

Create only:

```
packages/etl/package.json                    @shareat/etl
packages/etl/src/taxonomy.ts                 the case classes and their target counts
packages/etl/src/pseudonymise.ts             deterministic, collision-preserving redaction
packages/etl/src/capture.ts                  read-only Firestore → raw specimen
packages/etl/src/convert.ts                  raw specimen → relational rows
packages/etl/src/report.ts                   coverage + classification report
packages/etl/corpus/                         committed specimen fixtures (JSON)
packages/etl/tests/*.test.ts                 unit tests (no DB)
packages/etl/tests/integration/replay.test.ts   replays the corpus against real Postgres
```

May also modify: `package.json` (workspace list), `tsconfig.json` (path alias),
`vitest.config.mts` (alias), `PROJECT_BIBLE.md` §8 (layout — `etl/` becomes `packages/etl/`).

**Nothing else.** In particular: **never write to any reference repo or to Firestore.**

---

## Build order — capture is NOT the first thing

**Part 1 — convert and replay, against hand-written fixtures.** Buildable immediately, blocked
on nothing. Write 6–8 specimens by hand covering the obvious classes, build the converter and
the replay test, prove the round trip works.

**Part 2 — capture, against live Firestore, read-only.** Needs credentials Ian must supply
(see Prerequisites). Wire it once Part 1 is proven.

Doing it in this order means the task is not blocked on a credential, and the converter is
tested before it is pointed at production.

## Prerequisites Ian must supply for Part 2

**Read-only service accounts.** POS and CUSTOMER share Firebase project `shareat-hub-v2`;
**ERP-rebuild is a separate project**. So up to two credentials, each **read-only**.

Declared in `.env.local` (never committed) as `CAPTURE_HUB_SA_KEY` and `CAPTURE_ERP_SA_KEY`.
If absent, capture **skips with a clear message** — it must never fall back to another
credential, and must never use the existing `FIREBASE_SERVICE_ACCOUNT_KEY`.

---

## Contract

### 1. The taxonomy — coverage, not volume

A table of case classes, each with a target count. The sampler captures a specimen **only if
that class is below target**. Once full, it stops. This is what keeps the corpus small,
readable, and diverse instead of 300 ordinary receipts.

| Class | Target |
|---|---|
| sale · dine-in unlimited, plain | 5 |
| sale · à la carte, plain | 5 |
| sale · with discount (senior / PWD / other) | 5 |
| sale · with comps | 3 |
| sale · voided | 5 |
| sale · partially refunded | 3 |
| sale · re-rung after void (retained cash) | 3 |
| sale · split / multi-method payment | 5 |
| sale · online order | 3 |
| sale · branch sale | 3 |
| ticket · cancelled | 3 |
| refill · addon | 5 |
| expense · cash / AP / online | 3 each |
| expense · CAPEX / PERSONAL | 3 each |
| channel settlement | 3 |
| **anomaly** — zero amount, negative, same-day void, cross-period | **capture every one, no cap** |

> **Empty classes are the most interesting output.** A class that stays at zero for three weeks
> means either it never happens, or the detection rule is wrong. Both are findings, and the
> report must surface them rather than quietly showing 90% coverage.

### 2. Pseudonymisation — redact, but preserve collisions

| Field | Treatment |
|---|---|
| Phone | **Salted hash, deterministic.** Same input → same pseudonym |
| Name, address, email | Replaced with a stable synthetic per pseudonym |
| Firestore ids | Remapped to stable synthetic ids, **relationships preserved** |
| **Amounts, quantities, timestamps, statuses** | **Kept exactly.** They are the thing under test |

**The salt lives in `.env.local` as `CAPTURE_SALT` and is NEVER committed.** This matters: with
a committed salt, anyone holding the repo and a phone number could confirm whether that person
appears in the corpus. With the salt held out, the corpus is pseudonymous and CI still replays
it fine — CI replays committed fixtures, it never re-derives them.

> **Collisions must survive redaction.** Two people sharing a phone number is precisely the
> case that could break `person_identities`' `UNIQUE (kind, lower(trim(value)))`. Randomising
> phones would destroy the one signal we most want.

### 3. Two artifacts per specimen

```
corpus/<class>/<specimen-id>.raw.json        the captured documents, pseudonymised
corpus/<class>/<specimen-id>.expected.json   the relational rows it should become
```

The `.expected.json` is the **golden master**. When the schema or converter changes, re-derive
and diff — that is how a change proves it did not silently alter meaning.

### 4. The replay test

`packages/etl/tests/integration/replay.test.ts` loads every specimen, converts it, inserts it
into a real Postgres, and asserts:

- Every specimen either **loads cleanly** or is **classified with a reason** — never a bare failure.
- Converted rows match `.expected.json` exactly.
- **Every entry balances** and satisfies the T-103 constraints. A specimen that cannot be made
  to balance is a **finding about production data**, recorded, not a test failure to suppress.
- Replay is **idempotent** — running twice produces the same rows, no duplicates.

### 5. Capture job — read-only, day-scoped

- Runs against **yesterday's business day**, after close.
- **Read-only. It must never write to Firestore, and must never touch a reference repo.**
- Idempotent: re-running for the same day adds no duplicate specimens.
- Emits a coverage report: classes full, classes short, classes empty.

---

## Invariants the tests must prove

1. The sampler captures a specimen only when its class is below target; at target it captures
   nothing.
2. Anomaly classes are never capped.
3. Pseudonymisation is deterministic — the same phone yields the same pseudonym across runs.
4. **Pseudonymisation preserves collisions** — two records sharing a phone still share one after
   redaction.
5. Pseudonymisation leaves amounts, quantities and timestamps **byte-identical**.
6. No raw name, phone, email or address survives into a corpus file.
7. Conversion output matches `.expected.json` for every committed specimen.
8. Replaying the corpus twice is idempotent.
9. Every converted journal entry satisfies the T-103 constraints, or is reported with a reason.
10. Capture **skips cleanly** with an explanatory message when credentials are absent — it never
    falls back to another credential.

## Out of scope

Stage B (full-day replay) and Stage C (nightly reconciliation) — later tasks · the bulk ETL
(T-112/T-114) · any schema change · scheduling the nightly job in production · any UI.

## Done when

- [ ] Part 1 complete: converter + replay test green against hand-written specimens.
- [ ] All 10 invariants pass.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green · `build` succeeds.
- [ ] Capture skips cleanly without credentials (Part 2 wiring proven, not exercised).
- [ ] `packages/etl` respects the app-boundary rule — it is a package, so it may **never**
      import from `apps/`.
- [ ] Any spec defect **reported, not silently worked around**.
