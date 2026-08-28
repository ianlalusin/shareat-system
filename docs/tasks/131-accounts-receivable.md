# T-131 — Accounts receivable: charges, collections, allocation, aging, write-off

> **Status:** Spec written 2026-08-28 by the Opus planner, implemented same session.
> **Depends on:** T-129 (`customers`, `balanceOf` from `1210`), T-130 (the AP shape this mirrors),
> bible row 162 (aging by due date, landed today).
> **Blocks:** T-132 (wholesale orders — the document that produces a charge).
> **Assessed before specced**, per bible row 163. The assessment cut the task roughly in half; the
> evidence for each cut is below.

## Grounding — v1, measured (read as requirements, bible §1.2b)

A read of `ERP-rebuild`'s AR code **and a count of its live production data**. Every number here
was queried, not estimated.

| | |
|---|---|
| `arTransactions` | **833** — paid 639, unpaid 151, voided 39, written-off 2, partial 1, **`open` 1** (a status outside its own declared union) |
| `arCollections` | **512** |
| ⭐ Collections that are actually **delivery-platform settlements** | **381 of 512 (74%)** |
| Collections with >1 allocation | 27 |
| Collections with money left unallocated | **38 (7.4%)**, and v1 has no way to re-apply it |
| Collections with `overageAmount > 0` | **0 — the store-credit path has never fired** |
| `verifiedByUid` actually set | **1 of 512**, and that row was written outside the app |
| Receivables whose stored `outstandingAmount` disagrees with its own inputs | **106 of 794 (13.3%)** |
| Write-offs ever performed | 2, both ₱1,000, admin-only |

### What v1 gets right, and is ported

- **Write-off posts real, balanced legs** (`Dr 6860 bad debt / Cr 1210`), is **admin-only** —
  stricter than its manager-level void — supports repeated partial write-offs, and stamps reason,
  time and author. This is the best-controlled path in v1's AR and it is ported as-is.
- **Proof of payment is enforced server-side for online collections** and not for cash
  (`ar-collection.actions.ts`). A real rule, kept.
- **The platform fee is booked once, inside the collection** — `POSTING-PATTERNS.md`'s
  `ar_collection.with-platform-fee`, 176 verified legs. ⛔ v1 once booked it **twice** and it cost
  **₱198,148.29** across two stores, 37 duplicate expense documents voided. The pattern exists to
  make that structurally impossible; a module that posts this collection *and* lets someone
  expense the same fee separately has reintroduced the bug.

### What v1 gets wrong, and is corrected

1. ⛔ **`pending_verification` is a dead end.** A collection recorded by a cashier is set to
   `pending_verification`, `applyArCollection` requires `verified`, and **nothing in the entire
   repo ever performs that transition** — there is no verify button on the detail page and no
   code path that writes the status. `verified` in practice means *"a manager created it"*:
   self-certified at creation, with `verifiedByUid` left null 511 times out of 512.
2. ⛔ **No second-party control anywhere in AR.** No `createdByUid`/actor comparison exists in any
   AR action. A lone manager creates a collection, has it auto-stamped verified in the same call,
   allocates it and applies it — with no verifier recorded. (v1's *attendance* module has a
   self-dealing guard and a test for it; AR has neither.)
3. ⛔ **`collectedAmount` means two different things.** For an ordinary collection it is the sum of
   allocations; for a channel settlement it is the **net deposit after loan deductions**. Same
   field, incompatible semantics, and it is the direct cause of the 13.3% drift — 105 of the 106
   drifting rows are channel receivables.
4. **Unallocated cash has no way back.** `unallocatedAmount` is set once and never re-applied;
   38 collections hold money tied to nothing.
5. **`overageAsStoreCredit` is cosmetic** — a boolean stamped from a client-supplied number, with
   **no store-credit balance anywhere in the schema** (`grep storeCredit` → zero hits).
6. **Client-supplied totals go unchecked.** `totalBillAmount`, `amountPaid` and `creditAmount`
   arrive as three independent numbers and the server never verifies that the third is the
   difference of the first two. 0/833 drift today — caller discipline, not enforcement.

## The assessment — what this task deliberately is NOT

⭐ **74% of what v1 calls an "AR collection" is a delivery-platform settlement**, written by a
completely different action (`recordChannelSettlementAction`), carrying an untyped parallel field
set (`feeBreakdown` with commission/marketing/vat/wht/penalty/variance, `settlementGain`,
`loanDeduction`, `netDeposited`), and bypassing the collection flow entirely.

**Building both in one task would either rebuild that conflation or leave three-quarters of the
volume unhandled.** So:

- **T-131 (this task)** — a customer owes money, pays it, and the payment is matched to what it
  settles. Including a *simple* platform fee, because `POSTING-PATTERNS.md` already verifies that
  three-leg shape and it is what stops the ₱198k double-count.
- **⛔ Channel settlement is its own task, and has no number yet** — the seven-way fee breakdown,
  settlement gain, loan deductions out of a payout, and auto-creating channel receivables from a
  verified sales day. **It is not on the roadmap and nothing owns it.** Raised for Ian.

## Contract

### 1. `ar_charges` — a customer owes us money

```
ar_charges
  id                   uuid PK default uuidv7()
  org_id               uuid NOT NULL FK organizations, restrict
  store_id             uuid NOT NULL FK stores, restrict
  customer_id          uuid NOT NULL FK customers, restrict
  charge_date          date NOT NULL
  due_date             date                    -- aging falls back to charge_date (row 162)
  reference_no         text
  notes                text
  total_amount         numeric(14,2) NOT NULL, check > 0
  revenue_account_code text NOT NULL           -- which income account this sale credits
  status               text NOT NULL default 'draft', check in ('draft','posted','voided')
  journal_entry_id     uuid FK journal_entries, restrict
  created_by           uuid NOT NULL FK persons, restrict
  posted_at            timestamptz
  voided_by/at/reason
  written_off_amount   -- ⛔ NO. See invariants.
```

⭐ **`revenue_account_code` is explicit, not guessed.** A credit sale books
`Dr 1210 (party=customer) / Cr <income>`, and the sales-day router **refuses credit sales
outright** — *"credit sales belong to AR (T-131), not to a daily summary"* — so nothing else
books this revenue. There is no wholesale-revenue account in the chart today; rather than invent
one, the charge names an existing income account and the choice is visible. ⚠️ **Flagged for Ian:**
if wholesale needs its own account, that is a chart decision, not an implementation detail.

### 2. `ar_collections` / `ar_collection_allocations`

```
ar_collections
  id                uuid PK · org_id · store_id · customer_id
  collection_date   date NOT NULL
  amount            numeric(14,2) NOT NULL, check > 0     -- gross receivable cleared
  platform_fee      numeric(14,2) NOT NULL default 0, check >= 0
  money_account_id  uuid NOT NULL FK money_accounts       -- where the NET landed
  reference_no · notes
  receipt_file_id   uuid FK stored_files                  -- required for online (v1's rule)
  status            text NOT NULL default 'draft', check in ('draft','posted','voided')
  journal_entry_id · created_by · posted_at · voided_*

ar_collection_allocations
  id · ar_collection_id (cascade) · ar_charge_id (restrict) · amount_applied (>0)
  unique (ar_collection_id, ar_charge_id)
```

**Posting — `POSTING-PATTERNS.md` `ar_collection`, ported exactly:**

| | with fee | no fee |
|---|---|---|
| money account | Dr `amount − platform_fee` | Dr `amount` |
| `6400` platform fees | Dr `platform_fee` | *absent entirely* |
| `1210` | Cr `amount`, party=customer | Cr `amount`, party=customer |

⛔ **The fee is booked HERE and nowhere else.** Never also as an expense document for the same
settlement — that is the ₱198,148.29 defect.

### 3. Allocation, and what happens to a surplus

Mirrors `recordPayment` (T-130) deliberately, including its lock:

1. Allocations name `ar_charges` that are **posted, this customer's, this store's, and still
   open**. Any failure rejects the whole collection — no partial apply.
2. `lockChargesForAllocation` takes a row lock **before** balances are read. Without it two
   collections both see a charge as open and both settle it. ⚠️ T-130's equivalent test *passed
   before the lock existed*, on timing alone; this one is written knowing that.
3. `sum(allocations) > amount` → rejected outright, never clamped.
4. **A surplus credits `2140 Customer store credits payable`** (party=customer) — the exact mirror
   of AP's `1240`. ⭐ v1 called this `overageAsStoreCredit`, stamped a boolean, and **had no
   balance behind it**; here it is a real liability on the ledger. That is the correction, and it
   is why unallocated cash cannot go missing: there is nowhere for it to float.

### 4. Write-off

`writeOffCharge(chargeId, amount, reason)` — `Dr 6860 bad debt / Cr 1210 (party=customer)`.

- **Admin only**, as v1 has it — stricter than voiding.
- ⛔ **Not by whoever created the charge.** v1 has no identity check anywhere in AR; this is the
  same second-party control T-130 added to invoice verification, applied to the one AR action that
  can make a debt disappear. Writing off your own receivable is how a shortfall gets buried.
- Partial and repeatable, each with its own reason and journal entry.

### 5. Aging

`aging(orgId, asOfDate, storeId?)` — buckets open charges by **due date**, falling back to
`charge_date` (bible row 162, landed today). Mirrors `apRepo.aging` exactly, including its
`current / 1-30 / 31-60 / 61-90 / 90+` shape.

## Invariants

1. **No stored balance.** No `outstanding_amount`, no `collected_amount`, no
   `written_off_amount` on the charge. Every figure sums from `journal_lines` and the allocation
   rows — v1's stored derivation drifts on **13.3%** of live rows, which is the argument.
2. **A collection must name what it settles.** Bible §16.10. No unallocated float; a surplus is a
   named liability (`2140`), never a number on a document.
3. **The platform fee is booked once, in the collection.**
4. **Write-off is admin-only, and never by the charge's own author.**
5. **Charges and collections are store-scoped**, like AP (Ian, 2026-08-28) — a collection settles
   one store's charges and lands in that store's account.
6. **Posted documents are immutable; void reverses.**
7. **Aging is by due date**, falling back to the document's own date (row 162).
8. **Every `1210` and `2140` line carries a customer party** — the T-118 trigger enforces it.

## Tests

1. A posted charge shows in `openItems` and `balanceOf`; the trial balance ties.
2. Collection in full closes it; partial leaves the remainder open.
3. ⭐ A collection **with a platform fee** posts exactly three legs, and the net hitting the money
   account is `amount − fee` — the ₱198k pattern.
4. A fee of zero produces **two** legs; `6400` is absent entirely.
5. Surplus credits `2140` with the customer as party.
6. An allocation naming another customer's charge is refused, and nothing posts.
7. `sum(allocations) > amount` refused before any write.
8. ⭐ Two concurrent collections cannot both settle one charge.
9. Void a collection → reversed, the charge reopens, the original stays visible.
10. Write-off posts `6860`/`1210`, is refused for a non-admin, and **refused for the charge's own
    creator even when they are an admin**.
11. Partial write-off twice; the residue is right and each has its own entry.
12. Aging puts a 45-day-old charge in 31–60 by **due date**, not charge date.
13. An online collection with no proof file is refused; a cash one is not.
14. Org isolation.

## Out of scope — each with its reason

**Channel settlement** (fee breakdown, settlement gain, loan deductions, auto-creating channel
receivables from a sales day) — 74% of v1's collection volume and a genuinely different document;
its own task, currently unowned · **Store credit redemption** — `2140` accrues here, spending it
is a POS concern · **Coverage date ranges** — unvalidated metadata in v1, never reconciled against
anything · **Re-applying old unallocated cash** — there is none to re-apply, because surplus
becomes a liability at the moment it arrives · **Customer credit limits** — `set_credit_limit`
and `override_credit_limit` exist as capabilities with no enforcement point yet; enforcing them
belongs with the document that creates the exposure (T-132) · **Dunning and statements**.

## Done when

- [ ] All invariants pass against real Postgres.
- [ ] Migration hand-written per DEF-073, journalled with `previous.when + 86400000`.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green.
- [ ] Both new tables classified and registered.
- [ ] `docs/ROADMAP.html` updated.
- [ ] Channel settlement raised with Ian as an unowned task.
