# T-145 — Item master, supplier invoice lines, and price history

> **Status:** Spec written 2026-08-28 by the Opus planner, implemented same session.
> **Depends on:** T-130 (supplier invoices — the lines hang off them), T-129 (`price_list_items`,
> whose `item_code` has been waiting for this table), T-141 (nothing directly, but the same
> "wire what was built" lesson).
> **Blocks:** Phase 3 inventory (this is the identity half of v1's item record; the stock half
> is deliberately not built here).
> **Why now:** Ian, 2026-08-28 — *"yes, i want to track item prices over time."*

## Why this task, and what it actually is

Ian asked to track item prices over time. The research pass says that is **impossible on the data
shape either system has today**, and the reason is identity, not storage.

**Measured in v1's live production data**, not inferred:

| Finding | Number |
|---|---|
| Item records across six stores | **842** |
| Distinct item *names* | **385** |
| Names existing in more than one store, as separate records | **187** |
| `costPerUnit` that is zero — i.e. never maintained | **595 of 842 (71%)** |
| Items whose purchase unit ≠ base unit | **66** |
| Cost fields on `inventoryLedger` | **none** |

Four consequences, each of which independently defeats a price chart:

1. **Items are per-store.** `stores/{storeId}/items` — `domex` is four different documents with
   four different ids and four different costs. There is nothing to group by.
2. **Units disagree across stores for the same product.** `white onion` is ₱61/**kg** at Lipa,
   ₱130/**kg** at Malvar, and priced in **pcs** at Padre Garcia. Those numbers cannot be compared,
   let alone averaged.
3. **`costPerUnit` is a snapshot, overwritten in place, and mostly zero.** It is not history and
   was never maintained as one.
4. **`inventoryLedger` records quantity movements with NO cost.** Fields are `businessDate`,
   `direction`, `quantity`, `unit`, `productId`… and nothing about money.

⭐ **So there is no price history in v1 to preserve.** This is new capability, not a port — worth
saying plainly, because every other task in this project has had a v1 behaviour to duplicate or
correct. Here the four verbs give us only *add*.

⛔ **And the missing table is one T-129 already named.** `price_list_items.item_code` carries the
comment *"⚠️ Opaque text, not a FK — there is no item master in v2 yet… ⛔ This becomes a foreign
key the day an item master lands."* Same shape `expenses.supplier_id` had before T-130. One table
answers both.

## Grounding — read as requirements, not design (bible §1.2b)

- **`stores/{storeId}/items`** (v1, live). Real fields: `name`, `kind`, `baseUnit`,
  `purchaseUnit`, `conversionFactor`, `costPerUnit`, `sellPrice`, `isActive`, `perishable`,
  `batchTracked`, `departmentIds`, `reorderPoint`, `reorderQuantity`, `totalOnHand`, `legacyId`,
  `sortOrder`, `storeId`, `expenseEntryId`. **The identity half is `name`/`kind`/units/`isActive`;
  everything else is stock behaviour and belongs to Phase 3.**
- **`kind` vocabulary, from live data:** `raw_material` (340), `supply` (207), `retail` (234),
  `meat_slab` (17), `meat_sliced` (44). Ported as-is — these are the business's own words, and
  the meat split is real (`[[project_meat_id_spaces]]`).
- **Unit vocabulary, from live data.** Base: `pcs` (605), `kg` (184), `pack` (26), `roll` (9),
  `ltr` (8), `box` (7), `g` (3). Purchase adds `dozen`, `case`, `sack`, `tray`.
  ⚠️ **`box` and `pack` appearing as BASE units is a modelling error in v1** — a box is a
  container, not a unit of measure. Corrected here (see Contract §1).
- **Conversion pathologies, from live data.** `pack→pack` on **7** items and `box→box` on **1**,
  each with a conversion factor ≠ 1. A factor between identical units is meaningless. The
  industry guidance below names exactly this as the thing to auto-flag.
- **Industry practice** ([Cleverence](https://www.cleverence.com/articles/for-business/uom-in-inventory-4821/),
  [Aptean](https://www.aptean.com/en-US/insights/blog/multiple-units-of-measure-with-erp),
  [SYSPRO](https://us.syspro.com/blog/owning-or-running-erp/how-do-units-of-measure-uom-work-within-an-erp-system/)):
  one base unit per item with every other unit defined relative to it, so conversions never form
  a cycle; purchase UoM and stocking UoM are separately meaningful; an invoice's unit price is
  expressed **per purchase unit** and must be normalised before comparison; and impossible
  conversions should be flagged rather than silently accepted.
- **Bible §16.1 invariant 3 / DEF-075** — no stored balance beside the ledger. Applied here to
  price: **there is no `current_cost` column and no price-history table.** Price history is a
  QUERY over invoice lines, exactly as `openItems` is a query over expenses.

## Goal

One org-level identity per purchasable thing, with one canonical unit; every supplier invoice
carries the lines that make it up, priced in whatever unit the supplier actually billed; and
"what have we paid per kilo for pork belly, month by month, across every store" is a query with a
single correct answer.

## Scope

**New files**
- `packages/db/schema/items.ts` — `items`.
- `packages/db/schema/supplier-invoice-lines.ts` — `supplier_invoice_lines`.
- `packages/db/src/repo/items.ts` — item CRUD, `priceHistory`, `priceMovement`.
- `packages/domain/src/items/index.ts` — `createItem`, `updateItem`, `deactivateItem`.
- `packages/db/migrations/0047_t145_item_master_and_invoice_lines.sql`, hand-written (DEF-073).
- `apps/erp/src/app/items/**` — item register, item detail with its price chart.

**Existing files modified**
- `packages/db/schema/customers.ts` — `price_list_items.item_code` → `item_id uuid` FK.
- `packages/db/schema/suppliers.ts` — nothing structural; lines reference the invoice.
- `packages/domain/src/ap/index.ts` — `recordInvoice` accepts lines; `verifyInvoice`'s
  `attestedItems`/`attestedPrice` become machine-checkable when lines exist.
- `packages/db/src/cutover/classification.ts`, `packages/db/src/rls/registry.ts` — both new tables.

## Contract

### 1. `items` — org-level identity, one canonical unit

```
items
  id             uuid PK default uuidv7()
  org_id         uuid NOT NULL FK organizations, restrict
  code           text NOT NULL            -- short human key, e.g. PORK-BELLY
  name           text NOT NULL
  kind           text NOT NULL check in ('raw_material','supply','retail','meat_slab','meat_sliced')
  base_unit      text NOT NULL check in ('pcs','kg','g','ltr','ml','roll')
  status         text NOT NULL default 'active' check in ('active','inactive')
  notes          text
  created_by     uuid NOT NULL FK persons, restrict
  created_at     timestamptz NOT NULL default now()
  updated_at     timestamptz

  unique (org_id, code)
  unique (org_id, lower(name))    -- "Pork Belly" and "pork belly" are one thing
```

⭐ **Org-level, not per-store — the whole point.** v1's per-store items are why 187 names exist
as separate records. A price question spanning stores needs one row to group by.

⛔ **`base_unit` excludes `box` and `pack`.** v1 has 33 items whose base unit is a container; a
container is a quantity of something, not a unit of measure. Containers are *purchase* units and
live on the line, with a factor converting them to the base.

**Deliberately omitted, each with a reason:**
- `total_on_hand`, `reorder_point`, `reorder_quantity`, `batch_tracked`, `perishable`,
  `department_ids` — the STOCK half of v1's item. Phase 3 owns it. Adding columns nothing reads
  is DEF-071's shape.
- `cost_per_unit`, `sell_price` — ⛔ **DEF-075, the seventh time.** Cost is derived from invoice
  lines (§3); a stored one is the column that is zero for 71% of v1's items.
- `store_id` — this table exists precisely to not have one.

### 2. `supplier_invoice_lines` — what the bill was actually for

```
supplier_invoice_lines
  id                  uuid PK default uuidv7()
  supplier_invoice_id uuid NOT NULL FK supplier_invoices, cascade
  line_no             int  NOT NULL
  item_id             uuid NOT NULL FK items, restrict
  description         text                     -- what the supplier called it, verbatim
  quantity            numeric(14,3) NOT NULL check > 0
  purchase_unit       text NOT NULL            -- the unit the supplier billed in
  conversion_factor   numeric(14,6) NOT NULL check > 0   -- purchase_unit -> item.base_unit
  unit_price          numeric(14,4) NOT NULL check >= 0  -- per PURCHASE unit, as billed
  line_total          numeric(14,2) NOT NULL check >= 0

  unique (supplier_invoice_id, line_no)
  check: round(quantity * unit_price, 2) = line_total   -- the line must be arithmetic
```

⭐ **`conversion_factor` is SNAPSHOTTED on the line, never looked up later.** This is the single
most important decision in this task. If the factor lived only on the item and a price query
joined to it, then correcting a pack size next year would silently rewrite what we paid last
year. A historical price is a fact about a past transaction; the numbers that produced it belong
on the row. ⚠️ This is the deliberate *opposite* of the derive-don't-store rule elsewhere, and the
distinction is real: a balance is a consequence of facts and must be recomputed; a conversion used
in a past transaction **is** a fact.

⚠️ **`purchase_unit` = `item.base_unit` requires `conversion_factor = 1`** — service-layer check,
because a CHECK cannot reach the item. This is v1's `pack→pack ×N` pathology (7 items) and the
industry guidance's "auto-flag impossible conversions", made impossible instead of flagged.

**Cascade, not restrict, on the invoice** — a line is genuinely part of its invoice, not an
independent record that could outlive it (same reasoning as `price_list_items` → `price_lists`).

**Lines are OPTIONAL on an invoice, and that is deliberate.** Requiring them would make every
utility bill and every service invoice unenterable. When lines exist they must sum to the header:

```
check (service layer): SUM(line_total) = supplier_invoices.total_amount, within ₱0.01
```

### 3. Price history — a query, never a table

`packages/db/src/repo/items.ts`:

- **`priceHistory(orgId, itemId, { from, to, storeId? })`** → one row per invoice line, with
  `businessDate` (the invoice's own date), `supplierId`, `storeId`, `quantity`,
  `purchaseUnit`, `unitPrice`, and the two derived figures that make comparison possible:
  - `baseQuantity   = quantity * conversion_factor`
  - `basePrice      = line_total / (quantity * conversion_factor)`   — ₱ per `item.base_unit`
- **`priceMovement(orgId, itemId, { months })`** → `basePrice` bucketed by calendar month:
  min, max, weighted average (`SUM(line_total) / SUM(base_quantity)`, never a mean of means).
- ⛔ Voided invoices are excluded; a voided bill is not evidence of a price.

⭐ **Nothing is stored.** No `current_cost`, no `price_history` table, no monthly rollup. Every
figure recomputes from the lines, so it cannot go stale the way `costPerUnit` did — and
`costPerUnit` being zero on 71% of v1's items is the argument, not a hypothetical.

### 4. `price_list_items.item_code` → `item_id`

The FK T-129 promised. Its own comment: *"⛔ This becomes a foreign key the day an item master
lands."* Clean replacement, not expand/contract — v2 opens from zero (bible §1.4) and the dev
database holds a single row.

## Invariants

1. **One identity per purchasable thing, org-wide** — `unique (org_id, lower(name))`. v1's 187
   duplicate-name records across stores are the defect this prevents.
2. **One base unit per item; every other unit is defined relative to it** — industry practice,
   and the only way `SUM(base_quantity)` means anything.
3. **A conversion factor used in a transaction is snapshotted on that transaction.** Correcting
   an item's pack size must never change what a past invoice says we paid.
4. **A base unit is a unit of measure, never a container.** `box`/`pack`/`case`/`sack`/`tray`/
   `dozen` are purchase units only.
5. **`purchase_unit = base_unit` ⟹ `conversion_factor = 1`.** Refused, not flagged.
6. **Lines, when present, sum to the invoice header** within ₱0.01.
7. **No stored cost anywhere** — DEF-075's pattern, refused the seventh time.
8. **A voided invoice's lines never appear in price history.**
9. **Items are org-scoped by RLS**, same as `customers` and `suppliers`.

## Tests

Written before implementation (bible §3.2), against real Postgres (§9.3).

1. Two invoices for the same item a month apart at different prices → `priceHistory` returns
   both, in order, with correct `basePrice`.
2. An item bought by the **case** (×24) and by the **piece** in the same month → both normalise
   to the same `basePrice` scale; the weighted average is `SUM(total)/SUM(baseQty)`, not a mean
   of means.
3. ⭐ **Editing the item's pack size does NOT change historical prices** — invariant 3, the
   reason `conversion_factor` is on the line.
4. Lines that do not sum to the header are refused.
5. `purchase_unit = base_unit` with a factor ≠ 1 is refused (v1's `pack→pack` pathology).
6. A voided invoice's lines vanish from price history; the invoice stays visible.
7. Two items cannot share a name differing only by case.
8. An invoice with no lines is still valid and posts normally (utility bills).
9. `price_list_items` resolves its item through the FK.
10. Org isolation: org A cannot see org B's items.

## Out of scope

Stock on hand, reorder points, batch/expiry, departments, wastage, transfers, `sell_price` and
retail pricing, purchase orders, three-way match, landed cost, and any change to how expenses post
to the ledger. **Lines describe the bill; they do not value inventory** — that is Phase 3, and
conflating the two is how a price feature becomes an inventory migration.

## Done when

- [ ] Invariants pass against real Postgres.
- [ ] Migration hand-written per DEF-073 and journalled with `previous.when + 86400000`.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green, every
      pre-existing test still passing. **No `npm run lint`** — DEF-027.
- [ ] Both new tables classified in `cutover/classification.ts` and `rls/registry.ts`.
- [ ] `docs/ROADMAP.html` updated — the rule added 2026-08-28.
- [ ] Any spec defect found while implementing — reported, never silently worked around (§3.4a).
