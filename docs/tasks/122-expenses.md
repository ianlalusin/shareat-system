# T-122 — Expenses: the module 88% of the business runs through

> **Status:** spec ready. **Depends on:** T-108 (posting patterns), T-119, T-120 (Wave 0 — both
> done), the capability matrix.
> **Wave 1.** The highest-volume path in the system: `expense_payment`, **4,396 journal legs**.
> **Written by:** Opus planner, 2026-08-25.

## Goal

Let staff record what the business spends, and have it post correctly — every time, including the
messy cases that are the majority rather than the exception.

**This is the first module real pilot users will touch daily.** If it is awkward, they will work
around it, and a workaround in an expense system is a hole in the books.

---

## What the capture actually says about this module

Not guesses — measured from v1 on 2026-08-24:

| | |
|---|---|
| **4,396 journal legs** from `expense_payment` | The largest single source of ledger activity |
| **6,007 expense documents** across four stores | ~25 per store per trading day |
| **Split payments are normal, not exceptional** | One expense, several payment methods, several credit lines |
| **132 expense categories** in the live list | Two-level, both free text, with real data-quality problems (discovery 08 §5) |

**Design for the messy case.** A module that handles a single cash payment cleanly and makes a
three-way split painful has optimised for the minority.

---

## Scope

Create or modify **only**:

```
packages/db/schema/expenses.ts                  expenses + expense_payments + categories
packages/db/migrations/00NN_*.sql               a NEW migration — DEF-039 applies
packages/db/src/cutover/classification.ts       classify the new tables (build FAILS otherwise)
packages/db/src/rls/registry.ts                 declare their scoping (build FAILS otherwise)
packages/db/src/repo/expenses.ts                the ONLY place expense SQL lives
packages/domain/src/expenses/*.ts               create / approve / void, posting via postEntry
apps/erp/src/app/expenses/**                    the screens
packages/domain/tests/integration/expenses.test.ts
```

> ⭐ **The two registry files are not optional and not an afterthought.** Wave 0 exists precisely so
> that a new table cannot be added without answering *"does it survive the cutover?"* and *"how is
> it org-scoped?"*. **The build will fail until both are answered** — that is the design working,
> not an obstacle.

**Do not modify** `postEntry`, `reverseEntry`, the ledger schema, `packages/etl/**`, or migrations
`0000`–`0011`. **Do not touch `PROJECT_BIBLE.md`.**

---

## Contract

### 1. The shape, taken from what v1 proved it needs

```
expenses
  id, org_id, store_id, business_date, total_amount
  supplier_id?          -- party, when it is a supplier purchase
  category_id           -- see §3
  particulars           -- free text; what it was actually for
  receipt_photo_url?    -- see §4
  status                -- draft | posted | voided
  created_by, approved_by?, posted_at?

expense_payments        -- ONE expense, MANY payments. This is the normal case
  id, expense_id, method, amount
  account_id?           -- which cash/bank account
  staff_id?             -- reimbursable: who is owed
  cash_request_id?      -- when it draws on a released cash request
```

**Payment methods**, from v1: `cash · online · credit · reimbursable · ar_collection · other`.
Each posts a different credit line — `POSTING-PATTERNS.md` has all of them worked, and **that
document is the authority, not this spec.**

### 2. It posts through `postEntry`, and only through it

The expense document is the source; the entry is derived. **No expense screen writes
`journal_lines`.**

- `idempotencyKey` = `expense:{id}:post` — derived from the document, never from a timestamp.
- The split becomes **one entry with several credit lines**, not several entries. It is one
  business event.
- A **reimbursable** payment credits `2130` **with the staff member as the party** (T-118 /
  DEF-049). Without a party the trigger rejects it — correctly.

### 3. ⚠️ Categories: v1's list has real problems, and importing it blindly imports them

Discovery 08 found **132 entries, two-level, both levels free text**, with duplicates and
inconsistent casing (§5). The COA crosswalk exists (`leg-mapping.ts`, T-113) and DEF-035 added the
17 missing accounts.

**Do not free-text the category.** A category is a **row with an account mapping** — that is what
makes an expense post to the right place without a human deciding each time.

**Unmapped is a first-class state**, not an error: a category with no account **blocks posting**
with a clear message rather than silently landing in a catch-all. *Silently landing in
`6900 Other` is how a P&L becomes uninformative one expense at a time.*

### 4. The receipt-photo gate — Ian's existing rule

An **external** receipt requires a photo before posting. This is a real v1 control and it carries
forward.

**Enforce it server-side at post, not in the form.** A form check is a convenience; the control is
that an expense without a photo cannot reach `posted`.

### 5. Editing, and the 48-hour window

v1 gives a cashier **48 hours to edit their own** expense (`policy.ts:80-90`). Preserve it: it is
the mechanism that stops staff needing a manager for a typo, which is what keeps the manager
available for things that matter.

- `edit_own_expense` — creator, within the window, **draft only**.
- `edit_any_expense` — manager and above.
- **A posted expense is never edited.** It is voided and re-entered, and the void reverses the
  entry via `reverseEntry` (T-106). Same discipline as the ledger, for the same reason.

### 6. Capabilities — from the matrix, enforced server-side

`create_expense` staff · `edit_own_expense` staff, time-boxed · `edit_any_expense` manager ·
`approve_expense` manager · `void_expense` manager. **Every one needs a test proving the denial
fires** (DEF-051, DEF-052 are both permissions that permitted nothing).

---

## Invariants the tests must prove

**Posting**
1. A single-payment cash expense posts exactly the lines `POSTING-PATTERNS.md` declares.
2. **A three-way split posts ONE entry with three credit lines** — not three entries.
3. A reimbursable payment credits `2130` carrying the staff party; **without the party it is
   rejected**.
4. Re-posting the same expense is idempotent — one entry, `created: false` on the second call.
5. A voided expense reverses through `reverseEntry`, and every account nets to zero.

**Categories**
6. A mapped category routes to its declared account.
7. **An unmapped category BLOCKS posting with a named message** — it never falls back to `6900`.

**Controls**
8. An external expense **without a photo cannot reach `posted`** — enforced server-side, proven by
   calling the service directly rather than through the form.
9. The creator can edit their own draft inside 48 hours; **outside it, they cannot**.
10. A posted expense **cannot be edited by anyone**, including an admin.
11. Each capability's **denial** fires for a role that lacks it.

**Wave 0 still holds**
12. The new tables are classified for cutover and declared in the RLS registry — **both guards
    pass, and both were seen failing first.**
13. An expense created in org A is **invisible to org B**, with no `WHERE org_id` written anywhere
    in the query.

## Out of scope

Recurring expenses and budgets (ADR-005's *"can wait past January"*) · AP invoices and payments
(T-130) · approval chains beyond a single approver · OCR · any change to `postEntry`.

## Done when

- [ ] All 13 invariants pass against real Postgres.
- [ ] Migration applies; `migration-journal.test.ts` **run immediately after generating it**.
- [ ] `typecheck` · `test` · `test:integration` green · `build` succeeds.
- [ ] ⭐ **Smoketested in the running app on 9008** — create a split-payment expense, post it, void
      it, and confirm the trial balance still ties. *Not tickable from a terminal.*
- [ ] Any spec defect **reported, not silently worked around**.

> **The test of this module is not that it posts correctly. It is that a cashier at 11pm, with a
> handful of receipts and three payment methods, finds it faster than the paper it replaces.**
