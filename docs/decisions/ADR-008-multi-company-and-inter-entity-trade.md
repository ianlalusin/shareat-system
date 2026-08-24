# ADR-008 — Multi-company, franchises, and who you are trading with

| | |
|---|---|
| **Status** | ⚠️ **Proposed 2026-08-24 — and NOT future-proofing. A franchise exists NOW.** |
| **Follows** | Bible rows 111 (multi-company, franchises with separate owners) and 106 (zero starting point) |
| **Gates** | Phase 3 (inventory), and it corrects a pattern already in `docs/POSTING-PATTERNS.md` |

## Context

> ### ⚠️ This is live, not hypothetical
>
> Ian, 2026-08-24: *"franchise is existing now. SharEat Padre Garcia, a franchise, will be using
> the app."*
>
> `y1DMgfisuTHBF57cNL6i` — the store the capture found with **zero documents**, which I recorded as
> *"configured, not operating yet."* The zero is now explained: it has not started trading, **and
> when it does it will be a separate company on this system from its first transaction.**
>
> **Three consequences, all immediate:**
>
> 1. **It should not be a `store` of Ian's org.** It is currently modelled as one, inherited from
>    v1's flat store list. A franchise with a separate owner is an **organization**.
> 2. **Org-scoped access stops being theoretical.** This is the first user of this system who must
>    **not** be able to see everything, and that is a security property, not a filter someone
>    remembers to apply.
> 3. **It starts with no history — which is ideal.** Bible row 106 already says v2 assumes a zero
>    starting point; Padre Garcia genuinely has one. **It is the cleanest possible first tenant**,
>    and a far better multi-tenancy test than a retrofit would be.


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

### 5. Visibility is not all-or-nothing — the FRANCHISOR sees some of the franchisee

**My first draft said only *"a franchisee sees their own books and nothing else"* and stopped
there. That is half the model.** A franchisor normally has a contractual right to see franchisee
**sales** — royalties and franchise fees are usually a percentage of them — while having no claim
on the franchisee's own cost structure, payroll or profit.

So there are **three** visibility levels, not two:

| | |
|---|---|
| **Franchisee sees** | Their own books, entirely. Nothing of Ian's, nothing of another franchise |
| **Franchisor (Ian) sees** | **Franchisee SALES** — whatever the franchise agreement grants, for royalty computation. **Not** their P&L, payroll or expenses |
| **Group view** | Ian's own orgs consolidated. A deliberate, separately-authorised feature — never a default, never reachable by a franchise role |

**The middle row is the one that must be designed, not assumed.** "Ian is admin so he sees
everything" is the easy implementation and it is wrong: it would expose a separate owner's cost
structure to their franchisor, which is a commercial and probably contractual problem, not a
technical one. **What Ian may see is set by the franchise agreement, and the system should enforce
exactly that and no more.**

Every rule here is **enforced server-side**, never by a filter in a query someone remembered to add.

### 6. The franchisee's access: the same ROLE, a different BOUNDARY

Ian, 2026-08-24: *"the franchisee must be shipped with ERP and POS. They have access to what a
branch owner can access, of course store-scoped. They have no access to commissary because they
are not. v1 treats them as a branch but they are not actually."*

**No franchise role is invented.** A franchise owner is a **branch owner of their own company** —
the same role definition, the same capabilities, applied inside a different org boundary. One role
catalogue, applied within an org.

### ⭐ "No commissary access" needs no rule — and that is the test of the design

The commissary is a function of **Ian's** org. A franchisee's org does not contain one, so there is
**nothing to deny**. The exclusion is **structural**, falling out of the org boundary rather than
resting on a permission that could be misconfigured, forgotten on a new screen, or granted by an
over-broad role.

> **This is the check on whether the boundary is modelled correctly: if a rule is ever needed to
> keep a franchisee out of the commissary, the boundary is wrong.** In v1, where Padre Garcia is a
> store, such a rule *would* be needed — which is the defect, stated as a design smell.

**What they DO see of the commissary relationship** is their own side of it: the goods they
received and the amount they owe — an inbound receipt and a payable, exactly as with any supplier.
**Receiving a delivery is not access to the commissary.** They never see its stock, its costs, its
margins, its dispatch planning, or what it charges anyone else.

### 7. ⚠️ v1 models a franchise as a branch — and the consequence is live

This is a **v1 defect** (DEF-050), and it is the clearest single justification for ADR-008.

In v1, `y1DMgfisuTHBF57cNL6i` is a `stores/{storeId}` document in **Ian's Firebase project**, under
the same store-scoped security rules as Lipa and Malvar. So a separate company's books would sit
**inside Ian's database**, reachable by v1's store wildcard, and swept into any query that walks the
store list — including consolidated figures, which would silently add a company Ian does not own to
his own totals.

**It has not bitten yet only because Padre Garcia has posted zero documents.** The moment they
trade in v1, it does.

**Not fixed in v1** — the reference repos are read-only (bible §2 rule 1) and this is a modelling
change, not a patch. **Recorded so the risk is chosen rather than discovered**, and so the v2
design is understood as a correction rather than a preference.

### 8. Commissary ordering: ONE flow, TWO accounting treatments

Ian asked whether the franchisee simply sees their order and its fulfilment, or whether the
commissary needs **two modes** (branch vs franchise), or a **separate ordering system for external
customers**.

**The decisive observation: a franchise order and an external-customer order are the SAME
transaction. The branch requisition is the odd one out.**

| | Branch | Franchise | External customer |
|---|---|---|---|
| **Warehouse work** | Pick, pack, dispatch | Pick, pack, dispatch | Pick, pack, dispatch |
| **Price** | Optional (transfer price) | **Required** | **Required** |
| **Accounting** | Internal transfer, eliminates | **Sale — revenue + receivable** | **Sale — revenue + receivable** |
| **Credit risk** | None | **Real** | **Real** |

So the split is **not** branch-vs-franchise. It is **internal-vs-external**, and franchise sits
firmly on the external side — which is precisely what §2's derived treatment already encodes.

#### The recommendation

**One ordering and fulfilment flow. Two accounting treatments, derived from the counterparty.**

**Fulfilment is identical; the accounting is not.** The commissary staff are doing the same job —
pick, pack, dispatch — regardless of who is receiving. Splitting that into two screens gives them
two places to learn, and gives us two code paths to fix every bug in. The genuine difference lives
entirely in the posting and in whether a price is required, and both of those are already derived
from the counterparty link.

The franchisee sees **their own order and its fulfilment status** — Ian's option (a) — and that
falls out for free, because it is their document in their org. No feature needed.

#### Why not two modes

Two modes drift. The day someone adds a field to the branch flow and not the franchise flow, the
two silently diverge, and nobody notices until a franchise order is missing something. **A mode is
a fork; a derived treatment is a fact.**

#### The honest counter-argument, and why it does not win here

**ERPNext genuinely does split these** — Material Request and Stock Entry for internal movement,
Sales Order and Delivery Note for external sale. That is a real, mainstream design and not a
mistake.

It wins in an organisation where internal requisition and external selling are **run by different
teams with different approval chains**. Here they are the **same commissary staff, packing the same
crates on the same morning**. Adopting the split would import an organisational boundary this
business does not have — the exact generality bible §1.1 says to leave out.

**What would change this answer:** if the commissary ever sells to third parties at volume, with
quotes, credit limits and negotiated terms, the external side outgrows a shared document and should
split then. **That is a decision with a visible trigger, not a guess to make now.**

#### What the one document needs

- A **counterparty** (a `customers` row, per §2) — which decides everything else.
- A **price**, required when the counterparty is external, optional when internal.
- One fulfilment lifecycle: ordered → picked → dispatched → received.
- The receiving side posts in the counterparty's org when external (§4), and nothing when internal.

### 9. One app, not a franchisee app — and org isolation belongs in the DATABASE

Ian asked whether to ship franchisees a separate thin app (financial, inventory, sales) and said
plainly he does not know how this is normally done. So: the mechanism, then the recommendation.

#### First, the thing that is easy to get backwards

**A thin app buys no security.** If the server enforces org scoping, the full app is exactly as
safe. If it does not, a thin app saves nothing — the API is still there and can be called
directly. **Hiding a screen is not a control.** Whatever else is decided, the boundary has to be
enforced server-side, so the app split is a question about user experience, not safety.

#### Second, "thin" is an illusion here

A franchise restaurant runs the same operation as a branch — that is what a franchise *is*. They
need sales, inventory receiving, counts, wastage, expenses, cash, staff and reports. That is
**almost the entire ERP**. The only things they genuinely do not need are commissary operations and
cross-store consolidation, and **both are already excluded by the org boundary** (§7).

So a "thin franchisee app" would start at roughly 90% of the full app and converge on 100% as they
ask for the rest. **It would become a fork**, and every fix would need doing twice — the failure
mode ADR-004 (one monorepo) exists to avoid.

#### Recommendation: one app, org-scoped, with navigation derived from what the org HAS

Not `if (isFranchise) hideCommissary()`. **The commissary section does not render for a franchisee
because their org has no commissary** — there is nothing to show. Same principle as §7: structural,
not rule-based. A conditional would be a rule that can be forgotten on the next screen someone adds.

#### ⭐ How the isolation is actually done: Postgres Row Level Security

This is the part Ian asked about, and it has a specific answer.

The naive approach is `WHERE org_id = $currentOrg` on every query. **It works until the one query
that forgets** — and that query will exist, written months from now by someone who did not know the
rule. It is application discipline, and discipline is not a control.

**Row Level Security** puts it in the database instead. A policy on each table says *"you may only
see rows whose `org_id` matches the current session's org."* The connection sets that org once, at
request boundary, and from then on **the database itself refuses to return another org's rows** —
to every query, including one someone forgot to filter, a report, an ad-hoc script, or a bug.

| | |
|---|---|
| **Enforced where?** | The database, not the application |
| **What if a query forgets its filter?** | It returns nothing extra. The policy still applies |
| **What does the app do?** | Sets the org on the connection once, per request |
| **Cost** | Policies on every org-scoped table, and care with the connection pool so an org never leaks between requests |

**This is the same principle already applied to the ledger**: balance, immutability and period rules
live in triggers rather than TypeScript, because a second copy in application code drifts (bible
§15, RULES §6.3). **Org isolation is exactly that argument, applied to the most consequential rule
in a multi-tenant system** — and the one where being wrong means showing one owner another owner's
books.

✅ **ADOPTED 2026-08-24** — Ian: *“yes adopt it.”* It goes in **before Phase 2 builds tables**;
retrofitting policies onto twenty existing tables is far worse than adding one as each is created.

### 10. External customer ordering — the trigger fired, and it introduces a THIRD kind of actor

§8 said the shared order document should split *“if the commissary ever sells to third parties at
volume… a decision with a visible trigger, not a guess to make now.”* Ian, 2026-08-24: *“then we
design an external customer ordering system so all external customers can order.”* **The trigger
fired the same day.**

#### What does NOT change

**Still one order document.** The trigger was about *volume and terms*, not about who may create
the row. Fulfilment is still pick-pack-dispatch; accounting is still derived from the counterparty
(§2). Splitting the document now would forfeit everything §8 argued for and buy nothing.

#### What DOES change: a third kind of actor, with a different security shape

Until now every user belonged to an **organization** — Ian's, or a franchise's. An external
customer placing their own order is **neither**:

| Actor | Belongs to | Sees |
|---|---|---|
| **Internal staff** | Ian's org | That org's books, by role |
| **Franchise staff** | Their own org | Their own org's books, by role |
| **External customer** ⭐ NEW | **No org at all** — a `customers` row | **Their own orders, invoices and statement. No books of any kind** |

**This is the narrowest access in the system and it must be designed as such, not as a weak org
role.** An external customer has no books here, no ledger, no reports — they have a catalogue, their
prices, their orders and what they owe. Modelling them as “an org with very few permissions” would
put them one misconfigured role away from data they should never be able to reach.

#### How RLS extends to cover it

The §9 mechanism generalises cleanly. The connection carries a **principal**, not merely an org:

- Staff principal → `org_id = :org` policies, exactly as §9 describes.
- **Customer principal → `customer_id = :customer` policies**, on the small set of tables a customer
  may touch (orders, order lines, their invoices, their statement). **Every other table has no
  policy admitting a customer principal at all**, so the default is refusal rather than an
  allow-list someone maintains.

**Refusal by default is the whole point.** A new table is invisible to customers until someone
deliberately writes a policy for it — the same shape as T-119's classification guard, where the
absence of a decision is a failure rather than a permissive assumption.

#### Open, and it materially changes the build

1. **Self-service portal, or staff-entered?** *“So all external customers can order”* reads as
   self-service. That is the larger build — it needs external logins, a catalogue view, and a
   public-facing surface. **Staff-entered is a fraction of the work** and is often how B2B ordering
   actually starts.
2. **Who are these customers?** Other restaurants, resellers, walk-in wholesale? It decides whether
   credit terms, credit limits and statements are needed on day one or later.
3. **Does it reuse the existing CUSTOMER app or the Website storefront?** Both exist and both are
   consumer-facing (diners ordering meals). **B2B wholesale ordering is a different product** —
   sharing a codebase with the diner app is likely a false economy, but that is a real question, not
   an assumption.

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
