# T-147 — Supplier-item catalogue: who sells what

> **Status:** Spec written 2026-08-28 by the Opus planner, implemented same session.
> **Depends on:** T-145 (`items`, `supplier_invoice_lines`), T-130 (`suppliers`).
> **Blocks:** T-146 (invoice OCR — this is what makes matching tractable).
> **Assessed before specced**, per bible row 163. Ian chose to build it after the assessment
> below; the assessment is recorded because the reason he gave is **not** the reason to build it.

## The assessment, and why the stated reason does not hold

Ian, 2026-08-28: *"tag each inventory with supplier like lettuce again supplier a and supplier b
can be tagged so price comparison is posible."*

⛔ **Price comparison already works without this.** T-145 shipped `itemsRepo.priceBySupplier`,
which answers *"who sells lettuce, and at what ₱/kg"* by reading `supplier_invoice_lines` —
actual transactions, cheapest first, already rendered on the item detail page. A tag is a
**declaration**; an invoice line is **evidence**. This project has refused a stored copy of a
derivable fact seven times (DEF-075's family); an "approved supplier" tag that nobody has bought
from is exactly that shape.

**So this task is NOT built for price comparison.** It is built for three other reasons, and the
first is the one that matters:

1. ⭐ **It is what makes T-146's OCR viable.** Turning `"LETTUCE ICEBERG 5KG"` into an `item_id`
   against 385 items is guesswork; against the ~20 items *this supplier has ever billed* it is
   tractable. Without this table, OCR matching is a fuzzy-string problem across the whole
   catalogue.
2. **Entry quality.** Filtering the line-item picker to a supplier's own items means fewer wrong
   picks — which protects the price history at its source, where it is cheap to protect.
3. **Sourcing visibility.** *"Only one supplier has ever sold us this"* is a real risk signal, and
   it is invisible until the relationship is a thing you can query.

## Grounding — read as requirements, not design (bible §1.2b)

- ⛔ **v1 has NO supplier-item link at all** — verified by reading `ERP-rebuild`'s
  `src/types/index.ts`: items carry no supplier, suppliers carry no items, and no
  `supplierItems` / `preferredSupplier` / `approvedSupplier` shape exists anywhere. New
  capability, not a port. The four verbs give only *add*.
- **Industry practice.** This is a standard ERP construct — Oracle's
  [Approved Supplier List](https://docs.oracle.com/en/cloud/saas/procurement/24c/oaprc/approved-supplier-list.html),
  Dynamics 365's [approve vendors for specific products](https://learn.microsoft.com/en-us/dynamics365/supply-chain/procurement/tasks/approve-vendors-specific-products),
  SAP's purchasing info record. The common name for the general form is an **item/vendor
  cross-reference**. ([Fitrix](https://www.fitrix.com/strategically-using-approved-vendor-lists),
  [SourceDay](https://sourceday.com/blog/approved-supplier-list/))
- ⚠️ **The half of the industry pattern we deliberately DO NOT copy:** a purchasing info record
  carries a *price* (and often lead time and minimum order). Storing a price here would be
  DEF-075 for the eighth time, and it would drift from the invoice lines that actually say what
  we paid. **This table holds the relationship only.**
- **Approved vs preferred**, which the sources distinguish: *approved* = may be bought from;
  *preferred* = should be bought from first. This task builds neither as a policy — it records
  **observed** and **declared**, which is weaker than both and is all the evidence supports today.

## Goal

Every supplier knows what it has sold us, without anybody maintaining a list — and can be told
what it *could* sell us, when somebody wants to say so.

## Scope

**New files**
- `packages/db/schema/supplier-items.ts` — `supplier_items`.
- `packages/db/migrations/0048_t147_supplier_item_catalogue.sql`, hand-written (DEF-073).

**Existing files modified**
- `packages/db/src/repo/items.ts` — `linkSupplierItem`, `itemsForSupplier`, `suppliersForItem`;
  `insertInvoiceLines` gains the auto-link.
- `packages/domain/src/items/index.ts` — `declareSupplierItem`, `undeclareSupplierItem`.
- `packages/db/src/cutover/classification.ts`, `packages/db/src/rls/registry.ts`.
- `apps/erp/src/app/ap/**` — the invoice line picker filters by supplier.
- `apps/erp/src/app/items/[id]/page.tsx` — show who sells this.

## Contract

⚠️ **CORRECTED 2026-08-28, before any code, by running `/research-evaluate-propose` on this very
spec.** The first draft stored TWO kinds of link — `observed` (written by the system from an
invoice line) and `declared` (typed by a human). The observed half is
`SELECT DISTINCT supplier_id, item_id` over `supplier_invoice_lines`. **Storing it caches a query
the ledger already answers — DEF-075's pattern for the eighth time, inside the very spec whose
own invariant 1 refuses it for price.** Only the declared half is a fact with nowhere else to live.

### 0. ⛔ PREREQUISITE — the AP invoice form has no line entry

`recordInvoice` has accepted `lines` since T-145 and **the ERP form has never sent any**. There
are 0 rows in `supplier_invoice_lines`, and not because nobody bothered: there is no field to type
one into. Every downstream feature — price history, supplier comparison, this catalogue, T-146's
OCR — reads that table.

⚠️ **This is the same failure bible row 163 was written about, committed by the author of row
163.** T-141 built an upload broker nothing called; T-130 then invented a text field because it
found no wired upload. T-145 built line storage nothing calls. **Wiring the form is therefore part
of this task**, and is the half that actually unblocks anything.

### 1. `supplier_items` — declarations only

```
supplier_items
  id           uuid PK default uuidv7()
  org_id       uuid NOT NULL FK organizations, restrict
  supplier_id  uuid NOT NULL FK suppliers, restrict
  item_id      uuid NOT NULL FK items, restrict
  notes        text
  created_by   uuid NOT NULL FK persons, restrict   -- always a human; that IS the point
  created_at   timestamptz NOT NULL default now()

  unique (supplier_id, item_id)
```

⭐ **There is no `source` column, because every row means the same thing:** *"a person says we
could buy this here."* A link the invoices already prove is not stored at all.

⭐ **`created_by` is NOT NULL** — the previous draft made it nullable so the system could write
rows. Nothing but a human writes here now, so the author is always known.

### 2. The catalogue is a QUERY over two sources

`itemsForSupplier(orgId, supplierId)` and `suppliersForItem(orgId, itemId)` each return rows
carrying a `source` discriminator computed at read time:

- **`observed`** — a `DISTINCT` join through `supplier_invoice_lines` → `supplier_invoices`, with
  `firstSeenOn = MIN(invoice_date)` and `timesBilled = COUNT(*)`. Cannot go stale; there is
  nothing to keep in step.
- **`declared`** — a row in `supplier_items` with no invoice behind it yet.

⚠️ **Observed wins on collision, and needs no promotion logic.** If a declared link later gets an
invoice, the query reports it as `observed` with its real date — the `supplier_items` row simply
stops mattering. The previous draft needed a promotion step and an invariant forbidding demotion;
both disappear when the fact is derived.

⚠️ **A voided invoice still counts as observed.** The supplier did bill us that item; voiding is a
correction to the money, not evidence the relationship never existed. Stated because the opposite
reading is defensible and would make the catalogue flicker.

### 3. Verbs

`declareSupplierItem` / `undeclareSupplierItem` require `manage_items` (org, manager+, T-145).
⛔ **Undeclare can only remove a declaration**, which is now structural rather than a rule: an
observed link is not a row, so there is nothing to delete. *"You cannot un-buy something"* is
enforced by the design instead of by a check.

## Invariants

1. **Nothing derivable is stored.** No price, no lead time, no minimum order — and no observed
   link. DEF-075's pattern, refused an eighth time, including against my own first draft.
2. **One declaration per (supplier, item).** Unique index.
3. **Every declaration has a human author.** `created_by NOT NULL`.
4. **A voided invoice does not retract an observed link.**
5. **Org-scoped by RLS**, like `items`.
6. ⭐ **The AP invoice form can enter lines**, and what it writes is what `priceHistory` reads.
   An unwired feature is an unbuilt one.

## Tests

Written before implementation (bible §3.2), against real Postgres (§9.3).

1. An invoice line makes the item appear in `itemsForSupplier` as `observed`, with
   `firstSeenOn` = the invoice date and `timesBilled` = 1. **No row is written to
   `supplier_items`.**
2. A second invoice for the same supplier + item keeps the FIRST date and raises `timesBilled`
   to 2.
3. A declared link reports as `declared`; once an invoice proves it, the SAME pair reports as
   `observed` with the real date — and appears exactly once, not twice.
4. `undeclareSupplierItem` removes a declaration; the observed link survives it, because the
   observation was never a row.
5. `itemsForSupplier` returns only that supplier's items; `suppliersForItem` the reverse.
6. Voiding the invoice leaves the observed link standing (invariant 4).
7. Org isolation: org A's declarations are invisible to org B.
8. ⭐ End to end: the AP form's line fields produce rows in `supplier_invoice_lines`, which
   produce a price in `priceHistory` and an entry in `itemsForSupplier`. Proves invariant 6.

## Out of scope

Approved-vs-preferred as a *policy* (blocking a purchase from an unapproved supplier) · lead
times, minimum order quantities, supplier SKUs or barcodes · price on the link, in any form ·
using the catalogue to filter anything other than the line-item picker · OCR itself (T-146).

## Done when

- [ ] Invariants pass against real Postgres.
- [ ] Migration hand-written per DEF-073, journalled with `previous.when + 86400000`.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green.
- [ ] Table classified in `cutover/classification.ts` and registered in `rls/registry.ts`.
- [ ] `docs/ROADMAP.html` updated — the rule added 2026-08-28.
