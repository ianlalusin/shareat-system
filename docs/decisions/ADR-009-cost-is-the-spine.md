# ADR-009 — Cost is the spine: delivery → cost → transfer price → external price

| | |
|---|---|
| **Status** | Proposed 2026-08-25, from Ian's correction of my model |
| **Corrects** | My claim that *"v1 has no inventory value at all"* — too strong, and it changes the December ask |
| **Feeds** | Phase 3 (inventory/FIFO) · ADR-008 §3 (price lists) · ADR-008 §8 (commissary ordering) |

## The correction

I said v1 has no inventory value and the opening figure would have to be created from nothing.
**Ian:**

> *"Our current setup is: inventory is recorded in the delivery module. On this delivery module the
> inventory count AND expense is recorded, so the inventory value is derived from the expense entry
> it is linked to."*

**He is right, and the data says so plainly:**

| | |
|---|---|
| `deliveries` | **430** across four stores, carrying `items`, `totalAmount`, `isExpensed`, `partiallyExpensed` |
| `expenses.deliveryId` | **2,272 of 6,226 expenses** are delivery-linked — a third of all expense activity |
| `itemStockLedger` | **6,505** signed movements; `itemBalances` **537** per-location balances |

**What is true is narrower than what I said:** v1 has no inventory *asset account* and no perpetual
inventory GL — cost hits the P&L on receipt (discovery 06 §1.6). **But the raw material for a
value is there**, because a delivery records both the quantities and, through its linked expense,
what was paid.

> **The distinction matters: "there is no value" and "the value is not in the ledger" are different
> problems.** The first needs a physical pricing exercise; the second needs a query.

---

## Decision

### 1. A DELIVERY is a FIFO cost layer

Ian chose FIFO (bible row 110), and FIFO needs layers: a quantity and a unit cost per receipt,
consumed oldest-first. **A delivery already is exactly that** — items, quantities, and a linked
expense giving what was paid.

**So FIFO is not bolted on to this business; it is how the business already records purchases.**
That is a strong argument the choice was right, and it means Phase 3 maps v1's shape rather than
replacing it.

### 2. ⭐ Cost is the basis of every price — Ian's point, and it is the architecture

> *"From there we get the commissary pricing, then soon the external sales pricing — since
> commissary will be internal for branches, so transfer only."*

| Flow | Priced at | Accounting |
|---|---|---|
| **Commissary → own branch** | **Transfer only** — at cost | **Eliminates.** No revenue (ADR-008 §2) |
| **Commissary → franchise** | Cost **+ margin** | **Real revenue** — separate legal entity |
| **Commissary → external resto** | Cost **+ margin** | **Real revenue** |

**A price list is therefore derived from cost, not typed independently of it** — which is what
makes margin a visible number rather than a guess. ADR-008 §3 said a price list holds per-item
rates; this says where those rates come from.

**Consequence worth stating:** if cost is the basis, then **cost being wrong silently mis-prices
everything downstream.** The delivery→expense link is load-bearing for pricing, not only for the
books — so an unexpensed or partially-expensed delivery is not merely an accounting loose end, it
is an item with no reliable cost.

> `isExpensed` and `partiallyExpensed` already exist as flags on the delivery. **They should drive
> a real report** — *"items whose cost basis is incomplete"* — because those are exactly the items
> that will be priced wrongly.

### 3. What this does to the 31 December count

**It gets substantially smaller, and this is the practical payoff.**

| | I said | Actually |
|---|---|---|
| **Quantities** | Physical count | Physical count — **unchanged**, and still the real work |
| **Unit costs** | Price every item by hand | **Derived from the delivery/expense history.** A query, not an exercise |
| **The count's job** | Create the value | **Verify a computed value** — and find the variances |

**A count that verifies a computed figure is a far better control than one that creates a figure
from nothing**, because the variances *mean* something: they are shrinkage, wastage, mis-recording
or theft. A from-scratch count has nothing to disagree with.

---

## Open

1. **Does the commissary charge branches at cost, or cost-plus?** Ian said *"transfer only"*, which
   reads as at-cost. If it is cost-plus, the mark-up must eliminate on consolidation or it inflates
   group profit — a classic inter-company trap, and worth confirming rather than assuming.
2. **Which cost basis prices an external sale?** Latest delivery cost, or the FIFO layer actually
   shipped? The second is more correct; the first is what a salesperson can quote from. Likely
   both: quote from latest, post COGS from the layer.
3. **How incomplete is the cost basis today?** 430 deliveries and 2,272 linked expenses, but
   `partiallyExpensed` exists as a state. **Measurable now from the landed data** — worth doing
   before Phase 3 rather than discovering it during.

---

## Measured 2026-08-25 — and it inverts the assumption

Ian: *"We only implemented the linking of expense to inventory recently, so data is incomplete and
not perfect. But since most of our inventory is disposed of within a week, max two, we can safely
say that old inventories are gone."*

**The turnover point is decisive and correct** — 1–2 weeks means the opening count only ever needs
cost from *recent* deliveries. Historical gaps genuinely do not matter.

**But the completeness data runs the opposite way to what that implies:**

| Month | Deliveries expensed |
|---|---|
| 2026-05 | 53/58 — **91%** |
| 2026-06 | 103/120 — 86% |
| 2026-07 | 109/122 — 89% |
| **2026-08** | **99/130 — 76%** ⬅ **the worst month, not the best** |

If the linking had been introduced recently and was bedding in, August would be the *highest*.
It is the lowest — and the shape fits a different explanation:

> **Expensing LAGS delivery.** Goods arrive, and the expense document is created later when the
> invoice is processed. The most recent deliveries are simply the ones that have not caught up yet.

### ⚠️ The inversion, and why it matters for 31 December

Both facts are true, and together they point somewhere neither does alone:

- **Stock on hand at 31 December will be from the most recent deliveries** (1–2 week turnover).
- **The most recent deliveries are the least likely to be expensed** (the lag above).

> **So the cost basis is weakest for exactly the stock that needs valuing.** The gap is not in the
> old data that no longer matters — it is in the new data that does.

**This is not a defect; it is a sequencing requirement.** The fix is operational and small:

### 📌 December prerequisite: clear the expensing backlog BEFORE the count

Every December delivery must be linked to its expense before the stock is valued. Otherwise the
count produces quantities with no cost attached, and someone prices them by hand in January — which
is exactly the exercise this ADR just showed was avoidable.

**Roughly 30 deliveries a month sit unexpensed at any time**, so this is a short catch-up, not a
project. It just has to happen *first*.

> **Worth stating plainly: nobody would have found this by reasoning about it.** The turnover
> argument is sound, the recency argument is sound, and the conclusion they jointly imply is the
> opposite of what either suggests alone. It took counting.

---

## Amendment 2026-08-25 — from discovery 20, and one basis question nobody had raised

Three recommendations from `docs/discovery/20-expense-delivery-inventory-shape.md`, **all adopted**:

### 1. ✅ A delivery posts a PROVISIONAL valued layer on receipt, corrected when the expense links

Today nothing posts until the manual link happens, which **is** the expensing lag this ADR
measured (91% → 76%, worst in the most recent month). Posting at receipt on a provisional cost and
correcting on link **closes that lag permanently**, rather than asking people to be more diligent.

**It does not require the two-document split** (Purchase Receipt + Purchase Invoice) that mature
systems use and this ADR already argued against at ~30 deliveries a month. **One document, two
postings.**

> ⚠️ **This needs a “goods received, not yet invoiced” account** — a liability that exists between
> receipt and the linked expense. `1340 Inventory in transit` is an asset and is not it. **Settle
> the account before T-122 is revised**, because a provisional posting with nowhere to put the
> credit is not a design, it is a gap.

### 2. ✅ `isExpensed` / `partiallyExpensed` become DERIVED, not hand-set

They are currently maintained by hand at three call sites. ERPNext's `per_billed` and Odoo's
`invoice_status` are both **re-derived, never hand-written**.

**This is the same failure shape that has already produced real drift in this business**: v1's AP
tile was wired at 3 of 8+ write paths and silently drifted low while looking live. **A
hand-maintained flag with three writers has three chances to be wrong and no way to notice.**

### 3. ✅ Voiding a delivery becomes ONE transaction

v1's own code documents the cascade as **explicitly non-atomic, accepted risk OC-14** — void
delivery, then void each linked expense, then the receipt, then reverse inventory, each committing
separately, with a documented tolerance for inconsistent intermediate states.

**This costs nothing to fix in v2.** `postEntry`/`reverseEntry` already run in one transaction;
this is the case they were built for. *Accepting a risk because the platform could not do better is
not the same as accepting it when the platform can.*

---

## ⚠️ The basis question the research surfaced without naming it

`tie-out.server.ts:381` — verified directly:

> *“D2 (informational): valuation = Σ onHand × item **weighted-avg** cost.”*

**v1 already computes an inventory valuation, and it does so on a WEIGHTED-AVERAGE basis. Ian chose
FIFO** (bible row 110). Those are different numbers.

**Not a conflict, but it must be stated or someone will trip on it in January:**

| | |
|---|---|
| **The 31 December opening layer** | Necessarily **weighted-average** — it is what the data supports, and a single opening layer at an average cost is the standard way to open FIFO books |
| **From 1 January** | **FIFO**, layer by layer, because every layer from then on is a real delivery with a real cost |

**So the basis changes exactly once, at the boundary, by design.** Recorded because a year-on-year
comparison of inventory value spanning the cutover compares two bases — and someone will make that
comparison without knowing.

## What this changes about the approach generally

The research found that v1 **already has** a working, tested off-ledger valuation, and an in-flight
internal migration (`items` replacing the `meatProducts`/`inventoryProducts` split — stated in
`types/item.ts:3`) that independently arrived near the industry-correct shape.

> **The instruction was to fit v1's shape to the correct one. In several places v1 had already
> started doing that itself.** This project should **port more and invent less** than assumed — and
> the `commissaryItemMap` case is the warning: it *looked* like duplication and is a genuinely
> separate concern. A shallower read would have deleted a table that is not redundant.

---

## Verified 2026-08-25 — the delivery already carries the cost

Ian asked whether the simplified design still gives an improved equivalent of what v1 does today.
**It does, and the measurement shows the simplification asks for LESS data entry, not more:**

| | |
|---|---|
| Delivery/expense pairs compared | **301** |
| `delivery.totalAmount` **matches** the sum of its linked expenses exactly | **255 — 85%** |
| Differ | 46 (partial expensing, or later correction) |

**The expense document was recording a fact the delivery already had.** So booking AP from the
delivery is not new data capture — it is removing a duplicate.

### What v2 keeps, and what it adds

| | v1 today | v2 |
|---|---|---|
| Delivery records items and quantities | ✅ | ✅ |
| Cost captured at receipt | ✅ (`totalAmount`) | ✅ — and it POSTS |
| **Inventory as a real asset** | ❌ none | ✅ 1310–1340 |
| **COGS timed to consumption** | ❌ purchase-basis | ✅ FIFO layers, consumed |
| **Count variance hits the P&L** | ❌ *"no direct GL effect"* | ✅ 5400 |
| Wastage posts | partial | ✅ 5300 |
| Void is atomic | ❌ accepted risk OC-14 | ✅ one transaction |
| Linking step, `isExpensed` flags, the lag | required | **gone** |

**Strictly more capability, less work.** The correction that matters most is COGS timing: on a
purchase basis, gross margin moves with when you happened to buy rather than what you sold, which
is why v1's margin is distorted by bulk buys. That is the number this whole design exists to make
true.
