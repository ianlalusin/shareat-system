# T-133 — Inter-entity trade: the internal half of the one order flow

> **Status:** Spec 2026-08-28 by the Opus planner. Wave 4's second item.
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

## 3. The posting — looked up, not decided

⭐ `docs/POSTING-PATTERNS.md` §`commissary_dispatch.transfer` is the authority (bible: *"Look it
up; do not decide"*), and it is **one entry, four legs, two stores**:

| Account | Store | Debit | Credit | Party |
|---|---|---:|---:|---|
| 1330 Inventory — prepped / commissary goods | seller | | 18,000.00 | — |
| 1250 Due from related store | seller | 18,000.00 | | ⚠️ buyer's **store code** |
| 1330 Inventory — prepped / commissary goods | buyer | 18,000.00 | | — |
| 2150 Due to related store | buyer | | 18,000.00 | ⚠️ seller's **store code** |

⛔ **No revenue and no COGS.** A branch is not a customer of its own company. v1 books branch
sales as revenue, which is why it then needed `excludeBranchSales` to stop its own insights being
wrong — the exclusion is the tell that the recognition was wrong upstream.

⭐ **One entry, not two.** Bible landmine #27's fix: both stores are rows in one database, so this
is one real ACID transaction, never v1's two best-effort writes. `money_transfers` already posts
this exact four-leg shape with cash in place of inventory — same helper, same `storeCodes` lookup.

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

⛔ **`1340 Inventory in transit (branch orders)`.** ⚠️ **Worth flagging rather than quietly
resolving:** the chart carries this account, and the authoritative posting pattern never uses it —
it moves value straight from the seller's `1330` to the buyer's `1330` in one entry. So either the
account is premature or the pattern is. I follow the pattern, per the bible, and record the
discrepancy here. It becomes live when dispatch and receipt genuinely separate, which is the
cross-org case above.

⛔ **Valuation.** The transfer amount is the stated transfer price, not a computed cost. Phase 3
owns weighted-average and real stock movement; this pattern owns the **shape** only. ⚠️ When
valuation lands, the transfer value should come from cost, not from a price list.

⛔ **Consuming what was transferred.** `5170 COGS — commissary transfers` stays unposted here: the
value sits in the branch's `1330` until the branch consumes it, which is Phase 3.

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

1. An internal order dispatches to a four-leg entry: seller `1330` credited, buyer `1330` debited,
   `1250`/`2150` equal and opposite, each party being the **other** store's code.
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
