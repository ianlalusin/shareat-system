# T-149 — What an item may be bought and sold as

> **Status:** Spec written 2026-08-28 by the Opus planner, implemented same session.
> **Depends on:** T-145 (`items`), T-129 (`price_lists`), T-148 (item governance).
> **Assessed before specced**, per bible row 163 — the assessment is summarised below because it
> changed the shape from an enum to three booleans.

## The problem, in Ian's own examples

> *"samgyup in a box is a bento box sold to ala carte orders dine in take out online, it is cooked
> prep and delivered but it cant be sold to a franchisee. franchisee can buy specific product like
> beef premium 5kg packaging. this cant be sold to people alacarte. but there is a mix example
> milkis can both be sold in retail or wholesale/franchisee."*

| | à la carte | franchisee | bought from a supplier |
|---|---|---|---|
| Samgyup bento box | ✅ | ⛔ | ⛔ — we **make** it |
| Beef Premium 5kg pack | ⛔ | ✅ | ✅ |
| Milkis | ✅ | ✅ | ✅ |
| Charcoal, gloves, tissue | ⛔ | ⛔ | ✅ |

⭐ **That fourth row is why this is booleans and not an enum.** Most of the 385 imported names are
sold to nobody — they are consumed. `retail | wholesale | both` has nowhere to put them; three
independent booleans do, and `false/false` is the common case rather than an awkward extra member.

⭐ **And the bento box is why `is_purchasable` exists.** Ian, 2026-08-28: *"yes make the bento box
an erp item, later we can add the ingredient costing so its every sold is measured against raw
mats."* A thing we make is not a thing a supplier bills us for, and the difference is what will
later let its cost be computed from its ingredients instead of read off an invoice.

## Grounding

- ⛔ **v1 has no sellability concept at all** — no `isSellable`, no channel flag, nothing in
  `ERP-rebuild`'s types. New capability; the four verbs give only *add*.
- **POS owns the à la carte menu** — a global `products` collection, separate from any ERP item
  master, with `stores/{id}/inventory` for stock. So `sellable_retail` here is the ERP's statement
  of intent, and becomes the source POS reads when the two are wired. ⚠️ It is NOT a second copy of
  POS's menu, and nothing in this task writes to POS.
- **Industry: exactly this pattern.** Odoo's product master carries *"Can be Sold"* and *"Can be
  Purchased"*, and disabling the former removes the product from POS automatically. Odoo
  deliberately keeps **one product master shared across channels** rather than a product per
  channel, expressing channel differences through pricelists — which is T-145's design already.
  ([Odoo forum](https://www.odoo.com/forum/help-1/difference-between-can-be-sold-and-can-be-purchased-in-products-148275),
  [TenthPlanet](https://tenthplanet.in/odoo/product/master/how-to-configure-product-availability-features-in-product-master-in-odoo/))
- **Open source: nothing to adopt.** Three boolean columns and two guard clauses. Odoo is the
  pattern worth copying, not the dependency.

## Contract

```
items
  is_purchasable      boolean NOT NULL default true   -- a supplier can bill us for it
  sellable_retail     boolean NOT NULL default false  -- à la carte: dine-in, take-out, online
  sellable_wholesale  boolean NOT NULL default false  -- a franchisee or external buyer
```

**Three independent facts, deliberately.** They are not mutually exclusive and not ordered: Milkis
is all three, a bento box is retail-only and made not bought, charcoal is purchased and sold to
nobody.

### Backfill — derived from evidence, never guessed

| Column | Rule | Why |
|---|---|---|
| `is_purchasable` | `true` for every existing row | Every item in the master today arrived through purchasing; that is what the import read |
| `sellable_retail` | `true` where `kind = 'retail'` | v1's own word for a thing it resells |
| `sellable_wholesale` | `true` where the item **already has a price-list rate** | ⭐ Evidence, not a guess: somebody quoted it to a customer, so it is sold wholesale by definition |

⚠️ Everything else defaults to `false` and Ian turns it on. Inventing a sellability for 385 items
from their names would be exactly the kind of confident guess this project keeps finding in v1.

### Enforcement — two points, both where the mistake actually happens

1. **An invoice line requires `is_purchasable`.** A supplier billing us for a bento box means
   either the item is wrong or the flag is — both worth stopping. (`validateInvoiceLines`, beside
   the existing active-item check.)
2. **A price-list rate requires `sellable_wholesale`.** ⭐ This is the one that matters today:
   nothing currently stops someone quoting cooked food to a franchisee. (`setPrice`.)

⚠️ **Service-layer, not a CHECK constraint**, and consistently so: `validateInvoiceLines` already
enforces item *status* there for the same reason — a CHECK cannot join out to `items`, and a
trigger for this would be a second place to look for one rule.

## ⭐ Store-scoped — corrected mid-build by Ian

> *"it must be store scoped coz the main branch shareat lipa might be making the bulgogi sauce
> but the franchisee is purchasing it from shareat lipa."*

Bulgogi sauce is **one item** — one identity, one price history, org-wide. What differs by store is
what that store *does* with it: Lipa makes it and sells it wholesale; another branch buys it in.

⛔ **The trap avoided:** a row per store per item is exactly v1's mistake — 842 records for 385 real
products, and price history impossible. So identity stays org-level and only the EXCEPTION is
stored:

```
items.is_purchasable / sellable_retail / sellable_wholesale   ← the org's default answer
store_item_sellability                                        ← where one store differs
```

Every override column is NULLABLE, meaning *"no opinion — follow the org"*. A store overriding
only `is_purchasable` must not restate the other two, because restating freezes today's default
into a copy that stops tracking it. Resolution is `coalesce(override, default)`, per column.

⚠️ With 385 items and 6 stores, a mandatory per-store row would be 2,310 rows of configuration
before anything worked. The override table is empty until somebody has a reason to fill it.

⚠️ **A price list checks wholesale ANYWHERE in the org**, not at one store: a rate card is
org-wide, so if Lipa sells the sauce wholesale, the rate is quotable.

## Invariants

1. The three flags are independent; no combination is forbidden, including all-false (an item
   being retired) and retail-only-and-not-purchasable (the bento box).
2. An invoice line's item must be purchasable.
3. A price-list rate's item must be sellable wholesale.
4. Backfilled values come from evidence — `kind`, and existing price-list rates — never from
   parsing names.

## Tests

1. A bento box (`is_purchasable = false`, `sellable_retail = true`) is refused on an invoice line.
2. The same item accepts a retail sale conceptually — no wholesale rate may be set on it.
3. A wholesale-only pack is refused a retail flag by nothing (it is a free combination) but IS
   accepted on a price list.
4. Milkis, all three true, is accepted everywhere.
5. Charcoal, purchasable only, is accepted on an invoice line and refused on a price list.
6. Backfill: an item with an existing price-list rate came out `sellable_wholesale = true`.

## Out of scope

⛔ **Recipes / bill of materials** — what a bento box is *made of*, and costing a sale against raw
materials. Ian, 2026-08-28: *"later we can add the ingredient costing… but for future build, for
now the basic first."* Named here so the omission is a decision · writing any flag into POS's own
`products` · pricing rules of any kind.

⚠️ **An earlier draft of this line listed "per-store sellability" as out of scope**, on the
reasoning that a franchisee buys from the org rather than a branch. Ian corrected that mid-build —
Lipa *makes* the bulgogi sauce a franchisee buys — and it is now the section above. Left visible
rather than quietly deleted: the wrong reasoning is worth seeing next to the right one.

## Done when

- [ ] Migration hand-written per DEF-073, journalled with `previous.when + 86400000`.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green.
- [ ] `docs/ROADMAP.html` updated.
