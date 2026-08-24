# ADR-008 — Multi-company, franchises, and who you are trading with

| | |
|---|---|
| **Status** | Proposed 2026-08-24 |
| **Follows** | Bible rows 111 (multi-company, franchises with separate owners) and 106 (zero starting point) |
| **Gates** | Phase 3 (inventory), and it corrects a pattern already in `docs/POSTING-PATTERNS.md` |

## Context

Ian, 2026-08-24: *"multi company — future users are not umbrella but franchise with separate
owners"*, and then: *"configure for mix internal and external client… I guess we can have the
pre-configured pricing attached to customer like ERPNext does."*

Those are two questions that look separate and are not.

---

## The trap: pricing and accounting treatment are DIFFERENT AXES

The instinct — one customer record with a price list attached — is right, and it is exactly what
ERPNext does (Customer → Customer Group + default Price List). **Adopt it.**

But *"internal or external"* is not only a pricing question. **It decides whether a movement is
revenue at all.**

| Counterparty | Pricing | **Accounting** |
|---|---|---|
| Another store, **same company** | Transfer price, or cost | **Eliminates.** Not revenue. An internal transfer |
| A **franchise** — different company | Franchise rate | **Real revenue, real receivable.** Money leaves one legal entity and enters another |
| An **external customer** | Retail / wholesale | **Real revenue** |

**These two axes are independent, and that is the whole point.** A franchise can be given
internal-looking prices and must still be accounted as an external sale. An internal store can be
charged a full transfer price and must still eliminate. **Conflating them produces revenue that
does not exist, or hides revenue that does** — and it would not look wrong on any screen.

> This is not hypothetical. It **corrects a pattern shipped today**: T-108's `commissary_dispatch`
> worked example posts a due-from/due-to pair that eliminates. Correct for two stores of one
> company; **wrong for a franchise**, where the commissary recognises revenue and COGS and the
> franchisee recognises inventory and a payable.

---

## Decision

### 1. One `customers` table. No separate entity types.

Answering Ian's *"do we need to separate them like internal, external and partner vendors?"* —
**no.** Separate tables for the same real-world thing means every query unions three tables and
every new rule gets written three times. One table, with attributes.

### 2. Two independent links, and the treatment is DERIVED from them

```
customers
  id, org_id            -- the org whose customer this is
  name, ...
  counterparty_store_id -- set when this "customer" is one of OUR OWN stores
  counterparty_org_id   -- set when this customer is ANOTHER org in the system (a franchise)
  price_list_id         -- pricing. INDEPENDENT of the above
  customer_group        -- reporting and defaults only. NEVER drives accounting
  CHECK: at most one counterparty link is set
```

**The link is the fact; the treatment is derived from it:**

| | |
|---|---|
| `counterparty_store_id` set (same org) | **Internal transfer — eliminates** |
| `counterparty_org_id` set (different org) | **Inter-entity sale — real revenue** |
| neither set | **External sale — real revenue** |

Deriving is right *here*, unlike `normal_balance` (bible row 39) which is declared. The difference:
`normal_balance` was inferred from a **string prefix**, a fragile guess about a name. This is a
**foreign key** — the counterparty either is one of our stores or is not, and the join answers it
with no interpretation. A declared `is_internal` flag alongside the link would be a second copy of
the same fact, free to drift, and it would drift silently.

**`customer_group` never drives accounting.** It is for reporting and default price lists. If it
ever gates a posting decision, that is the bug this section exists to prevent.

### 3. Pricing is a price list attached to the customer — the ERPNext shape

A `price_lists` table with per-item rates; a customer names a default. Order lines take the price
list's rate, overridable per line with the override recorded. This is standard, it is what Ian
named, and it needs no invention.

**Out of scope here:** pricing *rules* (volume breaks, date-ranged promotions). One price list per
customer covers what the business does now — ERPNext's full Pricing Rule engine is exactly the
generality bible §1.1 says to leave out until something needs it.

### 4. Inter-entity trade posts BOTH sides, and they must reconcile

A commissary dispatch to a franchise is two entries in two orgs:

| Commissary (seller) | Franchise (buyer) |
|---|---|
| `DR 1210 AR` — party = the franchise | `DR 1310 Inventory` |
| `CR 4300 Revenue` | `CR 2110 AP` — party = the commissary |
| `DR 5100 COGS` / `CR 1310 Inventory` | |

**Both entries are real and neither eliminates.** The receivable in one company and the payable in
the other are the *same debt viewed twice*, so a reconciliation must prove they agree — that is the
inter-company equivalent of the subledger tie-out (invariant 6), and it belongs in the same family
of checks.

**Whether v2 posts the franchisee's side automatically is open** (§Open 2). If the franchisee runs
their own instance, it may arrive as a document rather than a posting.

### 5. No cross-org consolidation by default

**A franchisee sees their own books and nothing else.** Every query is org-scoped and enforced
server-side, not by a filter someone remembered to add.

A group-level view across orgs is a **deliberate, separately-authorised feature** for Ian only —
not a default, and not something any franchise role can reach.

---

## What this changes today

**`docs/POSTING-PATTERNS.md` needs a second commissary pattern**, and both need their condition
stated in the title — *dispatch to an internal store* and *dispatch to a franchise*. Currently the
document has one and presents it as the answer.

That is a **task, not a footnote**: the whole purpose of that document is that a Phase 2 implementer
does not have to decide. Right now it would confidently give them the wrong answer for a franchise.

## Open

1. **Is the chart of accounts shared or per-org?** Shared is simpler and keeps consolidation
   meaningful; per-org lets a franchisee add accounts. Leaning **shared, with per-org accounts
   allowed later** — but it is a real decision.
2. **Does v2 post the franchisee's side of an inter-entity trade?** Only if franchisees are on the
   same instance. If they are, the buyer's entry can be generated; if not, it arrives as a document.
3. **Does a franchise share the store roster and item catalogue**, or keep its own? Affects whether
   `stores` and items are org-scoped or global.
4. **When does the first franchise actually exist?** If it is 2028, this ADR shapes the schema now
   and the features wait. **The schema decisions cannot wait; the screens can.**
