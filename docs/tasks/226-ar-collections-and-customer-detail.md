# T-226 — AR collections, write-off, and the customer detail page (`/customers/[id]`)

> **Status**: ✅ **BUILT 2026-09-06 — §§2–5, 7, 8 and 9.** ⚠️ **§6 (raise a charge outside a trade
> order) is NOT built**, and is the one part still blocked on Open question 1: which revenue
> account a manual credit sale credits. Everything that *clears* money shipped.
>
> **What shipped:** `/customers/[customerId]`; four server actions (`recordCollectionAction`,
> `voidCollectionAction`, `voidChargeAction`, `writeOffChargeAction`); three register reads in
> `packages/db/src/repo/ar.ts`; the link from `/customers`; seven integration tests.
>
> ⛔ **Two findings came out of building it, both filed and neither fixed here:**
> **DEF-201** — a double-clicked write-off inserts a second `ar_write_offs` row against the SAME
> journal entry, because `writeOffCharge` never reads `postEntry`'s `created` flag while its two
> siblings twenty lines away both do. Measured on real Postgres: control `1210` ₱600, subledger
> ₱200, **invariant 6 broken by a double-click.** The domain layer is out of this task's scope, so
> it is reported, not edited (Scope, below).
> **DEF-202** — a correct permission denial rendering as HTTP 500 on the two org-scoped reports.
>
> ⚠️ **One deliberate step outside Scope, stated here and in the report** (RULES §3.3): **DEF-200**
> was fixed in `apps/erp/src/app/reports/lib.ts` — seven report screens were returning HTTP 500 for
> **every** role, and `/reports/ar-aging` is the screen this task's own invariant 6 is checked on.
>
> ⭐ **The register's other half:** written after a completeness audit found that `1210 Accounts
> receivable` has a raising path and a reporting path and **no clearing path a human can reach**.
>
> ⛔ **This is not a new module.** `packages/domain/src/ar/index.ts` (525 lines),
> `packages/db/src/repo/ar.ts` (447), `packages/db/schema/ar.ts` (150) and
> `packages/domain/tests/integration/ar.test.ts` all shipped with **T-131 on 2 September** and are
> correct. What does not exist is a screen. Every function this task needs is already written,
> authorized, and tested — the work is the UI layer plus three list reads.
>
> ⭐ **This is the seventh occurrence of the shape** DEF-082 / DEF-099 / DEF-133 / DEF-137 /
> DEF-157 / DEF-174 / DEF-186 all share: domain logic shipped and tested with no caller. Filed as
> **DEF-190**. The register's own §D lesson applies — *a screen is not decoration; until one
> exists the capability does not exist.*

## Why this exists

`recordCollection`, `voidCollection` and `writeOffCharge` have **zero callers under `apps/`**.
Verified by grep across `apps/erp/src` for each name and for `arRepo`: no hits. There is also no
`/customers/[id]` route at all — `apps/erp/src/app/customers/` contains `page.tsx`, `actions.ts`,
`lib.ts` and `price-lists/` only.

The consequence in the running app:

| Act | Path today |
|---|---|
| Bill a wholesale customer | ✅ `dispatchTradeOrder` → `recordCharge` (`trade/index.ts:460`) — dispatch **is** the billing event |
| Apply a customer return as credit | ✅ `trade/returns.ts:638` → `recordCollection` with `creditApplied` |
| See who owes what | ✅ `/customers` (balance per row), `/reports/ar-aging` |
| **Record that a customer paid** | ⛔ **nothing** |
| **Write off a bad debt** | ⛔ **nothing** |
| **Void a wrong collection** | ⛔ **nothing** |
| **Charge a customer outside a trade order** (catering, an ad-hoc credit sale) | ⛔ **nothing** |

⚠️ **This is not covered by `/channel-settlements`.** That screen clears **`1220`**, the
delivery-platform receivable, which is a different control account. `1210` is untouched by it.

⚠️ **And it compounds.** `recordCharge` enforces the credit limit by reading `arRepo.positionOf`,
so a customer whose debt can never be cleared eventually hits their limit and can no longer be
dispatched to at all. The missing screen does not merely omit a convenience — it eventually stops
sales.

## What v1 does, and what it was for (RULES §1.2d)

**Studied at source:** `ERP-rebuild/src/app/financial/ar/page.tsx` (310 lines),
`financial/ar/[customerId]/page.tsx` (1,027), `financial/ar/[customerId]/col/[collectionId]`
(711), `financial/ar/aging` (239), `cashier/credit-sales` (1,004), and
`src/lib/actions/ar-credit-sale.actions.ts`.

**The goal it was built to achieve** — written down before judging the implementation, per the
rule that an unwritten goal can only be copied: *let a store see who owes it money, bill a credit
customer, and record what comes back in against the specific debts it settles.* Three verbs, one
ledger position.

**Its shape:** a customer register listing outstanding balances with a total; a per-customer page
with two tabs — **Credit Sales** and **Collections** — plus modals for *Log Credit Sale*, *Record
Collection*, *Settle Platform Payout*, and *Void*.

**Counting the live data (§1.2d step 3)** — figures measured by T-131 and recorded in
`packages/db/schema/ar.ts`'s own header, not re-derived here:

| v1 field | Measured | Verdict |
|---|---|---|
| stored `outstandingBalance` | wrong on **106 of 794 rows (13.3%)** | the reason v2 derives it |
| `overageAsStoreCredit` | a boolean with no balance behind it, used **0 of 512 times** | replaced by real `2140` |
| `unallocatedAmount` | money tied to nothing on **38 collections**, unre-appliable | made impossible |
| `pending_verification` | a status nothing can transition out of | not modelled |
| "AR collections" that are really platform settlements | **381 of 512 (74%)** | already shipped as T-150 |

⭐ **The 74% matters for scoping this task.** Three quarters of what v1 calls an AR collection is
already handled by `/channel-settlements`. What is missing here is the remaining quarter — real
customers paying real invoices — which is small in count and large in consequence, because it is
the only quarter that can go uncollected.

### The four verbs

| v1 surface | Verb | Here |
|---|---|---|
| Customer register with outstanding + total | **Duplicate** | `/customers` already does this (`balancesByCustomer`) — §3 only adds the link |
| Per-customer page, credit sales + collections | **Duplicate** | §4 |
| *Record Collection* with allocation | **Duplicate + Correct** | §5 — allocation is mandatory here; v1 let it float |
| *Log Credit Sale* | **Duplicate** | §6 |
| *Settle Platform Payout* | **Delete** | Superseded by `/channel-settlements` (T-150) |
| *Recompute balance*, *Repair collection*, *Mark reconciled* | **Delete — all three** | ⭐ They exist **only** to patch the stored-balance defect. v2 derives the balance from `journal_lines`, so there is nothing to recompute, repair, or reconcile. Porting them would be porting a workaround for a bug we do not have |
| Write-off | **Add** | ⛔ **v1 has `writeOffArTransactionAction` (`ar-credit-sale.actions.ts:453`) and grep finds NO UI caller for it anywhere in v1 either.** v1 cannot write off a bad debt from a screen — uncollectible receivables sit in `1210` forever, overstating assets. Filed as **DEF-191**. This task is where that is corrected, not duplicated |

## Goal

A signed-in manager can open a customer, see what they owe and what they have paid, record a
payment against named charges, raise a charge outside a trade order, and — with a second pair of
eyes — write off what will never arrive. Every figure on the page is derived from the ledger.

## Scope — files this task may create or modify

**Create**
- `apps/erp/src/app/customers/[customerId]/page.tsx`

**Modify**
- `apps/erp/src/app/customers/actions.ts` — four new server actions
- `apps/erp/src/app/customers/lib.ts` — the reads the page needs
- `apps/erp/src/app/customers/page.tsx` — link each row to its detail page
- `packages/db/src/repo/ar.ts` — three list reads (§2)
- `packages/domain/tests/integration/ar.test.ts` — cases for the new reads

**Explicitly NOT in scope:** `packages/domain/src/ar/index.ts`. Every domain function this task
calls already exists and is tested. ⛔ If one of them turns out to need a change, that is a
**finding to report** (RULES §3.4a), not an edit to make here — it means T-131 got something
wrong and the register should say so.

⛔ **`PROJECT_BIBLE.md` is not in scope** (RULES rule 14).

## Contract

### 1. Capabilities — all four already exist, none is new

| Action | Capability | Scope | Roles |
|---|---|---|---|
| Raise a charge | `approve_buyer` | store | super_admin, admin, manager |
| Charge over the limit | `override_credit_limit` | store | super_admin, admin, manager |
| Record / void a collection | `record_ar_collection` | store | super_admin, admin, manager |
| Write off | `write_off_receivable` | store | super_admin, admin, manager |

⚠️ **A prose/matrix disagreement to fix while here, in the comment only.**
`packages/domain/src/ar/index.ts:441` documents `writeOffCharge` as *"Admin only"*. The matrix
grants it to managers, deliberately — `capabilities.ts:628` records Ian's 2026-08-28 decision and
its reason (*the real control is identity, not rank*, since the function refuses the charge's own
author). The **matrix is right and the code comment is stale**; correct the comment, change no
behaviour.

⛔ **The page gates nothing itself.** Every domain function authorizes by contract. The page
*renders or hides* controls to match, and DEF-189's lesson applies: **never call a domain function
to satisfy a page read** — that returns HTTP 500 where a refusal is wanted. Reads go through
`lib.ts` under `withOrgPrincipal`; only form submissions call domain functions.

### 2. Three list reads — `packages/db/src/repo/ar.ts`

The repo has `positionOf`, `openItems`, `creditBalanceOf`, `aging`, `orgAgingTotal`,
`outstandingForCharge` — every figure a *decision* needs. It has **no register read**: nothing
lists a customer's charges or collections, because until now nothing displayed them.

```
listChargesForCustomer(tx, orgId, customerId, opts?: { storeId?: string; limit?: number })
  → ArChargeListRow[]   // id, store, dates, reference, total, allocated, writtenOff,
                        // outstanding, status, journalEntryId
listCollectionsForCustomer(tx, orgId, customerId, opts?: { storeId?: string; limit?: number })
  → ArCollectionListRow[] // id, store, date, amount, platformFee, moneyAccount, reference,
                          // status, allocations[] (chargeId + amountApplied), journalEntryId
listWriteOffsForCharge(tx, orgId, chargeId) → ArWriteOffRow[]
```

⭐ **`allocated` / `writtenOff` / `outstanding` are computed in the same statement**, reusing
`openItems`' exact CTE shape (`allocated` from posted collections only, `written` from
`ar_write_offs`). ⛔ Do not compute an outstanding figure in TypeScript from two other queries —
a second derivation is a second source of truth and the two will drift. Voided charges list with
`outstanding = 0.00`, never as debt.

⚠️ **`openItems` filters to one store** (`ar_charges.store_id = $storeId`) while `positionOf`
defaults to **org-wide**. That is not a bug — a credit limit is extended to a buyer, not to a
buyer at one branch — but the page must show both without conflating them (§4).

### 3. `/customers` — one change

Each row's name becomes a link to `/customers/{id}`. The balance column already exists and already
comes from `customersRepo.balancesByCustomer`. Nothing else changes.

### 4. `/customers/[customerId]` — the page

Mirrors `/ap/suppliers/[id]` deliberately: same store-picker discipline, same
`mx-auto max-w-4xl space-y-6 p-4 sm:p-8` shell, same `?store=`/`?ok=`/`?error=` search params.

**Header** — customer name, treatment badge, status, credit limit if set, and two figures kept
apart:
- **Owed overall** — `positionOf(orgId, customerId)`, org-wide, labelled as such. This is the
  number the credit limit is judged against.
- **Owed at this store** — `positionOf(orgId, customerId, storeId)` for the chosen store.
- **Store credit held** — `creditBalanceOf`, shown only when above zero, labelled `2140`.

**The store picker.** AR charges are store-scoped and a collection may only settle charges open at
one store. ⭐ Copy `/ap/suppliers/[id]`'s rule verbatim, including its comment: the store is
**chosen, never inferred from whichever open item sorted first** — that older AP behaviour booked
every leg at one store when the supplier was owed at two, so one store's control account went
negative and the other never cleared. Default to the first store with open items; a customer with
none still renders, with the actions that need an open item disabled and a reason on screen.

**Two sections, not tabs** — v1's tabs exist because it is a client component with modals; this is
a server component and two stacked tables read better at 390px:
1. **Charges** — date, due date, reference, total, allocated, written off, **outstanding**, status.
   Overdue rows (aging date < today, outstanding > 0) marked.
2. **Collections** — date, gross amount, platform fee, money account, reference, what it settled
   (charge reference + amount per allocation), status.

Both link their `journalEntryId` to `/reports/journal-lines` so any figure can be walked back to
the entry that produced it — the thing v1 structurally cannot do.

### 5. Record a collection

A form on the detail page, under `record_ar_collection`, calling `recordCollection` unchanged.

- Open items for the chosen store are listed with their outstanding; the user enters an amount
  applied per charge. ⛔ **At least one allocation is mandatory** — the domain already refuses an
  empty `allocations[]` citing bible §16.10 (*a collection must never float unallocated*); the
  form must not let a user reach that error by accident. Disable submit until one row is filled.
- `amount` is **gross** — the receivable relieved. `platformFee` is booked here and **nowhere
  else**; the field carries that warning inline. ⛔ v1 recognised this fee twice and it cost
  **₱198,148.29** across two stores, 37 duplicate expense documents voided.
- `moneyAccountId` from the store's accounts, as `/ap/suppliers/[id]` does.
- **Proof of payment** is required when the account's instrument is not `cash` and the collection
  is not fully credit-funded — v1's real rule, already enforced in the domain. Reuse the existing
  upload path (`uploadFile`, as `/ap` does); do not invent a second one.
- **Store credit** (`creditApplied`) is offered only when `creditBalanceOf` is above zero.
- **Surplus is not an error.** Collecting more than allocated posts the excess to `2140` as real
  store credit. Say so on the form before it happens — v1's users saw a floating
  `unallocatedAmount` and had no way to re-apply it.

### 6. Raise a charge

Under `approve_buyer`, calling `recordCharge` unchanged. Fields: store, charge date, due date,
amount, `revenueAccountCode`, reference, notes.

⚠️ **`revenueAccountCode` is required and there is no default.** The schema comment is explicit:
the sales-day router refuses credit sales outright, no wholesale-revenue account exists in the
chart today, and naming one here keeps the choice visible rather than inventing an account nobody
decided on. Present a **select of active revenue accounts**, never a free-text box and never a
hardcoded fallback. → **Open question 1.**

**Credit limit.** When the charge would breach it, `recordCharge` throws with the full arithmetic
(owed, this charge, the total, the limit). The form re-renders that message and reveals a
*"charge it anyway — say why"* field, which submits `creditOverrideReason`. ⛔ The override is
**never** pre-offered: the refusal must happen first, or the gate is decoration.

### 7. Write off

Under `write_off_receivable`, per charge, calling `writeOffCharge` unchanged. Amount and reason
both required; the amount defaults to the outstanding balance and may be less (partial write-offs
are supported and their idempotency key already carries amount + actor).

⛔ **The domain refuses the charge's own author** and the error says so in plain language. The
button still renders for that person — hiding it would teach that write-off is unavailable rather
than that it needs a second person. Surface the refusal; do not pre-empt it.

### 8. Void

Void a charge (`voidCharge`) or a collection (`voidCollection`), each with a mandatory reason,
each reversing its entry through `reverseEntry`. Voided rows stay listed, marked, and still link
to both entries. ⛔ Nothing is deleted.

### 9. Nav

No change. `/customers` is already in nav; the detail page is reached from it, exactly as
`/ap/suppliers/[id]` is. ⚠️ Add nothing to `nav.tsx` without a route behind it — `/settings` is
in nav today with no `page.tsx` (**DEF-192**), which is the inverse of the failure DEF-181 fixed.

## Invariants

1. **No stored balance.** Every figure on the page derives from `journal_lines` or from the AR
   tables' own CTEs. There is no `outstanding` column and this task does not add one.
2. **A collection always names what it settles.** Enforced by the domain; asserted by a test.
3. **Gross in, net to the bank.** `amount − platformFee − creditApplied` reaches the money
   account. The fee posts to `6400` here and is never expensed separately.
4. **A write-off takes two people.** Author ≠ writer-off, whatever the role.
5. **The org-wide position and the per-store position are never conflated.** The credit limit is
   judged org-wide; allocation happens per store.
6. **After any action, `1210` equals the sum of open items.** The same reconciliation
   `/reports/ar-aging` already asserts on screen, now exercised through a real collection.
7. **Voiding restores exactly.** Position after void = position before the voided document.

## Tests

Integration, against real Postgres, in `packages/domain/tests/integration/ar.test.ts`:

1. `listChargesForCustomer` returns allocated / written-off / outstanding agreeing with
   `openItems` and `outstandingForCharge` **for the same charge** — the drift check.
2. A voided charge lists with `outstanding = 0.00` and is absent from `openItems`.
3. `listCollectionsForCustomer` returns allocations that sum to the amount applied per charge.
4. A collection recorded through the action path relieves `1210` by exactly its gross amount, and
   `orgAgingTotal` agrees with the control balance afterwards (invariant 6).
5. Surplus posts to `2140` and `creditBalanceOf` reflects it.
6. Partial write-off leaves the remainder outstanding; a second write-off for the remainder
   clears it; two identical write-offs do not collapse into one entry.
7. Void of a collection restores the prior position exactly.

⭐ **Write these first and confirm they fail for the right reason** — a missing export, not a
missing row.

**Smoketest on 9008, and it is not optional.** Every prior occurrence of this defect shape was
found by a browser, not a suite. Drive it end to end: dispatch a trade order to raise a charge →
open the customer → record a partial collection → check `1210` and the aging report agree → record
the balance with a surplus → confirm `2140` → write off a second charge as a different person →
void the collection → confirm the position returns. **0px horizontal overflow at 390px.**

## Out of scope — with reasons

- **A customer statement PDF.** Nothing in v1 produces one and nobody has asked.
- **Bulk collection entry** across several customers. v1 has none; the 74% that would need it is
  already `/channel-settlements`.
- **Dunning / reminder automation.** A findings detector (`arChargeOverdue`) is the right shape
  for this and belongs with the OIL work, not here. → **Open question 3.**
- **Editing a posted charge.** Void and re-raise. The ledger is append-only.
- **`packages/domain/src/ar/index.ts`.** See Scope.

## Open questions — for Ian

1. **Which revenue account does a manual credit sale credit?** There is no wholesale-revenue
   account in the chart. Options: add one (e.g. `4200 Wholesale revenue`, a migration and a
   decision), or restrict the select to existing `4xxx` accounts and let the user choose per
   charge. ⚠️ Until this is answered §6 cannot ship; §§4–5 and 7–8 can, and they are the part
   that clears money.
2. **Should a manual charge be possible at all in v2?** Every `1210` charge today comes from a
   trade order, where dispatch is the billing event and the line rate is captured. A manual charge
   is a receivable with no goods behind it. It is genuinely useful for catering and ad-hoc credit,
   and it is also the one path with no document trail. Recommendation: **ship it**, because
   `recordCharge` already exists and gates correctly, and a business that cannot bill outside a
   dispatch will bill outside the system instead.
3. **Overdue receivables as a finding?** `aging` already buckets them and nothing watches them.
   Cheap, and it is the detector shape the phase already uses.

## What the build actually found — recorded, because the numbers are the point

**Tests seen failing for the right reason.** With `listChargesForCustomer`,
`listCollectionsForCustomer` and `listWriteOffsForCharge` de-exported, six of the seven new tests
fail with `TypeError: arRepo.listChargesForCustomer is not a function` — a missing export, not a
missing row. ⚠️ **The seventh is honest about itself**: *"a collection relieves 1210 by its GROSS
amount"* exercises only domain code that predates this task, so there was no state in which it
could fail first. Said plainly rather than dressed up.

**Smoketest on 9008, 390×844, against real dev data** (`Smoketest Wholesale Buyer`, a ₱2,500 posted
charge). 17 of 19 checks passed on the first run; both failures are explained and neither was this
task's code:

| Step | Result |
|---|---|
| `/customers` row links to the detail page | ✅ the DEF-190 entry point exists |
| ₱1,000 partial collection | ✅ outstanding ₱1,500 — relieved by the **gross** amount |
| void that collection | ✅ position back to ₱2,500 **exactly**; the voided row stays, marked |
| ₱2,600 collected against a ₱2,500 charge | ✅ *"₱100.00 more than was owed is now store credit"*, and ₱100 shows at 2140 |
| write-off by the charge's own author | ✅ **refused**, in full: *"you recorded this charge, so you cannot also write it off. Declaring a debt uncollectible needs a second pair of eyes — ask another admin."* |
| write-off by a **different** admin | ✅ *"₱360.00 written off to bad debt (6860)"* |
| 0px horizontal overflow at 390px | ✅ on `/customers` and both detail pages |
| `/reports/ar-aging` ties to `1210` | ⛔ **the page returned HTTP 500** — DEF-200, for every role. Fixed; then verified: all ten report routes 200, and the aging shows ₱360.00 |
| the refusal assertion | ⚠️ a **harness** bug — it read the banner's `<strong>` and not the message beside it. The refusal itself is correct, quoted above |

**Invariant 6, proved directly rather than through a screen** — computed over `journal_lines` with
`positionOf`'s own semantics (`status <> 'draft'`, `party_type = 'customer'`) after all of the
above: **control `1210` = ₱360.00, subledger = ₱360.00, difference ₱0.00.**

⚠️ **A wrong first attempt worth recording**, because it nearly became a false alarm: computing the
control with `status = 'posted'` instead of `<> 'draft'` reported a ₱2,000 break. A **reversed**
entry keeps its lines and changes its status, so filtering to `posted` drops the original and keeps
the reversal. **The books were right and the query was wrong** — check a reconciliation query
against the repo function whose definition it is imitating before believing a break.

## Done when

- [ ] `/customers/[customerId]` renders charges, collections, and three positions, all derived
- [ ] A collection can be recorded against named open items and `1210` moves by its gross amount
- [ ] Surplus becomes visible store credit at `2140`
- [ ] A charge can be raised, refused at the credit limit, and overridden with a stated reason
- [ ] A bad debt can be written off by someone other than its author, and not by its author
- [ ] Both document types can be voided with a reason and the position returns exactly
- [ ] `/reports/ar-aging` reconciles to the control account after every one of the above
- [ ] Seven integration tests green, written first and seen failing for the right reason
- [ ] Live-smoketested on 9008, 0px overflow at 390px
- [ ] `npm run build` exit 0 with the dev server stopped
- [ ] DEF-190 and DEF-191 updated with what shipped
