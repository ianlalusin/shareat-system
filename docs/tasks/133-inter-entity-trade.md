# T-133 — Inter-entity trade: the internal half of the one order flow

> **Status:** ✅ **BUILT 2026-08-28, then CORRECTED the same day.** ⚠️ The first cut moved `1330`
> inventory between stores, which assumes perpetual inventory this system did not have then — Ian's
> question about a processed meat slab exposed it within the hour. It moved COST after that (§3), and
> `5175 Cost transferred to branches` is the account the chart had demanded since T-102b.
> ⚠️ **§3's four-leg periodic shape is itself retired**: T-165 (2026-09-02) made the system
> perpetual, so dispatch now relieves the commissary's layers into `1340` at cost and receipt is where
> both stores post (`1250`/`2150` at the transfer value, branch `1310`, `5175` carrying only the
> margin) — see `packages/domain/src/trade/index.ts`'s header. **No screen until 2026-09-03**
> (DEF-138); the internal path now has one — `/trade/orders`, with a per-line signed-for quantity and
> shortage reason at receipt — smoketested live with a short receipt and the postings verified in the
> database. `commissary_item_map` still has no writer (DEF-129): a real internal receipt needs the
> map row first.
> **Depends on:** T-132 (the order document), T-129 (`customers` and their derived treatment),
> T-139 (`money_transfers`, which already posts the four-leg cross-store shape).
> **Research: already done and NOT repeated.** `docs/discovery/19-b2b-order-to-cash.md` §7 read
> ERPNext's inter-company mechanism at source and Odoo's absence of one; ADR-008 §4 and §8 decided
> the shape. This spec answers §7's one open item and builds what is buildable today.
> **Assessed before specced**, per bible row 163.

## 1. ⭐ This is not a new document, and that is the whole finding

ADR-008 §8 already settled it, and the sentence is worth quoting because it decides the task:

> *"One ordering and fulfilment flow. Two accounting treatments, derived from the counterparty. …
> A mode is a fork; a derived treatment is a fact."*

| | Branch (`internal`) | Franchise (`inter_entity`) | External customer |
|---|---|---|---|
| Warehouse work | Pick, pack, dispatch | Pick, pack, dispatch | Pick, pack, dispatch |
| Accounting | **Internal transfer — eliminates** | Sale — revenue + receivable | Sale — revenue + receivable |
| Credit risk | None | Real | Real |

T-132 built the right-hand columns and **deliberately refused `internal`**, naming this task. T-133
removes that refusal and adds the second treatment. ⛔ **It does not add a second table, a second
screen, or a "branch order" document** — ERPNext genuinely does split these (Material Request /
Stock Entry vs Sales Order / Delivery Note), and ADR-008 §8 gives the reason we do not: that split
encodes an organisational boundary of separate teams and approval chains, which this business does
not have. The same commissary staff pack the same crates on the same morning.

## 2. ⚠️ The table is renamed, because the name is about to start lying

`wholesale_orders` → **`trade_orders`**, `wholesale_order_lines` → **`trade_order_lines`**.

A table called `wholesale_orders` that holds internal branch transfers is precisely the defect
`docs/GLOSSARY.md` exists to prevent — v1's `dineInSales` is package-only and its `takeOutSales`
is a residual, and both cost real time. ⭐ **The rename is nearly free exactly once: the table is
one day old, holds no production data, and has no UI.** It gets more expensive every day.

## 3. The posting — looked up, then corrected against the codebase

⭐ One entry, four legs, two stores — and it moves **COST**, not inventory.

⛔ **The first implementation of this task got that wrong**, and Ian's question found it within the
hour: *"if raw materials are from Lipa say meat slab then Lipa processed it incurring processing
cost like 10 per kg and it moves to Malvar, how will the books of 2 stores look? How can Malvar
expense it?"* `POSTING-PATTERNS.md` §`commissary_dispatch.transfer` moves `1330` inventory, which
assumes **perpetual** inventory — and this system is **periodic**. Verified: every expense category
maps to a 5xxx COGS account, there is no capitalisation path, and nothing anywhere debited
`1310`/`1330`/`1340`. The answer to Ian's question under that shape was *"Malvar cannot expense it,
and Lipa carries 100% of a cost for goods it no longer holds."*

| Account | Store | Debit | Credit | Party |
|---|---|---:|---:|---|
| 5175 Cost transferred to branches | seller | | 31,000.00 | — |
| 1250 Due from related store | seller | 31,000.00 | | ⚠️ buyer's **store code** |
| 5170 COGS — commissary transfers | buyer | 31,000.00 | | — |
| 2150 Due to related store | buyer | | 31,000.00 | ⚠️ seller's **store code** |

**Ian's own numbers — 100 kg at ₱300, processed at ₱10/kg, all shipped:**

| | Lipa (seller) | Malvar (buyer) |
|---|---:|---:|
| 5110 Meat, bought | 30,000 | — |
| 6xxx processing labour | 1,000 | — |
| 5175 transferred out | (31,000) | — |
| 5170 commissary transfers | — | 31,000 |
| **Net cost carried** | **0** | **31,000** |

⭐ **`5175` is the account the chart has demanded since T-102b and never had.** `5170`'s own seed
comment says it *"must ELIMINATE against the commissary's transfer-out"*. This is that transfer-out.

⚠️ **The transfer PRICE carries the processing cost** — ₱310/kg, not ₱300. Ian sets it per order
today; Phase 3 computes it from real cost. That is the only mechanism by which Lipa's ₱10/kg of
work reaches Malvar's books, which is why the rate lives on the line and is captured there.

⛔ **No revenue.** A branch is not a customer of its own company. v1 books branch sales as
revenue, which is why it then needed `excludeBranchSales` to stop its own insights being wrong —
the exclusion is the tell that the recognition was wrong upstream. ⚠️ COGS *does* move, and must:
that is the difference between the seller and the buyer each carrying the right cost, and the
seller carrying all of it.

⭐ **One entry, not two.** Bible landmine #27's fix: both stores are rows in one database, so this
is one real ACID transaction, never v1's two best-effort writes. `money_transfers` already posts
this exact four-leg shape with cash in place of cost — same helper, same `storeCodes` lookup.

⚠️ **`party_id` for a `party_type='store'` line is the other store's `code`, not a uuid** — there
is no party FK yet (DEF-040), and store codes are stable and human-chosen.

## 4. What is deliberately NOT built, and why each

⛔ **The franchisee's own posting in their own org.** ADR-008 §4 specifies it and discovery §7.4
recommends binding it to `received`. Not built because **no second org exists** — ADR-008 §7 says
v1 models the franchise as a branch, and that is still true in the data. ⚠️ Building the cross-org
half now would be a mechanism with nothing to point at, and §7.5 warns it cannot inherit the
same-transaction guarantee this pattern has: once RLS isolates two orgs, **no single transaction
spans both**, so their agreement is a *scheduled reconciliation*, not a constraint. That weaker
property must be designed for deliberately, with a real counterparty to test against.

⛔ **All three inventory accounts — `1310`, `1330`, `1340`.** ⭐ **Resolved, and the answer was
that they are EARLY, not wrong.** They exist for a perpetual system this one is not yet; nothing
funds them, so nothing may relieve them. `POSTING-PATTERNS.md` now carries both shapes, each
labelled with the era it belongs to, so the next reader is not left choosing between a documented
pattern and a working one.

⛔ **Valuation.** The transfer amount is the stated transfer price, not a computed cost. Phase 3
owns weighted-average and real stock movement; this pattern owns the **shape** only. ⚠️ When
valuation lands, the transfer value should come from cost, not from a price list.

⚠️ **Timing, stated plainly.** The buyer expenses on RECEIPT, not on sale — so a branch that
receives late in the month carries cost slightly ahead of the revenue it will earn. That is not a
new distortion: it is exactly how this system already treats every purchase (buy = expense), so the
transfer is consistent with the books around it rather than a special case. Matching cost to the
month of sale needs perpetual inventory, which is Phase 3.

## 5. Contract

```
trade_orders                      -- renamed from wholesale_orders
  status   draft | confirmed | dispatched | received | void
  received_at, received_by        -- who confirmed what actually landed

customers.counterparty_store_id   -- already exists; treatment is DERIVED (ADR-008 §2)
```

**Treatment, derived and never stored:** `counterparty_store_id` → `internal`;
`counterparty_org_id` → `inter_entity`; neither → `external`.

## 6. Invariants

1. An `internal` order posts the four-leg transfer; `external` and `franchise` post the sale.
   ⭐ **One dispatch function, branching on the derived treatment** — never two functions.
2. An internal order's counterparty store must not be the selling store. A store cannot transfer
   to itself.
3. `1250` and `2150` must be equal and opposite within the entry, so invariant 6's reciprocal
   check holds by construction.
4. An internal dispatch raises **no receivable** — no `ar_charge`, and the credit limit is not
   consulted, because a branch is not extended credit.
5. Void reverses the transfer entry.
6. `received` records who confirmed and when. For a same-org transfer it posts nothing, because
   the value already moved in one entry at dispatch.
7. An `inter_entity` counterparty is refused for now, naming §4 — the seller's half already works
   through T-132's sale treatment; it is the buyer's org that does not exist.

## 7. Tests

1. An internal order dispatches to a four-leg entry: seller `5175` credited, buyer `5170` debited,
   `1250`/`2150` equal and opposite, each party being the **other** store's code — and **no
   inventory account is touched at all**.
   ⭐ Plus Ian's worked case end to end: bought at ₱300, processed at ₱10, shipped at ₱310 — the
   seller's P&L nets to zero and the buyer carries ₱31,000.
2. That entry raises no `ar_charge` at all.
3. A credit limit on an internal counterparty is ignored — a branch is not extended credit.
4. A store transferring to itself is refused.
5. An external customer still posts the T-132 sale, unchanged — the rename and the branch changed
   nothing for it.
6. Void reverses the transfer and the reciprocal pair nets to zero.
7. `received` records who and when, and posts nothing further.
8. Across a whole org, total `1250` equals total `2150` after a mix of transfers and sales.

## 8. Done when

- [ ] Migration hand-written per DEF-073, journalled `previous.when + 86400000`; the rename carries
      indexes, constraints and RLS policies with it, and both registries follow the new names.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green.
- [ ] `docs/POSTING-PATTERNS.md` gains nothing new — this task implements an existing pattern, and
      that is the point.
- [ ] `docs/ROADMAP.html` updated — standing rule, Ian 2026-08-28.
