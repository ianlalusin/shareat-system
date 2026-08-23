# T-103 — `journal_entries`, `journal_lines`, and the constraint triggers

> **Status:** spec ready. **Depends on:** T-101, T-102 (both done). **Blocks:** T-104, T-105,
> T-107, T-110, T-112 — effectively the rest of Phase 1.
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.

## Goal

Create the ledger tables, and make **the ten invariants true by construction** — enforced by
database constraints and triggers, not by application code that can forget to run.

## Why this is the most important task in Phase 1

Bible §16.0: the legacy ERP treats a **single-leg entry as "trivially balanced"**
(`balancer.ts:64-67`). That one line is the hole the entire project exists to close. Ordinary
expenses and sales post only the balance-sheet side, so there is no revenue or expense leg at
all, and the income statement becomes a hand-maintained scan list.

**After this task, that state is not expressible.** Not discouraged — *impossible*. A single-leg
entry cannot be committed to this schema.

> Application code cannot forget to call a validator, because there is no validator to call.

---

## Scope

Create or modify **only**:

```
packages/db/schema/journal.ts               journal_entries + journal_lines
packages/db/schema/index.ts                 re-export only
packages/db/migrations/*.sql                a NEW migration, hand-augmented
packages/db/tests/integration/journal.test.ts
```

**Do not modify** existing schema files, the seed, or anything under `apps/` or `src/`.
Migrations `0000`–`0002` are applied and are **never edited** (bible §2 rule 8).

---

## Contract

### 1. `journal_entries`

| Column | Notes |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT uuidv7()` |
| `org_id` | FK → organizations, NOT NULL |
| `entry_date` | `date` NOT NULL — the business date the entry belongs to |
| `period_id` | FK → fiscal_periods, NOT NULL |
| `memo` | text |
| `source_type` | text **NOT NULL** |
| `source_id` | text **NOT NULL** |
| `idempotency_key` | text, **UNIQUE per org** |
| `status` | CHECK IN (`'draft'`,`'posted'`,`'reversed'`), default `'draft'` |
| `reversal_of_entry_id` | self-FK, nullable |
| `posted_at`, `posted_by` | timestamptz / FK → persons |
| `created_at`, `updated_at` | per T-101 conventions |

- **`source_type` and `source_id` are NOT NULL** — invariant 4, every posting traces to a
  source document. There are no orphan entries. A system-generated entry still names its
  source; `'system'` is not acceptable as a `source_type` on its own.
- `UNIQUE (org_id, idempotency_key)` where the key is not null — this is how retries, offline
  replays, webhooks and double-clicks are made safe (bible §4.2 rule 10).
- Index `(org_id, entry_date)`, `(source_type, source_id)`, `(period_id)`.

### 2. `journal_lines`

| Column | Notes |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT uuidv7()` |
| `entry_id` | FK → journal_entries **ON DELETE CASCADE**, NOT NULL |
| `line_no` | integer NOT NULL, `UNIQUE (entry_id, line_no)` |
| `account_id` | FK → accounts, NOT NULL |
| `store_id` | FK → stores, **nullable** — not every line is store-scoped |
| `channel_id` | text, **nullable** — the second reporting dimension (bible §13 row 44) |
| `debit` | `numeric(14,2)` NOT NULL DEFAULT 0 |
| `credit` | `numeric(14,2)` NOT NULL DEFAULT 0 |
| `line_memo` | text |

Immediate CHECKs:

```sql
CHECK (debit >= 0 AND credit >= 0)
CHECK ((debit = 0) <> (credit = 0))   -- exactly one side populated, and non-zero
```

> **`channel_id` is included now on purpose.** Bible row 44 already decided revenue is never
> split by channel — the split is a dimension on the line. Adding the column later would be a
> migration against a populated ledger.

Index `(account_id)`, `(entry_id)`, `(store_id)` and `(channel_id)`.

### 3. Enforcement — what mechanism, and why

| Rule | Mechanism | Timing |
|---|---|---|
| `debit >= 0`, `credit >= 0` | `CHECK` | immediate |
| exactly one side populated | `CHECK ((debit = 0) <> (credit = 0))` | immediate |
| **Σ debit = Σ credit per entry** | **`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`** | **at COMMIT** |
| **at least two lines per entry** | same constraint trigger | at COMMIT |
| account is postable **and** active | trigger on `journal_lines` | immediate |
| period is open | trigger | immediate |
| posted entries immutable | trigger blocking UPDATE/DELETE | immediate |

### 4. ⚠️ The landmine — balance MUST be a deferrable constraint trigger

**PostgreSQL does not allow CHECK constraints to be DEFERRABLE.**
`ERROR: CHECK constraints cannot be marked DEFERRABLE`. Only FOREIGN KEY, UNIQUE, PRIMARY KEY,
EXCLUDE and **CONSTRAINT TRIGGERS** can be deferred. Recorded as bible §13 row 65.

This matters because **balance is inherently a multi-row rule**. After the first line is
inserted the entry is legitimately unbalanced; it only has to be correct at COMMIT. So:

- Balance and minimum-two-lines → **one deferrable constraint trigger**, checked at COMMIT.
- Per-row rules → ordinary immediate CHECKs.

A test must prove the entry is **tolerated while unbalanced mid-transaction** and **rejected at
COMMIT**, with the whole unit rolled back. If your implementation rejects the first INSERT, it
is wrong — it would make a multi-line entry impossible to write.

### 5. Account eligibility — a line may only target a real account

Reject at insert if the target account is:

- `is_postable = false` (a header — T-102 seeds seven), **or**
- `status <> 'active'` — T-102 seeds **2145, 2250 and 4920 as `'reserved'`**, and a reserved
  account must not be a posting target until someone activates it.

### 6. Period control — invariant 7

Reject any insert or update of an entry or line whose `period_id` has
`status <> 'open'`. **By every path** — no bypass for migrations, crons, ETL or admin tools.
In v1, 11 of 17 inventory/production paths had no period guard at all.

### 7. Posted immutability — invariant 5

Once `status = 'posted'`:

- **UPDATE** of any financial column on the entry or its lines is rejected.
- **DELETE** of the entry or its lines is rejected.
- Corrections are **reversal entries** — a new, dated, opposite entry pointing at the original
  via `reversal_of_entry_id`. Never an edit. (`reverseEntry` itself is T-106.)

Transitions `draft → posted` and `posted → reversed` remain legal; the guard is on financial
data, not on the status column.

---

## Invariants the tests must prove

Every one asserts the **database** raises the error.

**Balance and shape**
1. A balanced two-line entry commits.
2. A **single-line entry is rejected at COMMIT** — there is no trivially-balanced escape hatch.
3. An unbalanced multi-line entry is rejected at COMMIT.
4. An entry is **legitimately unbalanced mid-transaction** and only fails at COMMIT — insert
   line one, observe no error, then commit and observe the failure.
5. A line with both `debit` and `credit` non-zero is rejected immediately.
6. A line with both zero is rejected immediately.
7. A negative `debit` or `credit` is rejected.
8. `line_no` is unique per entry.

**Eligibility**
9. Posting to a header account (`is_postable = false`) is rejected.
10. Posting to a `'reserved'` account (2145 / 2250 / 4920) is rejected.

**Period**
11. Posting into a `'closed'` period is rejected.
12. Posting into a `'locked'` period is rejected.
13. Posting into an `'open'` period succeeds.

**Immutability and traceability**
14. Updating a posted entry's amount is rejected.
15. Deleting a posted entry is rejected.
16. Deleting a **draft** entry succeeds and cascades its lines.
17. `source_type` / `source_id` cannot be null.
18. A duplicate `(org_id, idempotency_key)` is rejected.
19. Amounts round to the centavo — `numeric(14,2)`, and `0.1 + 0.2` stored and summed returns
    exactly `0.30`.

## Out of scope

`postEntry` / `reverseEntry` service functions (T-105, T-106) · the in/out → debit/credit
builder adapter (T-107) · the ten invariants as a CI suite (T-109) · reporting views (T-110) ·
ETL (T-112+) · any UI.

**This task creates the tables and the guarantees. It does not create the API over them.**

## Done when

- [ ] New migration applies cleanly; re-running is a no-op.
- [ ] All 19 invariants pass against real Postgres.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green · `build` succeeds.
- [ ] The new test file lives under `packages/db/tests/integration/` — a test needing a
      database is not a unit test, and CI runs unit tests **before** migrations.
- [ ] No file outside **Scope** modified.
- [ ] Any spec defect is **reported, not silently worked around**.
