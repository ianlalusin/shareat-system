# T-151 — Landed cost and the branch price: two delivery fees that behave differently

> **Status:** Spec 2026-08-28 by the Opus planner.
> **Depends on:** T-130 (`supplier_invoices`), T-145 (`supplier_invoice_lines`, price history),
> T-132/T-133 (`trade_orders`).
> **v1 read first**, per the standing rule — `computeBranchPrice` and `CommissaryItemConfigPlain`
> in `ERP-rebuild` were read at source, not remembered.

## 1. ⭐ Ian's rule, which is the whole specification

> *"delivery fee from supplier to Lipa is added to price. delivery fee on top of that is the fee
> from Lipa to Malvar."*

Two delivery fees, two **different** treatments, and getting them the same way round is the task:

| Fee | Where it goes | Why |
|---|---|---|
| **Supplier → Lipa** (inbound) | ⭐ **INTO the item's cost** | It is part of what the goods cost to have. A price built on the invoice line alone is understated, so every markup on top of it is too |
| **Lipa → Malvar** (outbound) | ⭐ **ON TOP of the order** | It is a haulage charge for one shipment, not a property of the item. Loading it into the item would make the same item cost different depending on how it happened to travel |

⛔ **Neither is currently modelled.** `supplier_invoices` has no fee field and its lines must sum
exactly to the total; `trade_orders` has no fee field either.

## 2. What v1 does — read at source

`src/lib/financial/commissary/pricing.ts`, `computeBranchPrice`:

| Mode | Price |
|---|---|
| `fixed` | a set peso amount |
| `fixed_markup` | basis + peso amount |
| `percent_markup` | basis × (1 + markup%) |

**Basis** = `max(prior lastReceivedCost, newCost)` — *"max of the last two receives"*, so one cheap
lot cannot drop the branch price below what expensive stock still in inventory cost.

**Cost basis falls through three tiers** (`resolveBasisCost`): a linked **slab**
(`costBasisProductId` — sliced meat prices off its source slab) → the item's own
`lastReceivedCost` → a manager-set `initialCost`.

**`marginAlertThresholdPct`** warns when the computed margin falls below a set floor.

And on the branch order itself: **`deliveryFee` + `otherFees`**, added to the order total
(`order-helpers.ts:46`) — v1 already puts the outbound fee exactly where Ian says it goes.

## 3. ⭐ The one place we improve on v1, and it is not cosmetic

v1 stores the basis as a rolling `lastReceivedCost` field. ⛔ **That is why a chopstick branch
price froze at ₱1,458 instead of ₱1.46.** A delivery line entered as qty 1 with the lot total in
the unit-cost field poisoned the stored basis, and because the rule is `max(prior, new)` it was
**sticky** — every later, cheaper receive kept the poison. Worse, correcting the delivery did not
fix it: the refresh skips recompute when the stored value already equals the new max, so it could
not self-heal. It needed a forced recompute by hand.

⭐ **v2 DERIVES the basis from invoice history and stores nothing.** Fix the bad invoice line and
the price is right on the next read. Same rule, same `max` semantics, no poison — this is exactly
the derive-don't-store pattern (DEF-075) applied where v1 was bitten hardest.

## 4. Contract

```
supplier_invoices
  delivery_fee   numeric NOT NULL default 0   -- inbound freight, INTO cost
  other_fees     numeric NOT NULL default 0

items
  cost_basis_item_id  uuid NULL   -- price off another item (a slab), v1's costBasisProductId

item_pricing                       -- one row per item that has a branch price
  org_id, item_id (unique)
  pricing_mode    fixed | fixed_markup | percent_markup
  fixed_amount, markup_percent, fixed_markup_amount
  margin_alert_threshold_pct
  set_by, created_at, updated_at

trade_orders
  delivery_fee   numeric NOT NULL default 0   -- outbound freight, ON TOP
  other_fees     numeric NOT NULL default 0
```

### The line-sum rule changes

⚠️ Today `sum(lines) = total_amount` exactly. It becomes
**`sum(lines) + delivery_fee + other_fees = total_amount`** on a supplier invoice, and the same
shape on a trade order. Stated because it is the one existing invariant this task moves.

### Landed cost — allocated, never stored

```
landed_line_total = line_total + fees × (line_total / sum(line_total) over the invoice)
landed_base_price = landed_line_total / (quantity × conversion_factor)
```

⭐ **Computed in the price-history query with a window function, not written to a column.** A
corrected fee re-allocates itself. ⚠️ Allocation is by **value**, not by weight or line count —
value is the only basis every line always has, and it is what v1's own per-item costing implies.

## 5. Invariants

1. Inbound fees raise the item's landed cost; outbound fees never do.
2. An outbound fee is part of what the receiving store owes, so it rides the transfer posting —
   there is no separate freight leg and no freight account.
3. The branch-price basis is `max` of the **last two landed receives**, derived per read.
4. A `cost_basis_item_id` link is followed first; the item's own history is the fallback.
5. ⛔ A cost-basis link may not form a cycle, and may not point at itself.
6. A branch price is a **default**, never a lock — a stated rate on a line still wins, and is
   still captured (T-132).
7. Margin alert is advisory. It never blocks an order.

## 6. Tests

1. An invoice of ₱10,000 of goods plus a ₱500 delivery fee gives a landed cost 5% above the raw
   line price, split by value across two lines of different sizes.
2. Correcting a poisoned line fixes the branch price on the next read, with no forced recompute —
   ⭐ v1's chopstick case, which is the reason this is derived.
3. `max` of the last two receives holds: a cheap lot after an expensive one keeps the expensive
   basis; the reverse takes the new higher one.
4. All three pricing modes compute correctly, and the margin alert fires only below the threshold.
5. Sliced meat with a `cost_basis_item_id` prices off the slab, and falls back to its own history
   when the slab has none.
6. A self-referencing or cyclic cost-basis link is refused.
7. An internal trade order with no stated rate defaults to the branch price; a stated rate wins.
8. A trade order of ₱18,000 of goods plus a ₱1,000 outbound fee posts ₱19,000 across `5175`/`1250`
   and `5170`/`2150` — the fee lands on the receiving store, and touches no item's cost.
9. Lines that do not sum to `total − fees` are refused, on both documents.

## 7. Out of scope

⛔ **Weight- or volume-based freight allocation.** Value is the only basis every line has. Named
because it is the obvious "improvement" and it needs data we do not capture.

⛔ **Retrospective re-costing of already-dispatched orders.** A captured rate stays captured
(T-132) — that is the whole point of capturing it.

⛔ **Automatic markup suggestions.** v1 does not have them and nobody has asked.
