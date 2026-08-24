# 20 — Expense/delivery/inventory shape: v1, industry, and what v2 should do

**Date:** 2026-08-25
**Scope:** answers the question in ADR-009's own "Feeds" line — Phase 3 (inventory/FIFO) — and the
specific brief: *inspect v1's shape, compare with mature systems read at source level, and fit v1's
version into the industry-correct shape so the ERP feature Ian is used to survives, corrected.*

**Method:** v1 code read directly and read-only (`ERP-rebuild`, no writes, no branches). Industry
side read at source level via pinned commits, matching the method of discovery 17/19 — vendor docs
used only where explicitly marked:

| System | Repo | Pin | Branch |
|---|---|---|---|
| ERPNext | `frappe/erpnext` | `5fa68dd06835f77a60ccefa033d7955d83294d3b` | `develop` |
| Odoo Community | `odoo/odoo` | `19fa4584c81bd3c636f244298d40e7fc1125e6f3` | `18.0` |
| Tryton | `tryton/purchase` | `6097405ffb8c13013efea6bcb2e4f35c96157b71` | `develop` |
| Dolibarr | `Dolibarr/dolibarr` | `1ccefaef29992b30a0ed0d5b9a612bdc45656e0c` | `develop` |

**Read first, honored throughout:** `docs/RULES.md` §1.2b (v1 = requirements, not design) and §3.6
(research informs, never decides — must name what is NOT adopted); `docs/discovery/17` and `/19`
(the format this matches — three columns plus a standard-strength column plus a verdict);
**`docs/decisions/ADR-009-cost-is-the-spine.md` in full**, the decision this research serves;
`docs/discovery/06-accounting-gaps.md` §1.6; `docs/discovery/08-expense-categories.md`;
`docs/discovery/01-data-model.md` §2.8 and the relationships table (line 233); `docs/POSTING-PATTERNS.md`;
`PROJECT_BIBLE.md` §1.1 and decision rows 106, 109, 110 (FIFO, counted-value cutover, net-book-value
assets); `docs/decisions/COA-ALIGNMENT.md` §4.1 (the already-decided two-stage COGS shape) and
`docs/decisions/OPEN-DECISIONS.md` items 4 and 9 (FIFO resolved, counted opening inventory required).

**The business restated so the verdicts are legible:** ~4 stores, roughly 30 deliveries a month
per ADR-009's own measurement, staff-entered, one supplier line per delivery in the common case,
raw meat with a 1–2 week turnover. Not a multi-warehouse, multi-buyer, formally-PO'd purchasing
operation — the same "midpoint, not ERPNext's generality" framing bible §1.1 already sets for
every other module.

---

## 1. The core shape — one document carrying quantity AND cost, vs. two documents

**What v1 does.** A `deliveries/{id}` document is created at `saveDeliveryAction`
(`delivery.actions.ts:155-180`) carrying `items[]` with `quantity` and `unitCost` **already
filled in** at data-entry time — before the goods are even received. `receiveDeliveryAction`
(`:350-671`) posts the **quantity** side to `itemStockLedger`/`itemBalances` (and the legacy
meat/general ledgers) the moment stock physically arrives; `unitCost` sits on the item row
unused by any ledger at that point. The delivery is created with `isExpensed: false`
(`:176`) and stays that way until a *separate*, later, human action —
`linkExpenseToDeliveryItemAction` (`:994-1096`) or `expenseDeliveryItemAction` (`:1156-1240`)
— attaches an already-posted `expenses` document to it. Only the linked expense's `totalAmount`
is treated as the item's real, book-of-record cost (`expensedAmount`, `:1061`); the `unitCost`
typed at entry time is never itself posted anywhere financial. Discovery 06 §1.6 and ADR-009
confirm the consequence directly: **there is no `inventory__*` GL account at all**
(`account-defs.ts`, grepped, zero matches) — cost only reaches the books once, at whatever
moment this manual link happens, and COGS is therefore purchase-basis, not receipt-basis or
consumption-basis.

**What industry does.** Every one of the four systems studied splits this into two documents,
joined by a real intermediate liability account, and — the load-bearing detail — **the receipt
document posts value to the books immediately, without waiting for the invoice**:

- **ERPNext** posts `Dr <inventory account> / Cr stock_received_but_not_billed` the moment a
  **Purchase Receipt** is submitted (`erpnext/stock/doctype/purchase_receipt/services/gl_composer.py:299-301,354-356,365`)
  — a clearing/GR-IR liability, not AP. The **Purchase Invoice**, arriving later, reverses that
  clearing account and books the real payable (`purchase_invoice.py:683-798`). A guard exists
  specifically to prevent the double-recognition risk v1 has no equivalent for: if a Purchase
  Receipt already exists for a line, a Purchase Invoice with `update_stock=1` is refused outright
  — *"Stock cannot be updated... because a Purchase Receipt has already been created for this
  transaction"* (`purchase_invoice.py:636-644`). Billing completeness is not a boolean: Purchase
  Receipt carries a computed `per_billed: DF.Percent` (`purchase_receipt.py:95`), re-derived on
  every submit from the actual billed amount against it (`services/billing_status.py:20-56`).
- **Odoo** creates a `stock.valuation.layer` row — `quantity`, `unit_cost`, `value`,
  `remaining_qty`, `remaining_value` — at the stock move itself
  (`addons/stock_account/models/stock_valuation_layer.py:12-40`), i.e. at receipt, not at
  invoice. The layer separately links to `stock_move_id` (the receipt event) and
  `account_move_id`/`account_move_line_id` (the eventual invoice), and carries a dedicated
  `price_diff_value` field — *"invoice value correction with invoice currency"* — for exactly
  the case where the real bill differs from what was assumed at receipt.
- **Tryton** mirrors its own sale-side design (already found in discovery 19 §1.4) on the
  purchase side too: one `Purchase` record carries `invoice_method` (manual/order/shipment,
  `purchase.py:166-170`) plus two independently-tracked, re-derived status enums —
  `invoice_state ∈ {none, waiting, paid, exception}` and
  `shipment_state ∈ {none, waiting, received, exception}` (`purchase.py:171-202`, computed by
  `get_invoice_state()`/`get_shipment_state()`).
- **Dolibarr**, the lightest system studied, is the negative case worth naming precisely because
  it undercuts the pattern: `billed` on the supplier order is a **plain boolean**
  (`fournisseur.commande.class.php:136,405`), toggled by a standalone `classifyBilled()` method
  (`:1210-1283`) that is **never called from the supplier-invoice class** (grepped
  `fournisseur.facture.class.php` — zero matches) — i.e. it is a field that looks derived and
  is not, the same failure shape discovery 19 §4.6 already flagged for Dolibarr's credit-limit
  field.

**How standard is this.** Splitting receipt from invoice, with value posting at receipt through
a clearing account, is genuinely standard — three of four systems do it, and the fourth's
attempt at the lighter alternative (a hand-toggled boolean) is the field's own cautionary tale,
not a working counter-example.

**What v2 should do, and why.** **ADAPT, not ADOPT.** Do not build a two-document Purchase
Receipt / Purchase Invoice chain — ADR-009 already decided the opposite direction for this
business (*"FIFO is not bolted on to this business; it is how the business already records
purchases... Phase 3 maps v1's shape rather than replacing it"*), and at ~30 deliveries a month
with one supplier line each, a second document buys nothing this business needs (bible §1.1's
midpoint test). **What v2 should take from the industry pattern is narrower and cheaper than the
whole document split: the receipt event itself must post a real, valued FIFO layer immediately**
— `Dr 1310/1320/1330 Inventory / Cr <a real clearing liability>`, at the *typed* unit cost (or a
provisional last-known cost, see §2), not deferred until a human links an expense weeks later.
The linked expense then **corrects** the clearing account into real AP, exactly the ERPNext
GR/IR shape, but riding on v1's own single `deliveries` document rather than a second doctype.
This keeps the capability v1's staff already know (one screen, one document, quantity and cost
typed together) while fixing the actual defect: **today, nothing posts a value until the manual
link happens; a receipt-time provisional posting means the books are never blind, even before the
invoice catches up.**

---

## 2. The expensing lag — is it inherent to the shape, or fixable within it?

**What v1 does, measured.** ADR-009's own count: 91% (May), 86% (Jun), 89% (Jul), **76% (Aug —
the worst month, not the best)** of deliveries carry a linked expense. ADR-009's own diagnosis:
*"Expensing LAGS delivery. Goods arrive, and the expense document is created later when the
invoice is processed."* Because the delivery's `unitCost` is captured at entry but posts nowhere
until the link happens (`delivery.actions.ts:176`, `:1032-1069`), **the gap is not a data-quality
accident — it is the direct, structural consequence of a design that treats "receive the goods"
and "recognise the cost" as the same act, performed once, whenever a human gets to it.** ADR-009's
own inversion finding makes this concrete: stock on hand at any given date is disproportionately
*recent* deliveries (1–2 week turnover), and recent deliveries are disproportionately the
*unlinked* ones — so the cost basis is structurally weakest exactly where it is needed most.

**What industry does.** None of the four systems studied has this failure mode, for a reason
already surfaced in §1: **the receipt event itself is what posts value.** ERPNext's
`stock_received_but_not_billed` and Odoo's valuation layer both mean a receipt is *never*
costless — the invoice arriving late corrects an already-posted number, it does not create the
first one. Provisional, non-stock accounting exists for the analogous services case in ERPNext
too (`services/provisional_accounting.py:1-78` — a company-level toggle,
`enable_provisional_accounting_for_non_stock_items`), confirming the general principle: **a
system that must operate before the paperwork catches up posts a provisional number and corrects
it, rather than posting nothing.**

**Is it fixable within the shape? Yes — this is the same fix as §1, restated as the answer to
this specific question.** The lag is fixable **without** a second document: post a provisional
cost at `receiveDeliveryAction` time (using the typed `unitCost`, or — where genuinely unknown —
the item's own already-tracked weighted-average `costPerUnit`, see §6) into a real clearing
liability, and let the later expense link **true it up** rather than **create it**. This closes
ADR-009's own named prerequisite — *"clear the expensing backlog BEFORE the [31 Dec] count"* —
for every December *after* this one, permanently, rather than as a one-time manual catch-up.
**Verdict: ADAPT** (post provisional value at receipt, industry's genuine mechanism) while
**DELIBERATELY SKIP** the two-document ceremony that mechanism is usually wrapped in.

---

## 3. `isExpensed` / `partiallyExpensed` — is a boolean pair adequate?

**What v1 does.** Per-item `isExpensed: boolean` set by the link action, aggregated to the
delivery as `isExpensed: updatedItems.every(it => it.isExpensed)` and
`partiallyExpensed: updatedItems.some(it => it.isExpensed) && !allExpensed`
(`delivery.actions.ts:1063-1069`, repeated verbatim at `:1133-1136` and `:1227-1229`). Both
flags are **hand-set on every write path that touches item-level expensing** — three separate
call sites independently recompute and write the same two derived booleans, which is exactly
the "derive, don't hand-maintain" anti-pattern bible §4.2 rule 7 and discovery 19 §5.1 already
name as the thing to avoid (a fact rediscovered here about v1, not v2). There is also no
representation of a **partial-amount** match — a delivery item is either linked to an expense
that covers it or it is not; there is no field for "60% of this line's cost is confirmed."

**What industry does.** Three of the four systems studied converge on a **derived, re-computed,
non-boolean** representation:

- ERPNext: `per_billed: DF.Percent` on Purchase Receipt, recomputed from the actual sum of
  billed amounts every time an invoice posts against it (`billing_status.py:20-56`) — never
  hand-set, never a boolean.
- Odoo: `invoice_status ∈ {no, to invoice, invoiced}`, a `@api.depends`-computed field re-derived
  from `qty_to_invoice` on every underlying change (`addons/purchase/models/purchase_order.py:41-63`)
  — a genuine tri-state, not a pair, and structurally incapable of drifting from its source
  because it is never written directly.
- Tryton: `invoice_state ∈ {none, waiting, paid, exception}`, likewise computed
  (`purchase.py:171-175`, `:991-994`).
- Dolibarr (the negative case, already discussed in §1): a **plain, hand-toggled boolean**
  that nothing automatically keeps honest — the closest thing in the field to v1's own shape,
  and it is the one system's design that discovery 19 §4.6 and this pass both flag as the
  cautionary example, not a pattern to match.

**How standard is this.** Genuinely standard among the three heavier systems, converging
independently on the same principle (percentage or enum, always derived) despite different
mechanisms — and Dolibarr's boolean is confirmed, not merely suspected, to be the weaker
choice.

**What v2 should do, and why.** Replace the boolean pair with a **computed percentage or status**
derived from the layer's confirmed-vs-provisional cost (§1–2), the same way ERPNext's
`per_billed` and Odoo's `invoice_status` are computed — never written by three independent call
sites the way v1's flags are today. Concretely: a delivery line's cost-confirmation state is a
*query* over "provisional cost posted vs. linked expense amount," not a stored field three
different actions must remember to keep in sync. This also directly serves ADR-009's own
proposed report — *"items whose cost basis is incomplete"* — which is naturally a filter over a
derived field, not a maintenance burden on top of one. **Verdict: CORRECT** (bible §1.2's fourth
verb) — the capability (know which items' cost is unconfirmed) is real and must be kept; the
boolean-pair mechanism is the part that is wrong.

---

## 4. The non-atomic void cascade

**What v1 does.** `voidDeliveryAction` (`delivery.actions.ts:675-933`) and `voidReceiptAction`
(`receipt.actions.ts:475-649`) both cascade through a **sequence of independently-committing
Firestore transactions** — void each linked expense via the shared `voidExpense()` primitive,
then void the receipt if orphaned, then reverse inventory — with the cascade's own code comments
stating the consequence plainly: *"there is no cross-transaction rollback... a mid-cascade
failure leaves a genuinely inconsistent intermediate state that the app tolerates and documents
rather than solves with a single distributed transaction"* (`delivery.actions.ts:731-738`,
mirrored at `receipt.actions.ts:586-593`). Discovery 01 §5.3 names this directly as **accepted
risk OC-14** and, independently of this pass, already flags the opportunity: *"This is the one
clear place where the Firestore design intentionally traded atomicity for progress, and a
relational rebuild has an opportunity to actually fix it with a real multi-table transaction"*
(`01-data-model.md:315`).

**What industry does.** Every system studied wraps a cancel/void of this kind in its own
platform's real transaction — ERPNext's `Purchase Receipt.on_cancel()` calls
`update_stock_ledger()`, `make_gl_entries_on_cancel()`, and dependent-status updates inside one
document transaction (`purchase_receipt.py:426-444`); Odoo and Tryton similarly wrap
cancellation in their ORM's transactional unit of work. None of the four systems studied
implements a *sequential, individually-committing* cascade with an explicitly accepted
inconsistent-intermediate-state risk — that shape is specific to v1's Firestore constraints, not
a pattern any reference system chose deliberately.

**What v2 should do, and why.** This is the one row in this document where the fix costs nothing
extra to build, because **v2 already has the mechanism**: `postEntry`/`reverseEntry` (T-106) and
real Postgres transactions are the project's own standing architecture, not a new capability to
design. Voiding a delivery in v2 should be **one database transaction**: reverse the FIFO layer
consumption/creation, `reverseEntry` the journal postings it caused (clearing-account entry, and
the expense's postings if any), and flip the delivery's status — committed together or not at
all, the same "every leg posts or none" invariant already governing every other v2 write. The
cascade-in-the-direction-of-causation *shape* v1 built (voiding the root event auto-voids what it
caused, rather than requiring a human to void four things in the right order) is correct and
should be kept — see §6. **Verdict: CORRECT.** The capability (one action safely undoes an
entire delivery) is right; the non-atomic mechanism is the named, already-accepted defect this
migration is the natural place to close, and doing so costs nothing beyond using the
infrastructure v2 already has.

---

## 5. Item master and UOM — real complexity or accumulated accident?

**What v1 does — and it is not one thing, it is three, each answering a different question.**

1. **`items/{id}`** (`src/types/item.ts`, full file) is v1's own already-in-flight correction of
   itself: the file's header comment states plainly, *"Single source of truth for all item
   types... Replaces the split meatProducts / inventoryProducts"* (`item.ts:1-3`). It carries a
   genuine, if single-purchase-unit, UOM model: `baseUnit` (the unit every ledger/balance uses),
   `purchaseUnit` (free string — what the supplier delivers in), and `conversionFactor` (`1
   purchaseUnit = conversionFactor × baseUnit`, `item.ts:20-25`) — plus `costPerUnit`, explicitly
   documented as *"weighted-avg; updated on receive"* (`:47`).
2. **`meatProducts/{id}`** (`src/types/inventory.ts:5-25`) is the **legacy** structure `items`
   was built to replace — its own `unit: string` field with **no conversion factor at all**, and
   a `legacyId: 'mp_{id}'` back-reference (`01-data-model.md:244`) confirms the migration
   direction: `items` is where v1 was already correcting itself *to*, not a second competing
   design.
3. **`commissaryItemMap/{mapId}`** (`src/types/index.ts:1839-1864`) is **not** a unit-of-measure
   concept at all, despite sitting in the same conceptual neighbourhood — it maps one commissary
   item to its corresponding **branch-side** item id (`branchItemId`, nullable with two distinct
   nullish meanings already flagged as a hazard in `01-data-model.md:245`), plus the
   branch's own auto-expense category override for receiving a dispatch. It solves cross-store
   item correspondence and per-branch COGS classification — a different problem from "what unit
   does this item come in," answered by a different, correctly-separate table.

**What industry does.** ERPNext's `Item` doctype carries a genuine multi-UOM child table —
`UOM Conversion Detail`, fields `uom` + `conversion_factor`
(`erpnext/stock/doctype/uom_conversion_detail/uom_conversion_detail.json:15,25`) — supporting
**several** purchase/stock/sales UOMs per item, each independently convertible to the item's base
stock UOM, materially heavier than v1's single `purchaseUnit`/`conversionFactor` pair.

**How standard is this.** The underlying concept (base unit + conversion factor to a purchase
unit) is genuinely standard — v1's `items` model is a real, correctly-scoped instance of it, not
an invented shortcut.

**What v2 should do, and why.** The duality is **not** one accident to fix — it is **two
different findings that happen to look similar**:

- `meatProducts` vs. `items` is accumulated migration debris — v1 had already identified and was
  already correcting this before v2 existed. **CORRECT / DUPLICATE**: adopt `items`' shape
  (`kind`, `baseUnit`, `purchaseUnit`, `conversionFactor`, `costPerUnit`) as the single item
  model outright; there is no reason to re-invent what v1's own team already converged on, and
  no reason to import `meatProducts`' un-convertible `unit` string it was built to retire.
- `commissaryItemMap` alongside `items` is **not** duality — it is domain complexity correctly
  kept separate, and building a single-UOM-framework-does-everything table in its place would be
  the mistake, not the fix. A single purchase unit per item (v1's model) is the right scope for
  this business — a full N-UOM child table (ERPNext's) is generality this business does not have
  and should be **DELIBERATELY SKIPPED**, matching the same reasoning discovery 17 §5 already
  applied to accounting dimensions.

---

## 6. What v1 does BETTER than the reference systems

Both prior research passes (17, 19) found something v1 (or Shareat System's own already-made
decisions) does better than the field; this pass finds two more, both genuine and both worth
protecting:

1. **A working, tested, off-ledger valuation mechanism already exists — built before this project
   started.** `src/lib/financial/tie-out/tie-out.ts` (`ItemCostRow`, `:71-74`; `items: /* Item
   master rows carrying weighted-avg costPerUnit (for valuation) */`, `:122`) sums `onHand ×
   costPerUnit` and **explicitly lists items missing a cost without failing the whole report**
   (confirmed by its own test name, `tie-out.test.ts:237`, *"sums onHand × costPerUnit and lists
   items missing a cost without failing"*). This is precisely the mechanism ADR-009 describes as
   the thing that makes the 31 December count *"verify a computed value"* rather than *"create a
   figure from nothing"* — and it was already built, independent of ADR-009's own reasoning,
   before this research pass started. v2 should not rebuild this from scratch; it should port the
   principle (a tolerant valuation reconciliation that reports gaps as a list, not a hard failure)
   directly.
2. **Cost-variance tolerance at the point of linking is deliberately non-blocking, and this is
   the right call, not laxity.** `linkExpenseToDeliveryItemAction`'s own comment
   (`delivery.actions.ts:1046-1054`): *"The cost variance is no longer a hard reject...
   bookkeepers must be able to link a centavo-rounded supplier invoice even when it doesn't
   reconcile to the kg × unitCost figure exactly. Variances surface as an 'unsettled' UI badge."*
   This is functionally the same judgement Odoo's `price_diff_value` field embodies (§1) —
   the receipt-time estimate and the invoice-time actual are allowed to differ, and the
   difference is a flagged fact, not a blocked transaction. v1 arrived at this independently,
   without the layer/clearing-account machinery around it; v2 should keep the judgement
   (never hard-block a real invoice from linking over a rounding gap) even while fixing the
   machinery that surfaces it (§1–3).
3. **Void cascades in the direction of causation, not the direction of convenience** (already
   credited in §4): voiding the root event (the delivery) auto-voids what it caused (expense,
   then receipt if orphaned) rather than requiring a human to manually unwind three documents in
   the right order. The mechanism (sequential, non-atomic transactions) is the flaw; the shape
   (one action, correct direction) is not, and should be kept exactly as-is once wrapped in a
   real transaction.

---

## What NOT to adopt

Per RULES.md §3.6 and bible §1.1, naming what stays out is as much the job as naming what comes
in:

- **A separate Purchase Receipt / Purchase Invoice doctype pair** (ERPNext's full model). At
  ~30 deliveries/month with one supplier line each and no formal purchase-order matching
  requirement, a second document buys nothing this business needs and directly contradicts
  ADR-009's own stated direction ("map v1's shape, don't replace it"). **DELIBERATELY SKIP.**
- **Landed Cost Voucher as a separate doctype** (ERPNext), with its `distribute_charges_based_on`
  (Qty/Amount/Manual) allocation engine (`landed_cost_voucher.py:44-49`). This solves freight/duty
  apportionment across many lines from many receipts at once — a real problem for a
  multi-warehouse importer, not for a commissary receiving one supplier's meat delivery at a
  time. Where a delivery genuinely carries an extra charge (delivery fee, handling), fold it into
  the line's unit cost directly, the way v1 already types `unitCost` by hand. **DELIBERATELY
  SKIP.**
- **A full N-UOM-per-item conversion table** (ERPNext's `UOM Conversion Detail` child table,
  Odoo's `uom_id`/purchase-unit split). v1's single `purchaseUnit` + `conversionFactor` per item
  (§5) already matches how this business actually buys — one supplier, one purchase unit, per
  item. **DELIBERATELY SKIP**, matching discovery 17 §5's reasoning against a general dimension
  framework.
- **Formal purchase-order-to-receipt three-way matching** (PO → PR → PI, with `per_billed`
  rolled up across multiple POs feeding one receipt). This business is staff-entered on the
  spot, not requisition-and-approve; a purchase order step is ceremony with no counterparty here,
  the same reasoning discovery 19 §1.5 already applied to skip a Quote step on the sales side.
  **DELIBERATELY SKIP.**
- **A dynamic, schema-mutating multi-warehouse valuation-layer engine** with cross-location
  reposting (Odoo's full `stock.valuation.layer` apparatus, including negative-layer FIFO vacuum
  correction across warehouses). Discovery 17 §2.3 already establishes that even ERPNext, the
  project's own reference, does not attempt synchronous same-transaction reposting of a backdated
  correction — v2's FIFO layers should be a lighter, single-location-aware table, not a
  reposting-across-everything engine. **DELIBERATELY SKIP the general engine; ADOPT the layer
  concept itself** (already decided, bible row 110).

---

## What v1 gets right and must be preserved

Naming the capability, not the code, per RULES.md §1.2b:

1. **One screen, one action, quantity and cost typed together at the same moment goods are
   physically checked in.** This is the actual daily habit staff already have, and nothing in
   this research argues for splitting that into two data-entry steps — the fix is what happens
   to the cost *after* it's typed (§1–2), not adding a second screen before it.
2. **A tolerant, non-blocking cost-variance judgement at the point of confirming real cost**
   (§6.2) — never let bookkeeping precision block a real transaction from being recorded.
3. **Void cascades in the direction of causation** (§4, §6.3) — one action correctly unwinds
   everything a delivery caused, in the right order, without requiring the user to know or
   perform that order manually.
4. **A working, tested reconciliation report that tolerates missing data and lists it rather than
   failing** (§6.1, the `tie-out.ts` mechanism) — the right shape for the 31 December count and
   for any future cost-completeness report.
5. **Item-level allocate-on-receive to a specific physical location**
   (`delivery.actions.ts:507-533`, the Receiving/default-room parking logic) — a real, working
   per-location model, distinct from the item/UOM question in §5 but worth naming as a working
   capability this research did not need to touch.

---

## The three things the planner most needs to decide

1. **Does a delivery post a real, valued inventory layer the moment it is received — using the
   typed unit cost as a provisional figure, corrected when the linked expense confirms it — or
   does v2 keep v1's shape where nothing posts until the manual link happens?**
   **Recommendation: post provisionally at receipt, into a real clearing liability
   (`Dr 1310/1320/1330 / Cr <clearing>`), corrected on link.** This is the single highest-leverage
   change in this document: it closes ADR-009's own measured 24%-worst-case expensing lag
   permanently (§2), without adopting the two-document generality ADR-009 already argued against
   adopting (§1).
2. **Does v2 replace `isExpensed`/`partiallyExpensed` with a derived percentage or status
   (matching ERPNext's `per_billed`, Odoo's `invoice_status`), computed from the layer's
   confirmed-vs-provisional amount — or keep a stored boolean pair that three independent call
   sites must remember to recompute?** **Recommendation: derive it.** This is cheap to decide now
   (Phase 3 hasn't cut inventory DDL yet) and is exactly the kind of hand-maintained-counter risk
   discovery 06 already found causing real drift elsewhere in v1 (the AP tile, the AR dashboard
   counters) — no reason to import the same failure shape into a brand-new table.
3. **Does voiding a delivery become one real Postgres transaction (layer reversal + journal
   reversal + status flip, atomic), closing OC-14 — or does v2 carry forward the sequential,
   individually-committing cascade v1's own code already documents as an accepted, non-ideal
   trade-off?** **Recommendation: one transaction.** Unlike the other two decisions, this one
   costs nothing extra — v2's `postEntry`/`reverseEntry` and real Postgres transactions already
   exist for exactly this purpose; the only decision is not accidentally re-deriving v1's
   Firestore-forced sequential shape out of habit when the constraint that forced it is gone.
