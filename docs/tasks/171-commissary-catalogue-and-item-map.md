# T-171 — What a branch may order, at what price, called what

> **Status:** ✅ **WRITERS, READ PATH AND SCREEN BUILT, 2026-09-03 (DEF-129)** — `packages/db/src/repo/commissary-catalogue.ts` and `packages/domain/src/commissary/catalogue.ts` (links, offerings, the map — every writer this table never had), `apps/erp/src/app/commissary/catalogue/`, two capabilities, `commissary-catalogue.test.ts` (11 tests, green). The catalogue READ path and the price fallback (§4 `orderableCatalogue`, `listAvailableCommissaries`, §5's tiers) shipped the same day inside T-172's `orders.ts`, because the order form is their first reader. ⛔ **Bulk import (`importCatalogueIntoBranch`) is NOT built — §10.** Data layer: migration `0069`, 2026-08-29.
> **Depends on:** T-145 (`items`, org-level), T-149 (`store_item_sellability`), T-151
> (`item_pricing`, landed cost), T-129 (`customers` and `counterparty_store_id`).
> **v1 read at source** — `branch-order.actions.ts:68-248`, `commissary-item-config.actions.ts`,
> `commissary-item-map.actions.ts`, `commissary-import.actions.ts`, pricing math `pricing.ts:1-123`.
> `docs/discovery/14` §O rows 1–7.
> **First task of the commissary pipeline — the ~24 capabilities `CAPABILITY-GAPS.md` names as the
> largest single omission in the plan.**

## 1. Goal

A branch can see what its commissary sells, at the price it will be charged, mapped to the item the
branch already has in its own catalogue — so that by the time an order is placed, nothing about
what arrives is still undecided.

## 2. ⭐ Most of this is already built, and that is worth knowing before starting

T-145, T-149 and T-151 shipped three of the seven capabilities this task covers, and they shipped
them **better than v1**:

| v1 | v2 today |
|---|---|
| `commissaryItemConfig` per store, holding pricing mode and a rolling `lastReceivedCost` | ✅ `item_pricing` (T-151) — **the basis is derived from invoice history, stored nowhere**, so v1's ₱1,458-chopstick poisoning cannot happen |
| `max(prior lastReceivedCost, newCost)` | ✅ Same rule, derived per read |
| `marginAlertThresholdPct` | ✅ Same, advisory |
| 842 item records for 385 real products, per store | ✅ One org-level `items` row per product; what varies by store is `store_item_sellability` |

> ⛔ **Do not build a `commissary_item_config` table.** It would be a per-store item master by
> another name — the exact thing T-145's header calls out: *"the moment this table grows a name or
> a unit, it has become that."*

**What is genuinely missing is the cross-store correspondence**, and it is one table.

## 3. Scope

**Create:** `packages/db/schema/commissary-catalogue.ts` ·
`packages/db/migrations/<next>_t171_commissary_catalogue.sql` ·
`packages/domain/src/commissary/catalogue.ts` ·
`packages/db/src/repo/commissary-catalogue.ts` ·
`apps/erp/src/app/commissary/catalogue/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/commissary-catalogue.test.ts`

**Modify:** barrels · `classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` ·
`_journal.json` · `docs/ROADMAP.html`

## 4. Contract

```
commissary_links                       -- which branch may order from which commissary
  id, org_id
  commissary_store_id -> stores
  branch_store_id     -> stores
  status  'active' | 'inactive' NOT NULL default 'active'
  created_by, created_at
  unique (commissary_store_id, branch_store_id)
  check  (commissary_store_id <> branch_store_id)

commissary_item_offerings              -- what this commissary will dispatch
  id, org_id, commissary_store_id -> stores
  item_id  uuid NOT NULL -> items
  status   'active' | 'inactive' NOT NULL default 'active'
  manual_cost numeric(14,4) NULL       -- tier 3 of the basis fallback, §5
  created_by, created_at, updated_at
  unique (commissary_store_id, item_id)

commissary_item_map                    -- ⭐ the cross-store correspondence, and it is NOT a UOM concept
  id, org_id
  commissary_store_id, branch_store_id -> stores
  commissary_item_id -> items
  branch_item_id     -> items          -- NOT NULL. v1's nullable had two meanings (a hazard, 01-data-model:245)
  expense_category_id uuid NULL -> expense_categories   -- the branch's own COGS classification
  created_by, created_at
  unique (commissary_store_id, branch_store_id, commissary_item_id)
```

```ts
listAvailableCommissaries(branchStoreId): Promise<Store[]>          // one query, not N
orderableCatalogue(commissaryStoreId, branchStoreId): Promise<CatalogueLine[]>
  // -> { commissaryItemId, branchItemId | null, name, baseUnit, price, marginAlert? }
upsertOffering / upsertMap / removeMap
importCatalogueIntoBranch(commissaryStoreId, branchStoreId): Promise<ImportReport>
```

## 5. The price, and it is T-151's function called from here

**Basis fallback, three tiers, in order** (v1's `resolveBasisCost`, kept exactly):

1. A linked **`cost_basis_item_id`** — sliced meat prices off its source slab, *because the slab is
   what was actually bought and so is the only thing with a real received cost.*
2. The item's own **landed price history** (T-151, derived).
3. A manager-set **`manual_cost`** on the offering.

⛔ **Nothing prices at a silent zero.** With all three empty, the catalogue line returns a **priced:
false** marker and the order form refuses to add it — a visible refusal, not a ₱0 line that becomes
a ₱0 order that becomes a ₱0 receivable.

⭐ **"Max of the last two landed receives" is the basis rule** — one cheap lot must not drop the
branch price below what expensive stock still in inventory cost. Already implemented in T-151;
called, not reimplemented.

## 6. Invariants

1. **A store cannot be linked to itself**, and a link is unique per pair.
2. ⭐ **`branch_item_id` is NOT NULL.** v1 allowed null with two different meanings — *"not mapped
   yet"* and *"deliberately ledger-only"* — which `01-data-model.md:245` already flags as a hazard.
   **A deliberate ledger-only decision is its own column** (`is_ledger_only boolean`), not an
   overloaded null.
3. **An offering must be an item the commissary can actually supply** — `is_purchasable` or
   produced by it. Refused otherwise.
4. **The map is per (commissary, branch, item)**, so two branches may map the same commissary item
   to two differently-named local items. That is the correspondence problem, and it is real.
5. **Pricing calls T-151. This task computes no price of its own.** A second copy of the markup
   rule is the second source of truth this project removes.
6. **An unpriceable item is marked unpriceable, never zero** — §5.
7. **The margin alert is advisory and never blocks** (T-151 invariant 7).
8. **Bulk import is idempotent**: it skips items already mapped, reuses a same-name branch item
   rather than duplicating, and **reports unit conflicts for manual resolution** instead of
   guessing a conversion. ⭐ The refusal-to-guess is v1's own rule and it is right —
   *"guessing one here would deduct the wrong quantity forever."*
9. **RLS: a caller must have access to at least one side of the pair**, and may only edit the side
   they hold. A commissary manager owns the offerings; a branch manager owns the map and the
   expense category.

## 7. Tests

1. `listAvailableCommissaries` returns the linked commissaries in one query — asserted by query
   count, because *"one round-trip rather than N"* was v1's stated design and is easy to lose.
2. The catalogue joins offering + item + price and returns a priced line.
3. An item with a `cost_basis_item_id` prices off the slab; with the slab's history empty it falls
   to its own; with both empty it uses `manual_cost`; with all three empty it returns
   `priced: false`.
4. ⭐ `max` of the last two landed receives holds: a cheap lot after an expensive one keeps the
   expensive basis.
5. The margin alert fires below the threshold and the line is still orderable.
6. `branch_item_id` NULL is refused by the database.
7. Bulk import run twice adds nothing the second time; a same-name branch item is reused, not
   duplicated; a unit conflict is reported and **not** auto-converted.
8. A self-link is refused.
9. A branch manager cannot edit the commissary's offerings; a commissary manager cannot edit the
   branch's map. Both asserted.
10. Live route on 9008: a branch sees a priced catalogue.

## 8. Out of scope

⛔ **A `commissary_item_config` table.** §2.
⛔ **Ordering.** T-172.
⛔ **Any posting.** This task moves no stock and no money.
⛔ **External / franchise price lists.** ADR-008 §3 and T-129 own those. ⚠️ A franchise is a
customer with a price list, **not** a commissary link — and conflating them is how the eliminating
transfer gets applied across a legal-entity boundary (bible row 111).

## 9. Done when

- [x] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000` —
      `0069`, 2026-08-29. No further migration was needed for the writers.
- [x] `classification.ts`: **KEEP** — this is configuration, like `items` and `item_pricing`.
      ⚠️ Not PURGE: a branch's catalogue and map are exactly the kind of setup nobody wants to
      re-enter on 1 January. `rls/registry.ts` NULLIF-guarded. (2026-08-29.)
- [x] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first) — 2026-09-03, real numbers in the commit message.
- [x] `CAPABILITY-MATRIX.md`: `manage_commissary_offerings`, `manage_commissary_map` — each with
      its ✗ test (role AND store-scope, both directions, `commissary-catalogue.test.ts`).
      ⛔ **`import_commissary_catalogue` deliberately NOT declared**: the bulk import is unbuilt, and
      a capability with no caller is one nobody has proved refuses anyone (the pin in
      `tests/unit/capability-matrix.test.ts` exists to expose exactly that debt). Declare it with
      the import.
- [x] `docs/ROADMAP.html` updated.
- [x] Live on 9008, 2026-09-03: link → two offerings → two map rows through the screen, then a
      branch order placed against them (T-172 §12.6).

## 10. ⭐ Built 2026-09-03 — what shipped, and what did not

**Shipped.** `upsertCommissaryLink` (commissary side; ⭐ also creates the branch's INTERNAL
customer row if none exists — `trade_orders.customer_id` is NOT NULL and names the branch through
`counterparty_store_id`, so a branch that may order always has one; the reasoning for not routing
that through `createCustomer`'s admin gate is in the function's own comment), `upsertOffering`
(refuses an inactive or non-purchasable item — invariant 3), `upsertMap` (refuses an unlinked pair,
an unknown category, and ⭐ **mismatched base units** — invariant 8's refusal-to-guess, applied at
map time so `confirmReceipt` never has to refuse the stock later), `removeMap`. The screen is one
page with three sections — links, offerings, and the map per linked branch. `orderableCatalogue`
and `listAvailableCommissaries` (§4) and the three-tier price (§5 — T-151's `branchPriceFor`, then
the offering's `manual_cost`, never a silent zero) live in T-172's `orders.ts`.

**Not shipped, named.** `importCatalogueIntoBranch` (§4, invariant 8, test 7) — the idempotent
bulk import with same-name reuse and unit-conflict reporting. Nothing today needs it: a branch is
mapped one item at a time on the screen, and the dev catalogue is a handful of items. Build it
when a branch with hundreds of lines is onboarded; declare `import_commissary_catalogue` then.
Tests 1, 3–5 of §7 (the query-count assertion and the price tiers) are covered indirectly by
`branch-orders.test.ts` (rate resolution, `priced: false`) rather than by a catalogue test of their
own.
