# T-122 — Expenses: non-inventory spend

> **Status:** ⚠️ **REVISED 2026-08-25.** The first version was wrong in scope: it treated an
> expense as standalone when a third are delivery-linked, and it inherited the GRNI design Ian
> then simplified away. **Rewritten against bible rows 118–120.**
> **Depends on:** T-119, T-120, **T-121** (all done — T-121 was missing from v1 of this spec, DEF-053).
> **Wave 1.**

## What changed, and why the scope is smaller

Two decisions since the first draft:

**A delivery books AP directly at receipt** (row 119). No GRNI, no delivery→expense link, no
`isExpensed` flags. So a delivery is **a purchase in its own right**, and an expense is **a
non-inventory spend**. Two document types for two different things, rather than one bolted onto
the other.

**Which means deliveries are not in this task.** A delivery posts `DR Inventory / CR AP`, and the
inventory asset does not exist until Phase 3. Building deliveries now would force them to post
purchase-basis COGS — reproducing the exact defect the rebuild exists to correct.

| | Documents | Where |
|---|---:|---|
| Delivery-linked (become **deliveries**) | **2,272 — 36%** | **Phase 3**, with inventory |
| **Non-inventory spend** | **3,954 — 64%** | **This task** |

**Deliveries keep running in v1 through the pilot.** That is what the rolling pilot is for
(row 113) — nothing breaks, because v1 is live until 31 December regardless.

### The scope, measured

| Group | Docs | Posts to |
|---|---:|---|
| OPEX | 2,873 | 6xxx |
| **COGS without a delivery** | **801** | 5xxx — see the flag below |
| PERSONAL | 181 | **3200 owner's drawings** — contra-equity, not an expense |
| CAPEX | 37 | 15xx asset, not a P&L line |
| *(unset)* | 62 | **Blocks** — an expense with no group cannot be routed |

> ⚠️ **The 801 COGS-without-a-delivery are a known simplification, recorded rather than hidden.**
> They are food bought outside the delivery flow — market runs, top-ups — and in this task they
> post purchase-basis (`DR 5100 / CR cash`), exactly as v1 does. **That is the very timing defect
> the rebuild corrects**, and it is accepted here only because the alternative is stalling 64% of
> the module on Phase 3. **Phase 3 must revisit them:** ideally they create an inventory receipt
> like any other purchase.

---

## Scope

```
packages/db/schema/expenses.ts                  expenses · expense_payments · expense_categories
packages/db/migrations/00NN_*.sql               + RLS policies for each new table
packages/db/src/cutover/classification.ts       classify all three (build FAILS otherwise)
packages/db/src/rls/registry.ts                 declare scoping (build FAILS otherwise)
packages/db/src/repo/expenses.ts                the ONLY place expense SQL lives
packages/domain/src/expenses/*.ts               create · approve · void, posting via postEntry
apps/erp/src/app/expenses/**                    the screens
packages/domain/tests/integration/expenses.test.ts
```

**Do not modify** `postEntry`, `reverseEntry`, the ledger schema, `packages/auth/**`,
`packages/etl/**`, or migrations `0000`–`0014`. **Do not touch `PROJECT_BIBLE.md`.**

**No `delivery_id` column.** A delivery is a different document (Phase 3), not a flavour of this
one. Adding a nullable link "for later" invites someone to use it.

---

## Contract

### 1. Shape

```
expenses
  id, org_id, store_id, business_date, total_amount
  category_id       -> expense_categories
  supplier_id?      -- opaque text; no suppliers table until Wave 3
  particulars       -- what it was actually for
  receipt_photo_url?
  status            -- draft | posted | voided
  journal_entry_id? -- set on post
  created_by, approved_by?, posted_at?, voided_by?/at?/reason?

expense_payments    -- ONE expense, MANY payments. The normal case, not the exception
  id, expense_id, method, amount, account_code?, staff_id?, cash_request_id?

expense_categories
  id, org_id, group, category, sub_category, account_code?  -- NULLABLE on purpose (§3)
```

### 2. Posting — through `postEntry`, always

`idempotencyKey` = `expense:{id}:post`. A split posts **one entry with several credit lines** —
it is one business event. Reimbursable credits **2130 with the staff party**; without it the
trigger rejects the line, correctly (DEF-049).

**Funding accounts mirror `leg-mapping.ts` exactly** — cash→1110 (1120 when a `cash_request_id`
is present), online→1140, credit→2110 with the supplier party. **Do not re-derive them**; a second
copy of a mapping is a second source of truth.

### 3. ⚠️ Two payment methods have NO account, and never did — DEF-054

`other` and `ar_collection` appear in v1's data. **`convert.ts` already quarantines both** as
`unimplemented_payment_method`, and `POSTING-PATTERNS.md` has worked examples for only `cash`,
`online`, `credit` and `reimbursable`.

**They are accepted on the document and BLOCK posting**, with a named message — exactly as an
unmapped category does. **An unmappable payment is the same defect as an unmappable category and
gets the same treatment**, not a silent drop from the enum. Ian will decide whether they need real
mappings or should be retired.

### 4. Categories: mapped, or it does not post — and never a fallback

Seed from the **already-decided crosswalk** in `leg-mapping.ts`, not from v1's 132 free-text
entries with their duplicates and inconsistent casing (discovery 08 §5).

`account_code` is **nullable**, and null **blocks posting** with a clear message.

> **Never fall back to `6900 Other`.** Silently routing an unknown category to a catch-all is how
> a P&L becomes uninformative one expense at a time — and nobody ever notices, because the books
> still balance.

`PERSONAL` routes to **3200 owner's drawings** (contra-equity, bible row 39) and `CAPEX` to a
**15xx asset**. Neither is a P&L expense, and getting either wrong overstates costs.

### 5. The receipt-photo gate — DEF-055, now defined

The original rule said *"an **external** receipt requires a photo"* with nothing defining
"external". In v1 that distinction lives on a `Receipt` entity this task does not carry forward.

**Definition adopted: every expense recorded through this module is external.** Internal movement
is a delivery or a transfer, neither of which is an expense here. **So the gate is simply: no
photo, no posting.**

**Enforced server-side at post, never in the form.** A form check is a convenience; the control is
that an expense without a photo cannot reach `posted`.

### 6. Capabilities — `authorize()` exists now, so use it

`create_expense` · `edit_own_expense` (creator, **48h**, draft only) · `edit_any_expense` ·
`approve_expense` · `void_expense`.

Call `authorize()` from `@shareat/auth` at **every mutation**. It throws. **Each of the five needs
a test proving the denial fires** — v1 shipped two permissions that permitted nothing (DEF-051,
DEF-052).

### 7. Void, never edit

A posted expense is **never** edited. It is voided, and the void **reverses the entry through
`reverseEntry`** — same discipline as the ledger, for the same reason. The 48-hour window applies
to **drafts only**.

---

## Invariants

**Posting**
1. A single cash expense posts exactly the lines `POSTING-PATTERNS.md` declares.
2. **A three-way split posts ONE entry with three credit lines**, not three entries.
3. Reimbursable credits 2130 with the staff party; **without the party it is rejected**.
4. Re-posting is idempotent — one entry, `created: false` on the second call.
5. A void reverses through `reverseEntry` and every account nets to exactly zero.

**Routing**
6. A mapped category routes to its declared account.
7. **An unmapped category BLOCKS, naming the category.** It never reaches `6900`.
8. `PERSONAL` routes to **3200**, not to an expense account.
9. `CAPEX` routes to a **15xx asset**, not to a P&L line.
10. **`other` and `ar_collection` BLOCK posting** with a named reason (DEF-054).

**Controls**
11. **No photo, no posting** — proven by calling the service directly, not through the form.
12. The creator edits their own draft inside 48h; outside it, they cannot.
13. A posted expense cannot be edited by anyone, **including an admin**.
14. **Each of the five capabilities denies a role that lacks it.**

**Wave 0 holds**
15. All three tables classified for cutover and declared in the RLS registry — **both guards seen
    failing first**.
16. An expense in org A is invisible to org B, **with no `WHERE org_id` written anywhere**.

## Out of scope

**Deliveries and anything inventory-valued (Phase 3)** · AP invoices and payments (T-130) ·
recurring expenses and budgets · approval chains beyond one approver · OCR · any change to
`postEntry`, `reverseEntry` or `@shareat/auth`.

## Done when

- [ ] All 16 invariants pass against real Postgres.
- [ ] Migration applies; `migration-journal.test.ts` **run immediately after generating it**.
- [ ] `typecheck` · `test` · `test:integration` green, **every pre-existing test still passing** ·
      `build` succeeds (check port 9008 first; skip and **say so** if a dev server is live).
- [ ] ⭐ **Smoketested on 9008** — create a split-payment expense, post it, void it, confirm the
      trial balance still ties. *Not tickable from a terminal.*
- [ ] Any spec defect **reported, not silently worked around**. *This spec has already had four.*
