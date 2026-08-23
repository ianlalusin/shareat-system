# T-105 — The posting engine: `postEntry` and idempotency

> **Status:** spec ready. **Depends on:** T-101, T-102, T-103 (all done).
> **Blocks:** T-106 (reversal), T-107 (builder adapter), T-108, T-109, T-112.
> **Also closes:** DEF-031 — the posted-immutability hole on INSERT.
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.

## Goal

One function that writes a balanced journal entry, in one transaction, safely re-runnable.
Everything that ever posts to this ledger — expenses, sales, payroll, the ETL — goes through
it, and nothing else writes to `journal_entries` or `journal_lines`.

## Why the service is thin

T-103 put the rules in the database: balance, minimum two lines, account eligibility, period
open, posted immutability. **`postEntry` does not re-implement any of them.** It arranges the
work in the right order and lets the constraints do the enforcing.

> A service that re-validates what the database already guarantees creates a second source of
> truth, and the two drift. The database wins; the service just uses it correctly.

---

## Scope

Create or modify **only**:

```
packages/domain/package.json                      @shareat/domain — this task creates it
packages/domain/src/ledger/post-entry.ts          the service — owns the transaction
packages/domain/src/index.ts                      re-export
packages/db/src/repo/journal.ts                   the ONLY place journal SQL is written
packages/db/src/index.ts                          re-export the repo
packages/db/migrations/*.sql                      a NEW migration (the DEF-031 trigger change)
packages/domain/tests/integration/post-entry.test.ts
tsconfig.json · vitest.config.mts                 path aliases for @shareat/domain
```

**Do not modify** `packages/db/schema/*`, the seed, `packages/core/*`, or anything under
`apps/`. Migrations `0000`–`0003` are applied and are **never edited** (bible §2 rule 8).

**Do not touch `PROJECT_BIBLE.md`** — §14 forbids an implementer amending it. If you believe
an amendment is needed, **report it** and the planner will make it (bible §13 row 86).

---

## Contract

### 1. `postEntry` — the only way in

```ts
postEntry(tx, {
  orgId, entryDate, sourceType, sourceId,
  idempotencyKey,            // required — see §3
  memo?,
  postedBy?,
  lines: [{ accountCode, storeId?, channelId?, debit?, credit?, lineMemo? }, ...]
}) → { entryId, created: boolean }
```

- Accepts **`accountCode`**, not `accountId`. Callers know `6200`, not a uuid. The repo
  resolves code → id, and an unknown or non-active code is an error naming the code.
- `created: false` means the idempotency key already existed and nothing was written.
- Runs inside **one** transaction. If the caller supplies one, it joins it; otherwise it opens
  one (bible §4.3 — every mutating service function is one transaction or documents why not).

### 2. Ordering — this is the whole design, and it closes DEF-031

**Insert the entry as `draft`, insert all lines, then flip to `posted` as the last statement.**

```
BEGIN
  INSERT journal_entries (status = 'draft')      -- period resolved, see §4
  INSERT journal_lines   (all of them)
  UPDATE journal_entries SET status='posted', posted_at=now(), posted_by=…
COMMIT   ← deferred balance + min-two-lines triggers fire here
```

This makes the immutability rule simple and total:

> **A line may never be INSERTed onto an entry whose status is not `draft`.**

**Replace T-103's posted-immutability trigger accordingly** — it currently blocks UPDATE and
DELETE but not INSERT, which is DEF-031: raw SQL can append a balanced *pair* of lines to a
committed posted entry and change its content without tripping the balance rule.

The T-103 implementer considered blocking INSERT and reverted, because it made building a
posted entry inside one transaction impossible, and noted the only way out looked like an
`xmin` / `txid_current()` trick. **Draft-first ordering removes the need for that entirely** —
no Postgres internals, no transaction-id comparison, no wraparound or subtransaction edge
cases. The ETL constructs historical posted entries the same way: draft, lines, post.

### 3. Idempotency — `idempotencyKey` is required, not optional

`UNIQUE (org_id, idempotency_key)` already exists from T-103. `postEntry` uses it as the
retry guard (bible §4.2 rule 10):

- On conflict, **return the existing entry id with `created: false`.** Do not raise, do not
  write a second entry.
- The key is **required**. A caller that cannot produce a stable key has not thought about what
  happens when its request is retried — and offline replay, webhooks, crons and double-clicks
  all retry.
- Derive it from the source document, e.g. `expense:{id}:post`. **Never** from a timestamp or
  a random value; both defeat the purpose.

### 4. Period resolution — the caller passes a date, never a period id

Resolve the fiscal period containing `entryDate` for that org.

- No period covering the date → reject, naming the date.
- Period exists but is `closed` or `locked` → reject, naming the period and its status.

The database rejects a closed-period posting anyway (T-103). The service resolves first so the
error says *"period 2026-07 is closed"* rather than surfacing a trigger message.

### 5. The repository layer

All journal SQL lives in `packages/db/src/repo/journal.ts` and **nowhere else** (bible §4.3).
The service composes repo calls and owns the transaction; the repo writes SQL and enforces no
business rules.

---

## Invariants the tests must prove

**Posting**
1. A balanced two-line entry posts, and comes back `status='posted'` with `posted_at` set.
2. A three-line entry (one debit, two credits) that balances, posts.
3. An unbalanced entry **rolls the whole transaction back** — no orphan entry row remains.
4. A single-line entry is rejected at COMMIT and leaves nothing behind.
5. An unknown `accountCode` is rejected, and the error **names the code**.
6. A `reserved` account code (2145 / 2250 / 4920) is rejected.
7. A header account code (1000 … 7000) is rejected.

**Idempotency**
8. Posting twice with the same key writes **one** entry; the second returns `created: false`
   with the same `entryId`.
9. Two different keys write two entries.
10. Concurrent posts with the same key produce exactly one entry — no duplicate, no deadlock.

**Period**
11. An `entryDate` in a `closed` period is rejected, naming the period.
12. An `entryDate` in a `locked` period is rejected.
13. An `entryDate` with no covering period is rejected, naming the date.

**DEF-031 — the hole this task closes**
14. **Raw SQL cannot INSERT a line onto an already-posted entry**, even a balanced pair, even
    in a new transaction. This is the regression test for DEF-031 and must fail loudly if the
    trigger is ever relaxed.
15. `postEntry` itself still works — proving the fix did not break the legitimate path.
16. An ETL-style historical post (back-dated into an open period, `postedBy` null) succeeds.

## Out of scope

`reverseEntry` (T-106) · the in/out → debit/credit adapter (T-107) · worked examples (T-108) ·
the ten invariants as a CI suite (T-109) · reporting views (T-110) · any UI · any change to
T-101's or T-102's schema.

## Done when

- [ ] New migration applies cleanly; re-running is a no-op.
- [ ] All 16 invariants pass against real Postgres.
- [ ] `packages/domain` respects the app-boundary rule — a package never imports from `apps/`.
- [ ] Tests live under a `tests/integration/` directory (CI runs unit tests **before**
      migrations, so a DB test outside that path fails on a fresh database).
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green · `build` succeeds.
- [ ] **DEF-031 marked `fixed`** in `docs/DEFECTS-REGISTER.md` with the closing test named.
- [ ] Any spec defect **reported, not silently worked around**.
