# T-330 — a payment allocates itself across what is outstanding, oldest first

**Status:** SPEC — drafted by the orchestrator (`system32-df`), 2026-09-20. **Ordered by Ian.**
**Closes:** nothing. **Makes rare** what DEF-394 records as legitimate.
**Migration slot:** **none reserved yet** — `0155` is applied. Request one if a schema change proves needed.
**Depends on:** T-328 landing first. ⛔ **Do not start before it commits** — T-328 is live in `ap/index.ts`,
`ar/index.ts`, `ap/actions.ts` and `customers/actions.ts`, which are this task's core files.

> ⛔ **ANCHORS — GREP THESE, NEVER A LINE NUMBER** (bible row 204).
>
> | Anchor | File |
> |---|---|
> | `if (allocatedTotal > amount + 0.005)` | `packages/domain/src/ap/index.ts` — the one-directional check. ⛔ **DELIBERATE (DEF-394). Do not make it symmetric.** |
> | `if (allocatedTotal > amount + 0.005)` | `packages/domain/src/ar/index.ts` — same, in `recordCollection` |
> | `const surplus = Math.max(0, amount - allocatedTotal)` | `packages/domain/src/ar/index.ts` — the intended remainder treatment |
> | `export async function recordPayment(` | `packages/domain/src/ap/index.ts` |
> | `export async function recordCollection(` | `packages/domain/src/ar/index.ts` ⚠️ **NOT `trade/returns.ts`'s same-named function** |

---

## Ian's ruling, 2026-09-20 — both halves, verbatim in effect

1. **"Yes, allowed that payment more than allocated."** A payment MAY allocate less than it pays.
   ⛔ **The one-directional guard is therefore CORRECT and stays.** DEF-394 is closed as *ruled, not a
   defect*. **A future lane must not "fix" the asymmetry.**
2. **"Add auto allocate exhausting all payments to all outstanding balance covering oldest first."**
   This task.

⭐ **The two fit together:** the shortfall stays legal, and auto-allocation makes it *deliberate*
rather than accidental — the operator sees the payment consumed and any remainder named.

---

## Contract

### 1. Oldest first, and "oldest" is defined once

Allocate the payment across the counterparty's outstanding items in **ascending date order**,
consuming each in full before moving to the next, until the payment is exhausted or nothing is left
outstanding.

✅ **IAN RULED, 2026-09-20: MOST OVERDUE FIRST — order by DUE DATE ascending, earliest due date paid
first. Tie-break by INVOICE NUMBER.** ⛔ Not the invoice date, not `created_at`. His words: *"most
overdue first (i.e. by due date, earliest due date = most overdue = paid first), tie-break by
invoice number."*

⛔⛔ **BUT THE SCHEMA DOES NOT FULLY SUPPORT THAT RULE, AND THIS IS OPEN.** Measured against the live
column declarations, 2026-09-20 — **both keys are NULLABLE on both sides:**

| Side | Due-date column | Nullable? | Number column | Nullable? |
|---|---|---|---|---|
| AP | `supplier_invoices.due_date` | ⚠️ **YES** | `supplier_invoices.invoice_no` | ⚠️ **YES** |
| AR | `ar_charges.due_date` | ⚠️ **YES** | `ar_charges.reference_no` *(a reference, not an invoice no.)* | ⚠️ **YES** |

⭐ Each side has a NOT NULL date that is *not* the due date — `supplier_invoices.invoice_date` and
`ar_charges.charge_date`. So a fallback exists; **which fallback is a business decision, not a
coding one.**

✅✅ **ANSWERED — IAN RULED, 2026-09-20. THE ORDER IS NOW FULLY SPECIFIED:**

```
-- ⭐⭐ SUPERSEDED BY AMENDMENT 4 (Ian, 2026-09-20, second ruling). The keys are now:

-- AP (expenses joined to supplier_invoices, grain = the EXPENSE row):
ORDER BY  coalesce(si.due_date, si.invoice_date) ASC,   -- ⭐ THE AGING RULE, bible row 162
          si.invoice_no ASC,                             -- Ian's stated tie-break, where present
          e.id ASC                                       -- uuidv7: unique AND creation-ordered

-- AR (ar_charges, grain = the charge row):
ORDER BY  coalesce(ch.due_date, ch.charge_date) ASC,    -- same rule, same bible row
          ch.reference_no ASC,                           -- AR's equivalent tie-break
          ch.id ASC                                      -- uuidv7

-- ⛔ NO `NULLS LAST` ANYWHERE: `invoice_date` and `charge_date` are both NOT NULL, so the first
-- key can never be null and the whole nulls-ordering question disappears.
-- ⛔ NO `created_at` KEY on either side — provably redundant, see AMENDMENT 4.
```

> ⛔⛔ **AMENDMENT, 2026-09-20 — THE ORIGINAL THIRD KEY DID NOT MAKE THE AP SORT TOTAL, AND THIS
> SPEC CLAIMED IN TERMS THAT IT DID.** The paragraph below still says *"`created_at` is NOT NULL on
> both tables and cannot tie, so the sort is total."* **That is false for AP.** All three of the
> original keys — `due_date`, `invoice_no` AND `created_at` — live on `supplier_invoices`
> (`packages/db/schema/suppliers.ts:208,213,282`), but the allocation grain is the **expense**
> (`ApPaymentAllocationInput.expenseId`, `packages/domain/src/ap/index.ts:653`), and
> `expenses.supplier_invoice_id` is NOT NULL **but not unique** (`packages/db/schema/expenses.ts:149-151`).
> ⭐ **So two expense rows backed by ONE supplier invoice tie on every key**, and two runs of the
> same payment can order them differently — the exact defect the third key exists to prevent.
> **Fix: the AP final keys are `expenses.created_at` then `expenses.id`, at the expense grain.**
> AR is unaffected: its grain is `ar_charges.id` and `created_at` is on that same row
> (`packages/db/schema/ar.ts:64`).
> ⭐ **Found twice independently before a line was written** — the TESTER (`webapps-d1`) reasoned
> from the grain that the tie-break "should be the expense's", and an independent Opus pass then
> proved why and supplied `expenses.id`. Two measurements agreeing is why this is an amendment and
> not a question.

⭐ **`NULLS LAST` is the ruling, not a default.** He was given three options with their consequences
and chose it: a missing due date usually means nobody set a term, not that it is urgent. ⛔ The
rejected option — undated first — would have let *"we do not know when it is due"* outrank a bill
that is genuinely late.

⭐ **The `created_at` fallback is what makes the order DETERMINISTIC**, and it is the reason the
tie-break question did not need his time. `invoice_no` is free text and nullable, so it can be
absent, duplicated, or non-numeric — ⚠️ **and as TEXT it sorts wrongly: `INV-10` comes before
`INV-7`**, character by character. A tie-break that can itself tie leaves two runs of the same
payment allocating differently, which is the exact defect a tie-break exists to prevent.
⛔ **`created_at` is NOT NULL on both tables and cannot tie**, so the sort is total. ⚠️ **Do not
"improve" `invoice_no` into a natural sort** — that is a new rule nobody asked for, and the third
key already makes the order well-defined.

### 2. It is a SUGGESTION the operator can change, never a silent posting

✅ **IAN CONFIRMED, 2026-09-20:** *"fill in the amounts, don't auto-post — operator still has to
confirm/Save."* ⭐ He was offered the alternative explicitly and chose this. **Not an assumption
inherited from the spec's first draft — a ruling.**

⛔ **Auto-allocation proposes; the operator commits.** It fills the allocation boxes and the existing
path posts them. ⚠️ **It must not become a second write path** — one posting function, already
guarded, already tested.
⭐ **Reason it is not automatic:** a supplier may need a *specific* invoice settled, and oldest-first
would silently pay a different one. Ian asked for exhaustion, not for removing the choice.

### 3. The remainder is named, never hidden

If the payment exceeds everything outstanding, the leftover is shown **before** posting.
⭐ AR already books it (`surplus`, DEF-394-sanctioned). ⛔ **The operator must see the number first** —
DEF-394's whole mechanism was a remainder nobody was told about.

### 4. It reduces the typo surface, and that is a stated benefit

⭐ Auto-allocated amounts are **computed from outstanding balances, not typed.** T-328 exists because
a typed `3,000` was silently dropped. ⛔ **But the fields stay editable, so typed input remains
reachable — this does NOT retire any T-328 guard.**

## Invariants

1. **The sum of allocations never exceeds the payment.** The existing guard stays and must still fire.
2. **No allocation exceeds its item's outstanding balance.** Both modules already check this.
3. **A short allocation remains legal** (DEF-394) — ⛔ do not add an under-allocation guard.
4. **Money stays integer centavos / `numeric`.** ⛔ No float accumulation across items.
5. **One posting path.** Auto-allocation writes no rows itself.

## Tests

⛔ **Of each: what value would have to be wrong for this to go red, and does the code under test supply it?**

1. **Exhaustion:** payment equal to the sum of three outstanding items allocates all three to zero.
2. **Partial:** payment smaller than the oldest item allocates that item only, partially.
3. ⭐ **Order, with a control:** three items, deliberately created out of date order, must allocate
   oldest-first. ⛔ **Shuffle the insertion order** — an allocation that is correct only because rows
   came back in insertion order passes a test that proves nothing.
4. **Remainder:** payment exceeding everything leaves the exact surplus, and it is reported.
5. **Rounding:** a payment that cannot divide evenly leaves no centavo unaccounted.
6. ⛔ **The existing guard still fires** when an operator edits an auto-filled figure upward past the
   payment. Auto-allocation must not weaken it.

## Out of scope

- ⛔ **Making the reconciliation symmetric.** DEF-394 ruled: short allocation is legal.
- ⛔ Changing AR's surplus-credit posting. Ian confirmed it as intended.
- ⛔ DEF-383, DEF-393, T-328's GROUP 4.
- ⛔ Disputed/on-hold items, if the schema has such a concept — **report whether it does**; excluding
  them may be right and it is a business rule, not a coding choice.

## Done when

Every §9 gate: typecheck · unit · integration on a lane DB · `npm run build` with 9008 free ·
`/code-review` returned and triaged · `callers.mjs` clean · committed with a message saying *why* ·
**DEF-394 cross-referenced.** ⛔ **§9.4** — the screen, or UNMET in those words to Ian (bible row 203).

---

## ⛔⛔ AMENDMENT 2, 2026-09-20 — THE CONTRACT THIS SPEC FAILED TO NAME, AND TWO TESTS THAT CANNOT GO RED

⛔ **The spec above described the BEHAVIOUR and named no function.** The TESTER (`webapps-d1`)
refused to start on it and was right: there was no export to import, so no test could fail on the
assertion that matters, and protocol step 1 forbids calling "the module does not exist yet" a
usable red. **This section is the missing half.** Both findings below were made before a line of
test or source existed.

### The contract

```ts
// packages/domain/src/ap/index.ts — WRITES NOTHING
// ⭐ CORRECTED 2026-09-20 by the TESTER: `tx` FIRST and async. The first draft of this snippet
// showed neither, while ruling 3 below requires an `authorize` call — which needs a `Tx` and
// therefore makes the function async. Every other export in these two files is `(tx, actor, …)`.
suggestPaymentAllocation(
  tx: Tx | null, actor: Actor, amount: string,
  open: Awaited<ReturnType<typeof apRepo.openItems>>, keys: readonly ApOrderingKeys[]
): Promise<{ allocations: ApPaymentAllocationInput[]; unallocated: string }>

// packages/domain/src/ar/index.ts — mirror, WRITES NOTHING
suggestCollectionAllocation(
  tx: Tx | null, actor: Actor, amount: string,
  open: Awaited<ReturnType<typeof arRepo.openItems>>, keys: readonly ArOrderingKeys[]
): Promise<{ allocations: ArAllocationInput[]; surplus: string }>

// packages/domain/src/shared/allocate-oldest-first.ts — PURE. No DB, no framework, no I/O.
// Integer centavos in, integer centavos out. Holds the ordering and the greedy fill.
```

1. ⭐ **THE ITEM SET COMES FROM THE EXISTING `openItems`, NEVER FROM A NEW "WHICH ITEMS ARE OPEN"
   QUERY.** `recordPayment` re-reads `openItems` inside its own transaction and THROWS on anything
   not in that set (`packages/domain/src/ap/index.ts:739-759`). A second definition of "open" fails
   by proposing an item Save then rejects — an unexplainable error on a figure the operator did not
   type. Both `openItems` bodies are ~30 lines of CTEs nobody would keep in sync. The ordering keys
   are a NARROW separate lookup keyed by the ids `openItems` already returned, used only to sort.
   ⚠️ **Pass the `openItems` array IN — do not call it twice.** If the suggestion calls it and the
   screen calls it again to render the rows, the divergence is re-created inside the feature.
2. ⛔ **NO NEW MONEY CONVERTER.** `packages/core/src/money.ts` already has it: `money()` (refuses
   anything over 2dp, `:46`), `toCentavos` → `bigint` (`:56`), `fromCentavos` → string (`:63`),
   `allocate()` for exact-sum splits (`:112`); `packages/domain/src/shared/money-input.ts:19` is the
   message wrapper. A second money implementation is to be rejected on sight.
3. ⛔ **BOTH FUNCTIONS CALL `authorize`.** Without it this is a new read path returning a
   counterparty's entire open ledger without the check `recordPayment` performs (`ap/index.ts:695`).
4. ⚠️ **Invariant 4, stated honestly:** the pure module is exact in integer centavos, but the
   `outstanding` figures handed to it were already passed through `Number(...).toFixed(2)` in the
   repo (`packages/db/src/repo/ap.ts:604-606`, `ar.ts:236-239`). At `numeric(14,2)` magnitudes that
   is harmless — **but the invariant is held by the database's scale, not by this code, and the task
   may not claim otherwise.**

### Two of the six tests cannot go red — replaced, not padded

| # | Spec's test | Ruling |
|---|---|---|
| **5** | "Rounding: a payment that cannot divide evenly leaves no centavo unaccounted" | ⛔ **CANNOT GO RED.** Greedy full-consumption never divides anything, so no rounding occurs to get wrong. **REPLACED** by a table-driven PURE test asserting `Σ allocations + remainder === payment` in centavos with **exact equality and no epsilon** — any epsilon makes it unable to fail — over `0.01`, `0.05`, `33.33`×3, `999999999999.99`, and an item outstanding `0.01`, re-parsing every emitted string through `money()` in the same test. |
| **6** | "The existing guard still fires when an operator edits an auto-filled figure upward" | ⛔ **CANNOT GO RED.** `allocatedTotal > amount + 0.005` already fires today (`ap/index.ts:761`, `ar/index.ts:300`) independently of this task, and invariant 5 means the suggestion cannot reach it even in principle. **REPLACED** by: the suggestion's OWN returned total never exceeds the payment, and its returned `unallocated`/`surplus` equals what `recordPayment`/`recordCollection` independently compute for the same allocation set (`ap/index.ts:807`, `ar/index.ts:306`). That one CAN go red — it is the new code's arithmetic against the posting path's. |

⭐ **Test 6 was caught by the tester, test 5 by an independent Opus pass, each cold.** Neither was
found by re-reading the spec's reasoning. Handoff §7: the control that catches an instrument failure
is a second measurement that disagrees, not inspection of the instrument.

### Reported, NOT fixed here (out of scope, logged separately)

⚠️ **AP's `openItems` filters only `e.status='posted'` and does NOT exclude an expense whose
supplier invoice is `voided`** (`supplier_invoices.status in ('pending','verified','voided')`,
`packages/db/schema/suppliers.ts:227`). So the new ordering join will sort by a voided invoice's due
date, and the existing hand-allocation path already lets one be settled. **Pre-existing, not caused
by this task, and not to be fixed inside it.** Filed for Ian.

⭐ **And the spec's own open question is ANSWERED: there is no disputed/on-hold concept in the
schema at all** — `supplier_invoices.status` is `pending|verified|voided`, `ar_charges.status` is
`draft|posted|voided` (`packages/db/schema/ar.ts:57`), with no flag column on either table and no
such filter in either `openItems`. **Nothing for auto-allocation to exclude** beyond what
`openItems` already excludes.


---

## ⛔⛔ AMENDMENT 3, 2026-09-20 — STUBS ARE PRE-WIRED, AND "TypeError: NOT A FUNCTION" IS NOT A RED

⛔ **The TESTER reported 12 integration cases failing with `TypeError: suggestPaymentAllocation is
not a function`, and said plainly that the unit file could not go red at all because its module did
not exist. It was right to refuse to call either a usable red, and the gap was the
ORCHESTRATOR'S** — §2a of the orchestrator skill says stub the modules the lane will overwrite
BEFORE dispatch, and that was not done.

⭐ **Why it matters, and it is not pedantry:** a test that fails because the code is ABSENT has
demonstrated only that the code is absent. It has never once been shown to fail on a **wrong
value**, which is the only failure a test exists to catch. RULES §2 — *a test that only ever passed
proves nothing* — and a test that has only ever thrown `TypeError` is the same claim wearing a
different hat.

**Three stubs now exist, deliberately WRONG rather than empty, and the builder overwrites all three:**

| File | Stub behaviour |
|---|---|
| `packages/domain/src/shared/allocate-oldest-first.ts` | allocates nothing, returns the whole payment as `remainder` |
| `packages/domain/src/ap/index.ts` → `suggestPaymentAllocation` | no allocations, whole `amount` `unallocated`, **no `authorize` call** |
| `packages/domain/src/ar/index.ts` → `suggestCollectionAllocation` | no allocations, whole `amount` as `surplus`, **no `authorize` call** |

⭐⭐ **THE STUB IS THE CONTROL, AND IT SPLITS THE SUITE IN TWO.** Every case now runs to its own
assertions against a real function returning a well-typed empty answer:
- a case that **fails on its own assertion** is a TRUE red — it discriminates a wrong answer;
- ⛔ a case that **PASSES against a stub that does nothing is VACUOUS** — it would have passed
  against code that allocates nothing at all, and it must be strengthened *before* the builder makes
  it green.

**The second list is the one worth having, and nothing except running it produces it.** The `authorize`
omission is deliberate for the same reason: the stub must let case 5 fail on "no guard exists", not
pass because the orchestrator implemented the guard while pre-wiring.

⛔ The stubs are typed, and `npm run typecheck` is clean with them in place (exit 0, 2026-09-20) —
so a red from here is a red about BEHAVIOUR, never about compilation.
---

## ⭐⭐ AMENDMENT 4, 2026-09-20 — IAN'S SECOND RULING, AND THE AUDIT THAT FORCED IT

The AUDITOR (`webapps-42`) audited this spec cold, read-only, before implementation existed. It
returned seven findings and six questions. ⛔ **Two of them overturned amendments written an hour
earlier**, and one of those was a money defect nobody had seen.

### ⭐⭐ RULING 1 — AN UNDATED BILL FALLS BACK TO ITS INVOICE DATE. `NULLS LAST` IS REVERSED.

⛔ **The earlier `NULLS LAST` ruling is WITHDRAWN.** It contradicted a rule this codebase already
implements: `coalesce(si.due_date, si.invoice_date) as aging_date`
(`packages/db/src/repo/ap.ts:651`), with the same treatment on AR, both citing **bible row 162**.

⭐ **The auditor's scenario, which is what changed the answer.** A supplier holds ₱50,000 invoiced
2026-01-15 with **no due date**, and ₱10,000 due 2026-09-25. The aging screen already reports the
₱50,000 as `d90plus` — the most overdue thing that supplier has. Under `NULLS LAST`, an operator
paying ₱10,000 and pressing "oldest first" would have settled the **September** bill, which is not
yet due, and `d90plus` would not have moved. **Both screens would have been behaving exactly as
specified, and the operator would have been right to distrust both.**

⛔⛔ **AND THE OPTION IAN ACTUALLY CHOSE HAD NEVER BEEN PUT TO HIM.** The record of the first
decision offers `NULLS LAST` (chosen) against undated-first (rejected). **The rule the codebase
already had — coalesce to the invoice date — appears in neither.** The auditor claimed only that it
was absent from the record, which was the correct claim to make; putting it to Ian produced the
reversal immediately. ⭐ **A choice between two options is not a decision when a third was already
implemented.**

⭐ **Two consequences worth naming:** the sort's first key is now **NOT NULL on both sides**
(`invoice_date` and `charge_date` are), so the whole nulls-ordering question disappears rather than
being answered. And **bible row 162 needs no amendment** — the task now agrees with it, where the
previous version would have left row 162 with two meanings.

### ⭐ RULING 2 — AUTO-ALLOCATE FILLS ONLY THE EMPTY BOXES

An amount the operator has already typed is **never overwritten**. Ian, 2026-09-20, answering the
auditor's Q2 — which named the case this spec had not: the operator types ₱3,000 against invoice B,
then presses auto-allocate. ⭐ **His own reason for not auto-posting was that a supplier may need one
specific invoice settled** (§2). A typed figure is that intent, so clearing it would undo the reason
the button is not automatic in the first place.

### ⭐ RULING 3 — THE CAPABILITY IS THE PAYMENT'S OWN

`record_ap_payment` (`packages/domain/src/ap/index.ts:697`) and `record_ar_collection`
(`packages/domain/src/ar/index.ts:213`). Whoever may record the payment may auto-allocate. No new
capability, and no new question about who may read a counterparty's ledger. Answers Q1.

### ⛔⛔ THE KEY THAT COULD NOT BE TESTED IS GONE — `created_at` DROPPED ON BOTH SIDES (F3 + F7)

AMENDMENT 1 added `e.created_at` as AP's third key and asserted AR needed nothing because its
`created_at` sits on the allocation row. **The auditor measured both claims and both were wrong.**

| Claim | What is actually true |
|---|---|
| AP's `e.created_at` makes the sort total | ⛔ It cannot be shown to do anything. `created_at` is `defaultNow()` — the **transaction** timestamp, identical for every row written in one transaction — so it ties exactly where a tie-break is needed. And `id` is `uuidv7()` (`schema/expenses.ts:114`), which is creation-ordered, so **`created_at` can never disagree with `id`**. A key that can never change an outcome cannot have a test that fails when it is omitted — which is exactly F7: the builder could skip it and every case would still pass. |
| AR is unaffected | ⛔ AR had the **same** defect the amendment fixed for AP. `ar_charges.created_at` is also `defaultNow()` (`schema/ar.ts:64`), so two charges written in one transaction — a batch import, or one order producing two rows — tie on all three keys with no fourth. The amendment answered **grain** where the defect was **uniqueness**. |

⭐ **So the final key on both sides is `id`, and nothing else is needed:** `uuidv7` is unique (primary
key) *and* creation-ordered, which is exactly the "entry order" Ian asked for. **Three keys, all
three able to decide an outcome, all three testable.** ⛔ `AllocationItem.createdAt` is removed from
the contract; the first key is now `agingDate`, and it is never null.

### ⛔ THE REPLACEMENT TESTS WERE *BOTH* STILL UNFALSIFIABLE, AND IT WAS CAUGHT TWICE INDEPENDENTLY

⭐⭐ **The auditor predicted it by reading (F5, F6). The TESTER then PROVED it by running against the
stub. Neither knew what the other had found.**

- **AMENDMENT 2's replacement for test 5** — Σ allocations + remainder === payment, in centavos — is
  an **identity of any single-counter greedy loop**: true for any ordering, any *wrong* ordering,
  any per-item cap bug. ⛔ **All five of its vectors PASSED against a stub that allocates nothing**,
  because `0 + payment === payment`. **FIX, already applied by the tester:** an
  `expectedAllocations` assertion per case *before* the conservation check, which the stub now fails
  on all five. The conservation check stays — necessary, never sufficient.
- **AMENDMENT 2's replacement for test 6** (F5) is **one formula evaluated twice over the same two
  inputs**: the suggestion computes `payment − Σallocations`, and `recordPayment` computes
  `Math.max(0, amount − allocatedTotal)` over the identical array it was handed
  (`ap/index.ts:759,807`). ⛔ The only divergence would be float-vs-bigint, which AMENDMENT 2 item 4
  argues — correctly, and the auditor measured it — **cannot happen. The amendment proved its own
  replacement unfalsifiable in the paragraph above it.** ⭐ **FIX: read the remainder out of the
  DOUBLE ENTRY, not out of the same subtraction** — assert the `ADVANCES_CODE` debit line
  (`ap/index.ts:813-825`), or `apRepo.advancesPositionOf` moving by exactly the remainder. That goes
  red when the suggestion and the posting disagree, which is the claim being made.

⛔ **AND THE AMENDMENT'S OWN PRESCRIPTION WAS THE WEAK PART.** Everything with teeth in that unit
file — the ordering assertions, re-parsing every emitted string through `money()`, never exceeding an
item's outstanding, skipping a zero-outstanding item — **was written by the tester and prescribed by
nobody.** If a later session trims that file back to what AMENDMENT 2 asked for, the coverage goes
with it.

### ⛔ THE CONTRACT GAINS `storeId`, AND THE CALLER GAINS A DUTY (F2)

AMENDMENT 2 justified `authorize` as *"without it this is a new read path returning a counterparty's
entire open ledger"* — and then, two items later, required `open` to be **passed in**, so the
function reads nothing at all. ⭐ **The justification was falsified by the fix beside it**: the read
is in the **caller**, and it runs **first**. The `authorize` stays regardless (bible §15.11 — no
layer may be the only one for a risk), but it is a backstop, not the gate that sentence described.

⛔ **What the passed-in `open` now silently trusts: that the caller fetched it STORE-SCOPED, with the
same `storeId` the payment will post at.** `openItems(tx, orgId, supplierId, storeId)` is
store-scoped by Ian's explicit ruling (`repo/ap.ts:558-564`, 2026-08-28: an org-wide read here *"is
exactly the bug"*), and **nothing in the contract bound the caller to it.** Concrete: the screen
renders one supplier org-wide, auto-allocate proposes another store's open item, and Save throws —
*an unexplainable error on a figure the operator did not type*, which is **the exact outcome that
passing `open` in was chosen to prevent, reintroduced one layer out.**

**Both suggestion functions therefore take `storeId` and REFUSE any handed-in item whose `storeId`
differs from it.** Fail closed, with a message naming the mismatch. ⭐ That is a cheap invariant with
an obvious red test, and it is the only thing standing between the caller's query and the operator.

### Remaining questions, ruled

| Q | Ruling |
|---|---|
| Q3 — an `open` id with no matching `keys` entry | ⛔ **THROW.** Fail closed. Sorting it first or last is a silent mis-ordering, and `noUncheckedIndexedAccess` is on deliberately (RULES §2) so the builder must handle the case explicitly. |
| Q4 — must the ordering-keys query filter `org_id`? | ⭐ **YES, in the real repo function.** Bible §15.11: no layer may be the only one for a risk. The tester's test-local version is safe by provenance rather than by a filter — fine in a test, not fine in the repo. |
| Q5 — is `amount` validated? | **Yes, before any fill.** `recordPayment` refuses a non-positive amount (`:702`) and `money()` accepts a leading `-` (`core/money.ts:46`), so the suggestion must refuse a non-positive payment itself rather than distributing one. |
| Q6 — `unallocated` vs `surplus` | **Not the same thing, and the screen must say which.** AP posts the remainder to `ADVANCES_CODE` as a supplier advance (`:813-825`); AR books it as **customer credit** (DEF-394, `ar/index.ts:307`). §3 requires the operator see the number; it must also say what the number becomes. |

### Findings already resolved, and the dismissals recorded

- **F1 (blocking — "the contract cannot call `authorize` as signed") is CORRECT and was ALREADY
  FIXED** by AMENDMENT 3, an hour before the audit landed: `tx` first, `Promise`-returning. The
  auditor read the file before that amendment existed. ⭐ **Recorded rather than waved away, because
  it was right when written** — and it was found independently by the tester, who had already
  written every call site with `tx` first.
- **F4 — no finding, and it says so.** The auditor measured AMENDMENT 2's float claim
  (`Number('999999999999.99').toFixed(2)` round-trips exactly) instead of assuming it, and reported
  it correct. ⭐ Recorded because an audit that reports only findings cannot be told apart from one
  that found everything it looked for.
- **The seam holds.** Nothing the pure module needs requires a database. ⚠️ But the two sides are
  **not** mirrors and this spec treated them as one: AR's `openItems` already returns `dueDate` and
  `referenceNo` (`repo/ar.ts:232-233`), AP's returns neither (`repo/ap.ts:606-614`). **The narrow
  keys lookup is an AP-only need.** With `created_at` dropped, AR needs no extra lookup at all.

---

## ⛔ AMENDMENT 5, 2026-09-20 — WHERE IAN'S FALLBACK IS *IMPLEMENTED*, AND WHY THE TIDIER OPTION WAS REFUSED

AMENDMENT 4 ruled that an undated item falls back to its invoice or charge date. ⛔ **It did not say
WHERE that resolution happens, and the two sides would have answered differently:** AP's keys lookup
could `coalesce` in SQL, while AR — which needs no lookup at all — would have had to do it in
TypeScript. *One rule, two implementations, two languages.* The AUDITOR caught this **before the
fixtures were rewritten**, which is the only cheap moment it could have been caught.

### The ruling: both dates are handed in RAW, and the pure module resolves the fallback

```ts
AllocationItem { id, dueDate: string | null, documentDate: string, tieBreak: string | null, outstanding: Money }
ApOrderingKeys  { expenseId, dueDate: string | null, invoiceDate: string, invoiceNo: string | null }
ArOrderingKeys  { chargeId,  dueDate: string | null, chargeDate: string,  referenceNo: string | null }
```

⛔ **There is no pre-resolved `agingDate` field anywhere in the contract.** `allocateOldestFirst`
computes `dueDate ?? documentDate` itself — one implementation, in one language, in the one file a
pure test can falsify.

### ⭐⭐ WHY THE TIDIER OPTION WAS REFUSED — it recreated F7 inside F7's own fix

Handing in a single pre-coalesced NOT-NULL `orderDate` is cleaner, and it would have made "the first
sort key is never null" true by construction. ⛔ **And it would have made Ian's fallback rule
untestable.** The module would sort dates *already decided*, so **no pure test could fail when a
wrapper implemented the coalesce wrongly, or omitted it entirely.**

⭐ That is **finding F7's exact shape** — a rule that cannot be distinguished from its absence by the
test that names it — **and it would have landed inside the fix for the finding that retired the last
one.** F7 removed `created_at` for being undecidable; the tidy option would have re-introduced the
same property one slot over, in the very same amendment. The cost of refusing it is one extra field
on the AR side, which AR already has in hand.

⚠️ **Stated honestly, because AMENDMENT 4 claimed otherwise:** "the first sort key is never null" is
now true by **the module's construction**, not by the schema. `due_date` remains nullable on both
tables. No test may assert that the schema guarantees it.

### Verified by the auditor, by measurement, not assumed

| Claim | Result |
|---|---|
| AR's aging also coalesces | ✅ `coalesce(ch.due_date, ch.charge_date)`, `repo/ar.ts:300` — Ian's reversal closes the divergence on **both** sides, not only AP's |
| The first key's fallback is NOT NULL on both sides | ✅ `supplier_invoices.invoice_date` and `ar_charges.charge_date` are both `.notNull()` |
| F5's double-entry control has an AR mirror | ✅ `Cr 2140 surplus, party = customer` (`ar/index.ts:318-323`) — the remainder can be read out of the **ledger** on both sides, which is the only form of that case that can disagree |
| `ar_charges.id` is `uuidv7()` | ✅ `schema/ar.ts:38` — AR's three-key sort is genuinely total, so F3 is closed rather than moved |

### ⛔ And one more vacuous case, in the tester's own file

The null-tie-break case (`tests/unit/auto-allocate-order.test.ts:50-60`) used the ids `'earlier'` and
`'later'`. With `created_at` dropped and `id` the final key, **those ids sort alphabetically in the
same direction as the expected answer, so the case passes whatever the implementation does.** Not
wrong — weaker than its name. Fixture ids must sort **against** the expected order. ⭐ Same class as
the five vacuous exact-sum cases, found the same way: by asking what value would have to be wrong.

---

## ⛔⛔ AMENDMENT 6, 2026-09-20 — `??` WOULD HAVE DELIVERED THE REJECTED RULE SILENTLY

AMENDMENT 5 put the fallback in the pure module and said it computes `dueDate ?? documentDate`.
⛔ **That expression is wrong, and it fails in the direction Ian explicitly ruled against.**

`??` falls back on `null` and `undefined` **only**. An empty string is neither: `'' ?? documentDate`
is `''`, and **`''` sorts BEFORE every real date in ASC order.** That is **undated FIRST** — the
option Ian was offered and rejected — arriving silently, in the single key this whole task turns on,
through an expression that reads as obviously correct.

### The fix is in BOTH layers, deliberately (bible §15.11)

1. **The pure module treats a BLANK due date as absent** — a truthy/length guard, never `??`.
2. **The mapper guards too.** ⭐ AR's existing repo already does:
   `dueDate: r.due_date ? String(r.due_date) : null` (`repo/ar.ts:233`) — a `''` becomes `null` and
   the fallback fires correctly. ⛔ **The AP ordering-keys repo function does not exist yet**, and
   the tester's test-local version is a straight pass-through (`dueDate: r.due_date`). That is
   correct *today*, because the driver returns `null` for SQL NULL — but it carries no guard, on the
   side whose date travels furthest. **It must be written in AR's shape.**

⭐ **Bible §15.11 is the reason it is both and not either:** no layer may be the only one for a given
risk. A guard in the mapper alone leaves the module trusting its caller; a guard in the module alone
leaves every future caller free to invent a third spelling of "no due date".

### One new required vector

The pure file gets a case with `dueDate: ''` asserting it sorts by `documentDate` like any other
undated item. ⭐ **It can go red** — which, after today, is the only property that earns a case its
place.

### ⭐ And the amendment it corrects does achieve what it claimed

Checked the same way, by constructing the discriminating fixture: `{dueDate: null, documentDate:
early}` against `{dueDate: late, documentDate: late}` has a **different expected order depending on
whether the module implements the fallback at all.** Ian's rule is decidable in the pure file now.
That was the entire point of taking the untidier option in AMENDMENT 5, and it holds.

### ⭐ Recorded: the escalation that was correctly NOT made

The auditor was asked whether refusing to put the coalesce *location* to Ian was the right call, and
checked rather than agreeing: the computed order is identical either way; the item set is already
fully materialised by `openItems`, so the SQL-side variant buys no index and no measurable time
(`ar_charges_org_due_date_idx` cannot serve a sort over a handed-in array); and nothing about the
*rule* changes. No screen could differ. ⭐ **Its standing test, worth keeping:** *press when the thing
can lapse with nobody acting; write it down when it needs a deliberate change from someone.* This
needed neither, so it stayed an internal seam.

---

## ⭐⭐ AMENDMENT 7, 2026-09-20 — IAN'S RULING 2 HAD NOWHERE TO BE TESTED, SO THE CONTRACT MOVED

The TESTER, having reached 28/28 true red with nothing vacuous, reported that **two rulings still had
no test anywhere** and declined to invent scope for them:

1. **Ruling 2** — auto-allocate fills only the EMPTY boxes, never overwriting a typed amount.
2. **Q5** — the suggestion must refuse a non-positive payment.

⭐ **Q5 was simply a missing case** and is now required. **Ruling 2 was a hole in the contract**, and
this is the important half: as originally written, "fill only the empty boxes" could only live in the
screen — and **this cycle cannot test a screen at all** (§9.4 deferred 2026-09-20, Chrome absent).
⛔ **So Ian's ruling would have shipped with no test of any kind, in a task whose every other rule was
pinned twice.**

### The fix: the typed amounts become part of the contract

```ts
TypedAmount { id: string; amount: Money }
allocateOldestFirst(items, payment, typed: readonly TypedAmount[] = [])
suggestPaymentAllocation(tx, actor, storeId, amount, open, keys, typed = [])
suggestCollectionAllocation(tx, actor, storeId, amount, open, keys, typed = [])
```

The implementation must, **in this order**:

1. **SKIP** every item whose id appears in `typed` — that box is not empty and is not ours to fill;
2. **REDUCE** the payment available by the SUM of `typed` before allocating anything;
3. ⛔ **REFUSE (throw) when that sum EXCEEDS the payment** — fail closed. `recordPayment` would throw
   at `:761` regardless; refusing here means the operator learns it *before* pressing Save and never
   sees a suggestion computed against a negative balance;
4. report the remainder as `payment − (typed + suggested)` — which is the number §3 owes the
   operator an explanation of.

⚠️ **`typed` defaults to empty** so every existing call site and all 28 red cases stay valid. That
default is a churn decision, not a claim that absent and empty are the same thing.

### ⭐ The principle, now applied three times in one task

**A rule belongs where a test can falsify it.** AMENDMENT 5 moved the aging fallback into the pure
module for exactly this reason; AMENDMENT 6 forbade `??` because it made the fallback silently
undecidable; this amendment moves Ian's typed-amount ruling out of the untestable screen and into
the pure module. ⛔ **In all three cases the tidier-looking design put a business rule somewhere no
test could reach**, and in all three the rule was one a person had explicitly decided.

⭐ **And the gap was found by the lane declining to expand its own scope.** The tester could have
written a screen-shaped test that proved nothing, or silently skipped both rulings. It named them,
said neither had appeared on either numbered list, and asked. **That is the report that turns an
orchestrator's omission into a contract change instead of a missing test.**

### New cases required

| Case | Goes red when |
|---|---|
| A typed amount's item is **not** re-filled | the implementation overwrites a typed box — Ian's ruling, reversed silently |
| The payment available is reduced by the typed sum | the suggestion allocates the full payment again, so typed + suggested exceeds what was handed over (invariant 1) |
| Typed sum **exceeds** the payment → refusal | it returns a plan computed against a negative balance instead of failing closed |
| A non-positive payment → refusal (Q5) | `money()` accepts a leading `-` (`core/money.ts:46`) and the suggestion distributes it |
