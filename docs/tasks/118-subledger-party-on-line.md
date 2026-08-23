# T-118 — The subledger: `party_type` + `party_id` on the journal line

> **Status:** spec ready. **Depends on:** T-103, T-105 (done). **Blocks:** Phase 2's first AP
> or AR posting. **Closes:** DEF-037. **Decided by Ian:** bible §13 row 98.
> **Written by:** Opus planner, 2026-08-23.

## Goal

Give a journal line a counterparty, so the AP and AR subledgers exist and **invariant 6 becomes
satisfiable** — *"subsidiary ledgers reconcile to control accounts."*

## Why now, and why on the line

COA-ALIGNMENT specifies **2110 AP — CONTROL + supplier subledger** and **1210 AR — CONTROL +
customer subledger**. Neither subledger exists. A line posting to 2110 **cannot say which
supplier it is for**, so invariant 6's *"AR detail total = AR control balance"* has no detail
to total.

Both ERPNext and Odoo put the counterparty **on the journal line** rather than in a parallel
table (`docs/discovery/17`). That is the cheaper shape: the subledger becomes a `GROUP BY` over
`journal_lines`, not a second structure that has to be kept in step with the ledger — and
"kept in step by hand" is precisely the dual-writer failure this project exists to remove.

**This is cheap today and expensive the moment Phase 2 posts its first AP line.**

---

## Scope

Create or modify **only**:

```
packages/db/schema/journal.ts        add party_type, party_id
packages/db/schema/accounts.ts       add requires_party
packages/db/seed/chart-of-accounts.ts  flag the party-requiring accounts
packages/db/migrations/*.sql         a NEW migration
packages/db/tests/integration/journal.test.ts        extend
packages/db/tests/integration/chart-of-accounts.test.ts  extend
```

Do **not** modify `postEntry`, `reverseEntry`, the adapter, `packages/etl/**`, or anything
under `apps/`. Migrations `0000`–`0006` are applied and **never edited**.
**Do not touch `PROJECT_BIBLE.md`** (§14).

---

## Contract

### 1. `journal_lines` gains two columns

| Column | |
|---|---|
| `party_type` | text, **nullable**, `CHECK IN ('supplier','customer','employee','store','channel')` |
| `party_id` | text, **nullable** |

`CHECK ((party_type IS NULL) = (party_id IS NULL))` — both or neither, never one.

Index `(party_type, party_id)` — this is what makes a subledger query fast, and it is the whole
point of the column.

### 2. `accounts` gains `requires_party`

`boolean NOT NULL DEFAULT false`. **This is what makes invariant 6 enforceable rather than
hoped for.**

Seed these as `true` — every account COA-ALIGNMENT describes as a control account:

| Code | Party type it expects |
|---|---|
| 2110 Accounts payable | supplier |
| 1210 Accounts receivable | customer |
| 1220 Channel receivable | channel |
| 1230 Advances to employees | employee |
| 1240 Advances to suppliers | supplier |
| 2130 Reimbursements payable | employee |
| 1250 Due from related store | store |
| 2150 Due to related store | store |
| 2400 Loans payable | supplier *(the lender)* |

> The expected type is **documentation, not a constraint** in this task. Enforcing
> *which* type belongs to *which* account needs the party tables that arrive in Phase 2.
> Do not invent that enforcement now.

### 3. The trigger — both directions

On INSERT or UPDATE of `journal_lines`:

- Account has `requires_party = true` and the line has **no** party → **reject**, naming the
  account code.
- Account has `requires_party = false` and the line **has** a party → **reject**. A party on a
  cash or expense line is a data-modelling mistake, and silently allowing it makes the
  subledger untrustworthy in the other direction.

### 4. ⚠️ `party_id` has no foreign key yet — deliberate, and temporary

Bible §4.2 rule 3 says foreign keys are always declared. **This is a recorded exception**: the
`suppliers`, `customers` and `channels` tables arrive in Phase 2, and `party_id` cannot
reference tables that do not exist.

**Report this in your task report** so the planner records it as a temporary divergence.
Phase 2 tightens it — either a real FK per type or a validating trigger. Do **not** invent a
`parties` table to work around it: `stores` and `persons` already exist, and duplicating them
into a generic party table would create exactly the second source of truth this project removes.

### 5. Existing rows

There are none in production — the chart seeds per-org and no org exists. The columns are
nullable, so the migration needs no backfill. **Say so explicitly** rather than writing a
backfill nothing needs.

---

## Invariants the tests must prove

1. A line with `party_type` and `party_id` on a party-requiring account posts.
2. A line on a party-requiring account **without** a party is **rejected**, naming the account.
3. A line with a party on an account that does **not** require one is **rejected**.
4. `party_type` alone, or `party_id` alone, is rejected by the CHECK.
5. An invalid `party_type` value is rejected.
6. An ordinary line (cash, expense) with neither continues to post — **no regression**.
7. All nine accounts in §2 are seeded `requires_party = true`; every other account is `false`.
8. **The subledger query works**: post three AP lines for two suppliers, then
   `GROUP BY party_id` over `journal_lines` and assert the per-supplier totals **sum exactly to
   the 2110 control balance**. *This is invariant 6, demonstrated — the point of the task.*
9. Re-running the migration is a no-op.

## Done when

- [ ] All 9 invariants pass against real Postgres.
- [ ] **All 185 existing integration tests and 204 unit tests still pass.**
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green · `build` succeeds.
- [ ] **DEF-037 marked `fixed`** in `docs/DEFECTS-REGISTER.md`, naming invariant 8 as the closer.
- [ ] The missing-FK exception (§4) **reported** for the planner to record.
- [ ] Any spec defect **reported, not silently worked around**.
