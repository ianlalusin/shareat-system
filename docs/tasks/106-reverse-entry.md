# T-106 — `reverseEntry`: corrections as new entries, never edits

> **Status:** ✅ **COMPLETE 2026-08-23** — 19/19 invariants + 2 extra. §5 solved with a
> transaction-local GUC, not the mechanism I suggested. Found and fixed DEF-036 on the way.
> **Was:** spec ready. **Depends on:** T-103, T-105 (both done).
> **Blocks:** T-107, T-108, T-109, T-112 (the ETL needs to unwind a bad load).
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.

## Goal

One function that unwinds a posted entry by writing its exact opposite — so a correction is a
new, dated, traceable fact rather than a quiet edit to history.

## Why this is small, and why that is the point

T-103 and T-105 already made the *wrong* way impossible: a posted entry cannot be updated,
deleted, or have lines appended. **T-106 does not add a prohibition. It makes the only
remaining path convenient**, which is what stops people looking for a way around it.

> Invariant 5: *posted entries are immutable; corrections are reversal entries, never edits.*
> The legacy system is inconsistent here — it flips a status in place and mutates the original
> row, so the original amount is simply gone (bible §16.0, discovery 06 §1.2).

---

## Scope

Create or modify **only**:

```
packages/domain/src/ledger/reverse-entry.ts
packages/domain/src/index.ts                      re-export
packages/db/src/repo/journal.ts                   extend — still the ONLY place journal SQL lives
packages/db/migrations/*.sql                      a NEW migration, only if §5 requires one
packages/domain/tests/integration/reverse-entry.test.ts
```

**Do not modify** `packages/db/schema/*`, the seed, `packages/core/*`, `postEntry`, or anything
under `apps/`. Migrations `0000`–`0004` are applied and are **never edited**.

**Do not touch `PROJECT_BIBLE.md`** — §14 reserves amendments to the planner. Report instead.

---

## Contract

### 1. Signature

```ts
reverseEntry(tx, {
  entryId,                   // the posted entry to unwind
  reason,                    // REQUIRED — see §3
  reversalDate?,             // defaults per §4
  reversedBy?,
  idempotencyKey?,           // defaults to `reverse:{entryId}`
}) → { reversalEntryId, created: boolean }
```

### 2. What it writes

A **new** entry whose lines are the exact mirror of the original: same accounts, same
`store_id`, same `channel_id`, same amounts, with **`debit` and `credit` swapped**.

- The reversal is built with T-105's ordering — **draft → lines → posted**. Reuse `postEntry`
  rather than re-implementing it.
- `reversal_of_entry_id` on the new entry points at the original.
- `source_type` / `source_id` are **inherited from the original**, so both halves of the
  correction trace to the same source document (invariant 4).
- The original transitions `posted → reversed`. T-103 already permits exactly that transition
  and no other mutation.

**Both entries remain in the ledger, forever.** Nothing is deleted, nothing is amended.

### 3. `reason` is required

A reversal without a stated reason is an untraceable hole in the audit trail. Reject an empty
or whitespace-only reason. It is stored on the reversal's `memo`.

### 4. Which period the reversal posts to

| Original's period | Reversal date |
|---|---|
| **open** | Defaults to the **original's `entry_date`** — same period, cleanest reading |
| **closed or locked** | Caller **must** supply a `reversalDate` in an open period |

A closed period is closed. **Never backdate into it** — bible period handling is explicit:
prior-period corrections post to the current open period, they do not reopen the past. When
this happens, the reversal's memo is prefixed **`[prior period]`** so the classification is
visible in the ledger itself rather than inferred from dates.

### 5. ⚠️ An entry must ALWAYS be reversible

T-103's account-eligibility trigger rejects a line targeting a non-`active` account. That is
correct for new postings and **wrong for a reversal**: an account that was active when the
original posted may since have been archived or reserved.

**An entry that cannot be unwound is a trap** — it leaves a wrong number permanently in the
books with no legal way to correct it.

So a reversal line must be permitted to target a **postable but non-active** account. It must
still be rejected for a **non-postable** account (a header was never postable, so no original
line could have targeted one).

The mechanism is the implementer's call — a trigger exemption keyed on
`reversal_of_entry_id IS NOT NULL` is the obvious one. **If it requires a migration, write a
new one.** Do not weaken the rule for ordinary postings to make this easier.

### 6. What cannot be reversed

| State | Result |
|---|---|
| `posted` | ✅ reversed |
| `draft` | ❌ rejected — nothing has been asserted yet; delete it instead |
| `reversed` | ❌ rejected — already unwound; naming the existing reversal |
| A reversal entry (itself `posted`) | ✅ **allowed** — undoing an erroneous reversal is legitimate |

### 7. Idempotency

Defaults to `reverse:{entryId}`, so a retried reversal returns the existing one with
`created: false` rather than double-reversing. Double-reversal is the single most damaging
failure mode here: it silently re-applies the original amount.

---

## Invariants the tests must prove

**Shape**
1. Reversing a posted entry creates a new entry with debit and credit swapped on every line.
2. Accounts, `store_id`, `channel_id` and amounts are identical to the original.
3. `reversal_of_entry_id` points at the original; `source_type`/`source_id` are inherited.
4. The original's status becomes `reversed`; the reversal's status is `posted`.
5. **For every account touched, original + reversal sum to exactly zero.**
6. Both entries still exist afterwards — nothing deleted, no amount changed on the original.

**Guards**
7. Reversing a `draft` entry is rejected.
8. Reversing an already-`reversed` entry is rejected, naming the existing reversal.
9. Reversing a reversal succeeds.
10. An empty or whitespace-only `reason` is rejected.

**Period**
11. Original in an open period, no `reversalDate` given → reversal posts on the original's date.
12. Original's period **closed**, no `reversalDate` → rejected, telling the caller to supply one.
13. Original's period closed, `reversalDate` in an open period → posts there, memo prefixed
    `[prior period]`.
14. A `reversalDate` in a closed period is rejected.

**Always reversible — §5**
15. **An entry whose account has since been set `reserved` is still reversible.**
16. **An entry whose account has since been `archived` is still reversible.**
17. An ordinary (non-reversal) posting to that same non-active account is **still rejected** —
    proving the exemption did not leak.

**Idempotency and immutability**
18. Reversing twice returns the same `reversalEntryId` with `created: false`, and the account
    balances are unchanged by the second call.
19. The reversal's own lines are immutable — raw SQL cannot INSERT, UPDATE or DELETE them
    (DEF-031's guarantee must hold for reversals too).

## Out of scope

The in/out → debit/credit adapter (T-107) · worked examples (T-108) · the ten invariants as a
CI suite (T-109) · reporting views (T-110) · any UI · any change to T-101/T-102 schema · void
semantics (a void is a *document* concept and is not the same as a reversal — see the glossary).

## Done when

- [ ] All 19 invariants pass against real Postgres.
- [ ] Any new migration applies cleanly; re-running is a no-op.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green (**all 111 existing
      tests still pass**) · `build` succeeds.
- [ ] `reverseEntry` reuses `postEntry` rather than duplicating its ordering logic.
- [ ] Any spec defect **reported, not silently worked around**.


---

## Implementation notes — resolved 2026-08-23

**1. My suggested §5 mechanism does not work; the implementer found a better one.**
I proposed exempting the eligibility trigger on `reversal_of_entry_id IS NOT NULL`. That column
**cannot be populated before the reversal's lines are inserted** — `postEntry` has no field for
it, and by the time `postEntry` returns the entry is already `posted` and frozen. There is no
reachable moment in between without either editing `postEntry` (forbidden) or hand-rolling a
second posting path (forbidden).

The implementation uses a **transaction-local GUC** instead:
`set_config('app.reversal_posting', 'on', true)`. It is cleared automatically at commit or
rollback, is invisible to any other transaction, and survives connection pooling safely
because the `true` flag scopes it to the transaction rather than the session.

`is_postable` stays enforced **unconditionally** — a header account is rejected even with the
GUC set. Only the `status <> 'active'` check is skipped.

**2. My "only if §5 requires one" was wrong — §2 forces a migration by itself.**
`reverseEntry` must backfill `reversal_of_entry_id` *after* `postEntry` returns, and T-103's
immutability trigger freezes every column of a posted entry. Migration `0005` adds one narrow
additive exception: a posted entry may have `reversal_of_entry_id` set exactly once
(`NULL` → a value), with nothing else changing in that statement, gated on `posted.created` so
an idempotency-race loser never double-processes.

**3. It found a dormant hole outside its own contract — DEF-036.**
Migration `0004` froze lines only when `entry_status = 'posted'`. Nothing had ever produced a
`'reversed'` entry, so it was dormant — and T-106 would have created the first one, leaving
**the original's own lines mutable the instant it was reversed**, breaking invariant 6. Fixed
in `0005` with `entry_status IN ('posted','reversed')`, covered by an extra test.

> **The general lesson, recorded as bible §13 row 95:** a guard written against the states that
> exist today silently stops guarding when a new state is introduced.
