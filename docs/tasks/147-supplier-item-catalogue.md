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

```
supplier_items
  id            uuid PK default uuidv7()
  org_id        uuid NOT NULL FK organizations, restrict
  supplier_id   uuid NOT NULL FK suppliers, restrict
  item_id       uuid NOT NULL FK items, restrict
  source        text NOT NULL check in ('observed','declared')
  first_seen_on date                      -- the invoice date that first proved it. NULL when declared
  notes         text
  created_by    uuid FK persons, restrict -- NULL when the row wrote itself
  created_at    timestamptz NOT NULL default now()

  unique (supplier_id, item_id)
```

⭐ **`source` is the whole design.** `observed` means *"this supplier has actually billed us this,
and here is the invoice date that proves it"* — written automatically, by the system, from a real
line. `declared` means *"a human says we could buy this here"* — a claim, with an author.
Collapsing the two into one boolean would make an aspiration indistinguishable from a fact, and
the fact is the one OCR should trust.

⚠️ **`observed` wins.** If a link is `declared` and an invoice then proves it, it is promoted to
`observed` and stamped with the date. Never the reverse: evidence does not decay into opinion.

**`linkSupplierItem` runs inside `recordInvoice`'s transaction**, as a side effect of writing
lines. It takes no capability of its own — recording the invoice was already authorised, and a
link that failed while its line succeeded would be a silent inconsistency.

**`declareSupplierItem` / `undeclareSupplierItem`** require `manage_items` (org-scoped, manager+,
T-145). ⛔ Undeclare refuses an `observed` row: you cannot un-buy something. It may only remove a
`declared` one.

## Invariants

1. **No price, no lead time, no minimum order.** DEF-075's pattern, refused an eighth time.
   `priceBySupplier` already answers price from evidence.
2. **One row per (supplier, item).** Enforced by unique index.
3. **`observed` is written only by the system, from a real invoice line**, never by a form.
4. **`observed` never downgrades to `declared`**, and an `observed` link cannot be deleted.
5. **`declared` requires an author**; `observed` may have none, because nobody typed it.
6. **A voided invoice does not retract the link.** The supplier did bill us that item; voiding the
   bill is a correction to the money, not evidence that the relationship never existed. ⚠️ Stated
   because the opposite is a defensible reading and would produce a link that flickers.
7. **Org-scoped by RLS**, like `items`.

## Tests

Written before implementation (bible §3.2), against real Postgres (§9.3).

1. Recording an invoice with a line auto-creates an `observed` link stamped with the invoice date.
2. A second invoice for the same supplier + item does not create a second row, and keeps the
   FIRST date seen.
3. A `declared` link promoted to `observed` when an invoice proves it; the author survives.
4. An `observed` link is never demoted by a later declare.
5. `undeclareSupplierItem` refuses an `observed` link, and succeeds on a `declared` one.
6. `itemsForSupplier` returns only that supplier's items; `suppliersForItem` the reverse.
7. Voiding the invoice leaves the link standing (invariant 6).
8. Org isolation: org A's links are invisible to org B.

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
