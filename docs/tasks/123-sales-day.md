# T-123 — Sales day: the other half of the 88%

> **Status:** ⚠️ **SPEC REVISED 2026-08-25 — and the first version was badly under-scoped.**
> I specced it from the posting patterns and started building a schema before reading v1's actual
> `SalesDayPlain`. Ian stopped it: *"before building, look how v1 does it, correct if wrong,
> improve if it can be improved, research about it — so we don't break anything working; we just
> align and correct what needs alignment and correction."* **The read changed the design
> fundamentally.** §2 is what v1 really carries; §3 is the decomposition question it raises.
> **Not buildable until §7's research lands.**
> **Depends on:** T-121 · T-105 (`postEntry`) · ADR-006 · **T-136** (remittance)

## 1. What this is

**The ERP's record of a day's selling, per store.** POS owns the sale; this document recognises
the revenue. `sale` legs were **2,945** of the captured corpus against expenses' 4,396 — together
88% of all real activity, measured, not guessed.

---

## 2. ⭐ What v1's sales day ACTUALLY carries — and it is not a sales report

`ERP-rebuild/src/types/index.ts:1170-1330`. **~60 fields.** My first spec modelled seven of them.

### 2.1 Revenue — three channels, not two

`totalSales` · `dineInSales` · `takeOutSales` · **`deliverySales`**

⚠️ I had modelled two. **The first two names are traps** (`docs/GLOSSARY.md`): `dineInSales` is
unlimited-package sales only; `takeOutSales` is a residual. But `deliverySales` exists as its own
figure and I had folded it into the residual.

Plus the platform split: `foodpandaSales`, `grabSales`, `otherSales`, `salesChannelBreakdown`,
and `branchSalesByOrder` (the commissary→branch mirror, with per-order idempotency).

### 2.2 Tender — four methods, not two

`cashPayments` · `eWalletPayments` · `creditCardPayments` · `otherPayments`, plus
`onlineBreakdown` per account, `creditSales`, and `otherPaymentBreakdown[]` with notes.

⚠️ I had modelled cash + online. **Credit card and "other" are distinct tender types** and
`creditSales` is a receivable, not cash.

### 2.3 Discounts — itemised by statutory type

`totalDiscounts` · **`seniorDiscount`** · **`pwdDiscount`** · `otherDiscount` · `comps`

⚠️ I had one `discounts` figure. **Senior and PWD are broken out separately in v1, and that is not
decoration** — they are statutory categories a business must be able to evidence.

### 2.4 ⭐ The `less` / `plus` blocks — the part I missed entirely

**This is the cashier's daily cash accountability, and it is the heart of the document:**

| `less` — what left the till | `plus` — what entered it |
|---|---|
| `cashierExpense` | `arPaymentsCashier` |
| `salaryAdvanceCashier` | `cashRequestReturnToCashier` |
| `cashRequestReleasedCashier` | ⚠️ `voidCashRetained` — cash on voided receipts never refunded |
| `apPaymentsCashier` | **`openingBudget`** |
| `remittanceCash` / `remittanceOnline` | `vendorRefunds` · `otherCollections` |
| `onlineDeductionsByAccount` (per account) | `onlineAdditionsByAccount` (per account) |

> **⭐ This is Ian's "spending split" in its real form.** Money leaving the cashier's till for
> expenses, salary advances, cash requests and AP payments is deducted from what they must remit.
> **The sales day is where the till's whole day nets out** — not just its selling.

**Two things this reveals that were recorded elsewhere as gaps:**

1. **`openingBudget` IS the store revolving fund** (T-136 §2, which I recorded as *"v1 has
   nothing"*). ⚠️ **That was wrong** — v1 has no *petty-cash module*, but the till's opening float
   is here and already flows through the arithmetic.
2. `onlineDeductionsByAccount` / `onlineAdditionsByAccount` are **per cashier-owned payment
   account** — bible row 127's owner dimension, already doing real work.

### 2.5 Coverage, sign-off, and shortage charges

- **`coverageEvents[]`** — sales-day cash used *in place* to fund a cash-request release. The day
  is settled when `coveredCash + actualRemittanceCash >= cashPayments`. **Cash that never
  physically moved because it was spent directly.** Nothing in my spec had this concept.
- **`signoff`** — `reportedBy` · `remittedBy` · `checkedBy` · `acceptedBy`. **Four roles**, which
  is real segregation of duties, not a rubber stamp.
- **`shortageCharges[]`** — a cash shortage allocated to one or more named staff, with amounts and
  timestamps. This is the matrix's `charge_staff_for_discrepancy` doing its job.

---

## 3. ⭐ The design question this raises: v1 fuses THREE documents into one

**`SalesDayPlain` is three things wearing one hat:**

| | What it is | Cadence it wants |
|---|---|---|
| **A** | **Revenue recognition** — sales, channels, discounts, comps → the journal entry | Per business day |
| **B** | **The till's daily accountability** — opening float, sales in, outflows, inflows, expected close | **Per business day, always** |
| **C** | **The remittance** — actual vs expected, discrepancy, shortage charges, sign-off | **Pooled** (T-136: 3-day, weekly, per store) |

> **The fusion is exactly WHY remittance cannot span days** (bible row 128). It is not an oversight
> in v1 — it is one document trying to serve three cadences, and C is the one that breaks.

**And the decomposition is already implied by decisions we have taken:** T-136 §1 says *separate
the COUNT from the TRANSFER* — that is precisely **B** from **C**. B stays daily and keeps the
custody control; C pools.

⚠️ **But this is not mine to decide alone, and it must not be decided from first principles.**
Splitting a document staff use daily is exactly the change that "breaks something working." §7.

---

## 4. The three rules — all three are PORTS (bible row 126)

`saveSalesDayDraftAction` implements all three in v1 today.

### 4.1 An unverified sales day recognises NO revenue
v1 recognises only for status ∈ `{verified, partially_remitted, remitted}`.

> ⚠️ **v1 enforces this in THREE separate readers** — income statement, dashboard, month roll-up —
> with a note saying *"keep them in sync if you add a 4th."* **A rule enforced in three places is a
> rule that will one day be enforced in two.**

**v2 removes the problem: verification is what POSTS.** No entry until verified, so every reader
gets it free (bible row 118).

### 4.2 A new report cannot be created while an older one is unverified
**The forcing function.** ⚠️ v1's carve-outs are load-bearing and stop it deadlocking: **editing
the existing draft**, **backfilling an OLDER date**, and **starting a shift** are never blocked.
**Admins bypass** (v1 flipped to this deliberately in June — do not "restore" the original).

### 4.3 The entry dates on the SALES DAY, never the posting date
A 31 December sale confirmed on 2 January is December revenue.

---

## 5. ⛔ The flaw v2 must not inherit: revenue comes from the LEDGER

v1's income statement reads `Σ salesDays.totalSales` — **the mirror document is the revenue.**
In v2 the journal is the revenue and the sales day is a source document, exactly like an expense.

⚠️ **Check in the ETL:** commissary branch-sale revenue only reached v1's income statement if a
report already existed that day; otherwise the receivable was right and the P&L revenue was
**deferred indefinitely.** Any v1 figure we reconcile against carries that distortion.

## 6. Posting — inherited from T-108, not re-decided

`sale.unli.simple` · `sale.alacarte.simple` · `sale.discount.senior-pwd` · `sale.comps` ·
`sale.mixed` are pinned and verified in `docs/POSTING-PATTERNS.md`. **Look them up.**

**The balance identity is TWO checks, not one**, and a day failing either **quarantines** rather
than posting a guess:
1. tender: `cash + online + discounts + comps = totalSales`
2. revenue: `unli + à la carte = totalSales`

⚠️ **§2 shows both are incomplete** — the real tender side has four methods plus credit sales, and
the revenue side has three channels. **The identities must be restated against the real fields
before anything is built.**

> `POSTING-PATTERNS.md:184`: **v1's own `sale.builder.ts` posts only the cash and online legs —
> zero revenue, zero discount, zero comps.** This is the repair, not the port.

---

## 7. ⚠️ Research required before building (bible §3.6)

### ✅ Question 1 is ANSWERED — the till position belongs to the ERP (Ian, 2026-08-25)

> *"The cash handover is duplicated in POS and ERP shift report. Let's simplify — fold that to ERP
> or POS, not both. We choose one. I suggest ERP, because the cash handover is affected by
> deductions like expenses paid by cashier, cash requests released by cashier, online payments
> converted to cash, AP paid by cashier."*

**Agreed, and the reason is the decisive one.** POS's `cashHandovers` computes
`expectedCash = startingCash + cashSales − deductions[]` — but **POS does not know the
deductions.** Every one of them (a cashier-paid expense, a released cash request, an AP payment
from the till) is an ERP document.

> **So POS's `deductions[]` can only be filled by the cashier re-entering what the ERP already
> knows — a second entry point for the same fact, which is exactly how two figures come to
> disagree.** An expected-cash figure is only as good as its deduction data, and only one of the
> two systems has it.

**This also settles §3's A/B/C split**: **B lives in the ERP**, beside the `less`/`plus` blocks
that already compute it (§2.4). POS keeps the physical count if it is convenient at the terminal,
but **it is evidence submitted to the ERP, never a second computation of expected cash.**

⚠️ **One consequence to design for, not discover:** POS sells offline by design (discovery 22 §4);
the ERP may not be reachable at shift change. **A count is not a sale** — it can be recorded on
paper and entered late — but the shift-close flow must say so rather than simply failing.
### Still open

2. **How reference systems handle a till float** (`openingBudget`) — imprest, or a running
   balance? This overlaps T-136 §5 and should be the same pass.
3. **Statutory discount reporting in PH** — senior/PWD are broken out for a reason; confirm what
   the evidence requirement actually is before collapsing or keeping the split.
4. **Whether `coverageEvents` has a standard name.** *Cash spent directly rather than remitted* is
   a real pattern; v1 invented a mechanism for it and it works. Find the industry treatment before
   redesigning it.

## 8. Capabilities

`record_sale` · `submit_sales_day` (incl. staff) · `verify_sales_day` (**not staff**) ·
`void_sales_day` (**not staff**) · `accept_remittance` (**not staff**, and **DEF-052**: a grant
that enforced nothing in v1) · `charge_staff_for_discrepancy` (§2.5).

> ⭐ **`submit` and `verify` are deliberately different capabilities** — *"the person who submits
> should not be the one who verifies."* v1's four-role `signoff` block says the business already
> knows this.

## 9. Invariants — restated after §7

Carried forward as still-correct: an unverified day has **no journal entry** (proven against the
ledger, not a reader) · verifying posts, dated on the **business date** · the create-block holds
**and its three carve-outs are proven** · **admins bypass**, with a test · voiding **reverses** ·
the T-108 patterns post exactly as pinned · a verified day is **immutable** · every capability has
a denial test · no posting into a **closed period**.

⚠️ **Not yet writable:** the balance identities (§6) and anything touching the till position,
until §7 settles §3.

## Out of scope

Replacing POS · the remittance document itself (**T-136**) · channel settlement (T-130/131) ·
VAT computation — §6's discount is management reporting, **never a BIR VAT-exemption
computation**.

## Open

1. **Scheduled pull or a button?** v1 is *"button-only creation"* by deliberate decision — the
   auto-creators were removed. **Suggest porting that:** a report should exist because a person
   filed it.
2. **What if POS's figure changes after verification?** A late void moves recognised revenue.
   **Suggest an OIL finding (T-135), never a silent re-post.**
3. **§3's decomposition** — the real one, and it needs Ian.
