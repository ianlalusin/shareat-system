# T-163 — The receipt posts value: `2120` GRNI, and the end of the expensing lag

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> ⏳ **Assumes ADR-011's recommendation** (retro-fit, boundary 2027-01-01). If Ian chooses the dated
> split, this task is unchanged — only T-165 changes.
> **Depends on:** T-162 (layers), T-130 (`supplier_invoices`), T-145 (`supplier_invoice_lines`),
> T-151 (landed cost), T-105 (`postEntry`).
> **Decided in ADR-009 amendment 1**, adopted from `docs/discovery/20` §1–§2.

## 1. Goal

Goods arriving post their value **at receipt**, into a real clearing liability — so the books are
never blind about stock that is physically on the shelf, and the supplier invoice **corrects** a
number that already exists instead of creating the first one.

## 2. ⭐ The measured problem this closes

ADR-009 counted it rather than assuming it:

| Month | Deliveries carrying a linked expense |
|---|---|
| 2026-05 | 91% |
| 2026-06 | 86% |
| 2026-07 | 89% |
| **2026-08** | **76%** ⬅ the **worst** month, not the best |

If linking were a new habit bedding in, August would be highest. It is lowest, and the shape fits
one explanation: **expensing LAGS delivery.** Goods arrive; the expense document is created later
when the invoice is processed.

⚠️ **And ADR-009's inversion makes it worse exactly where it matters:** stock on hand at any date is
disproportionately *recent* deliveries (1–2 week turnover), and recent deliveries are
disproportionately the *unlinked* ones. **The cost basis is weakest for precisely the stock that
needs valuing.**

> **This is not a discipline problem and cannot be fixed by asking people to be more diligent.** It
> is the direct consequence of treating "receive the goods" and "recognise the cost" as one act
> performed once, whenever a human gets to it. Splitting them is the fix.

## 3. The posting

### On receipt — provisional, at the typed landed cost

| Account | Dr | Cr |
|---|---:|---:|
| `1310` / `1320` / `1330` Inventory | 10,000.00 | |
| `2120` **Goods received not invoiced** | | 10,000.00 |

⭐ **`2120` already exists**, seeded `reserved` (`chart-of-accounts.ts:183`). This task **activates**
it. It is ERPNext's `stock_received_but_not_billed` — a clearing liability, **not AP**, because
nobody is owed a specific amount until a supplier says so.

### When the supplier invoice links — `2120` becomes real AP

| Account | Dr | Cr |
|---|---:|---:|
| `2120` Goods received not invoiced | 10,000.00 | |
| `2110` Accounts payable *(party = supplier)* | | 10,150.00 |
| `5450` **Purchase price variance** | 150.00 | |

⚠️ **`5450` does not exist yet and this task seeds it** — an expense leaf under `5000`, active.
It is where the difference between the receipt-time estimate and the invoice-time actual lands.
Odoo carries the same concept as `price_diff_value` on the valuation layer, described in its own
source as *"invoice value correction."*

### Which inventory account

From the item's `kind`, using COA-ALIGNMENT §4.1's already-decided crosswalk — not a new mapping:

| `items.kind` | Account |
|---|---|
| `raw_material`, `meat_slab`, `meat_sliced`, `retail` | `1310` Raw materials |
| `supply` | `1320` Supplies and packaging |
| *(produced by T-176's conversion)* | `1330` Prepped / commissary goods |

## 4. ⭐ Cost-confirmation is DERIVED — no `isExpensed` pair, ever

v1 stores `isExpensed` and `partiallyExpensed`, hand-set at **three independent call sites** that
each recompute the same two booleans. Discovery 20 §3 read the alternatives at source: ERPNext's
`per_billed: DF.Percent` and Odoo's `invoice_status` are both **re-derived and never written**;
Dolibarr's hand-toggled `billed` boolean is *called from nowhere* and is the field's own cautionary
tale.

**v2 stores neither.** A receipt's confirmation state is a query:

```ts
costConfirmation(receiptId): {
  provisionalValue: Money      // Σ layers still is_provisional
  confirmedValue:   Money      // Σ layers trued up by a linked invoice
  percentConfirmed: number
}
```

⭐ **The "items whose cost basis is incomplete" report ADR-009 asked for becomes a balance**, not a
flag scan: **anything sitting in `2120` is a receipt whose invoice has not arrived.** A real account
with a real balance, visible on the balance sheet, and impossible to forget to maintain.

## 5. Scope

**Create:** `packages/domain/src/stock/receipt-posting.ts` ·
`packages/domain/src/stock/cost-confirmation.ts` ·
`packages/db/migrations/<next>_t163_grni_and_ppv.sql` (activate `2120`, seed `5450`) ·
`packages/domain/tests/integration/receipt-posting.test.ts`

**Modify:** `packages/db/seed/chart-of-accounts.ts` (`2120` → `active`, add `5450`) ·
`packages/db/schema/stock-layers.ts` (`invoice_line_id` nullable FK) ·
`packages/domain/src/ap/index.ts` (the link path calls the true-up) ·
`packages/db/src/repo/findings.ts` (one detector) · `docs/POSTING-PATTERNS.md` (two new patterns) ·
`tests/worked-examples/fixtures.ts` · `docs/decisions/COA-ALIGNMENT.md` (record `5450`) ·
`_journal.json` · `docs/ROADMAP.html`

## 6. Invariants

1. **A receipt posts value in the same transaction as its stock movement.** No overnight job, no
   drift window (§16.11).
2. **The credit is `2120`, never `2110`.** AP is raised only when a supplier invoice exists — until
   then no party is owed a stated amount, and `party_id` would be a guess.
3. **Linking an invoice clears `2120` for exactly the receipt lines it covers** — never a bulk
   sweep of the account.
4. ⭐ **A cost variance is posted, never blocked.** v1's own comment: *"bookkeepers must be able to
   link a centavo-rounded supplier invoice even when it doesn't reconcile to the kg × unitCost
   figure exactly."* **Keep the judgement, fix the machinery** — the variance goes to `5450` and is
   visible, instead of surfacing as an unsettled UI badge nobody clears.
5. **The ₱0.99 tolerance survives as a named constant with its reason** (§16.6: purpose-tuned
   tolerances, never one global epsilon). Within tolerance: no `5450` line, the layer is trued up
   silently. Above it: a `5450` line **and** a finding.
6. **True-up re-values only the layer's open remainder** (T-162 invariant 10). Already-consumed
   quantity keeps its snapshotted cost; the difference is the `5450` amount.
7. **`is_provisional` flips to false only when an invoice line is linked**, and the link is a real
   FK — not a boolean somebody sets.
8. **Voiding a receipt reverses the layer, the movement and the entry in ONE transaction**
   (`reverseEntry`, T-106). ⛔ **Refused if any of the layer has been consumed** — the goods are
   gone; the correction is an adjustment, not a void. ⚠️ This is stricter than v1, which voided and
   let the stock go negative.
9. **Period lock applies to both postings** (invariant 7), including the true-up: an invoice
   arriving in March for a January receipt trues up **in March**, per row 103.

## 7. Tests

1. A 100 kg receipt at ₱300 posts `Dr 1310 30,000 / Cr 2120 30,000`, creates one layer of 100 @
   ₱300 marked provisional, and one `receipt` movement — **one entry, one transaction**.
2. Linking a ₱30,000 invoice posts `Dr 2120 30,000 / Cr 2110 30,000`, flips the layer to confirmed,
   and posts **no** `5450` line.
3. Linking a ₱30,150 invoice posts `Dr 2120 30,000 / Dr 5450 150 / Cr 2110 30,150`; the open
   remainder re-values to ₱301.50/kg.
4. ⭐ Ian's worked case with partial consumption: 100 kg received at ₱300, 40 kg consumed, then the
   invoice says ₱310. The 60 open re-value; the 40 consumed keep ₱300; `5450` takes ₱600; **January
   COGS does not move**.
5. A ₱0.60 variance (inside ₱0.99) posts no `5450` line and raises no finding.
6. A receipt with no invoice after N days raises `grniNotAtRest`, naming the supplier and the age.
7. `costConfirmation` returns 0% before any link, 100% after a full link, and 60% for a
   part-covered receipt — **read from balances, with no stored flag anywhere in the schema**.
8. Voiding an unconsumed receipt reverses all three artefacts and leaves `2120` at zero.
9. Voiding a partly-consumed receipt is **refused**, with an error naming the consumed quantity.
10. A true-up dated into a closed period posts to the current period instead, and says so.
11. **The whole `2120` account nets to zero** once every receipt in a fixture set is invoiced —
    the account-level version of the tie, run over the worked examples.

## 8. Out of scope

⛔ **The delivery document and its UI.** T-166. This task is the posting engine, driven by fixtures.
⛔ **A second document (Purchase Receipt + Purchase Invoice).** ADR-009 and discovery 20's
*"What NOT to adopt"* both refuse it: ~30 deliveries a month, one supplier line each.
⛔ **Landed-cost allocation.** T-151 derives it; this consumes it.
⛔ **Retro-fitting the shipped modules.** T-165, and it is deliberately last.
⛔ **Auto-matching an invoice to a receipt.** v1 **built and removed** it — *"the auto-link's
amount-match heuristic produced false positives at scale."* Do not re-introduce fuzzy matching.

## 9. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`;
      `2120` `reserved` → `active`; `5450` seeded active.
- [ ] `docs/POSTING-PATTERNS.md` gains `receipt.provisional` and `receipt.invoice-trueup`, both
      pinned by `tests/worked-examples/fixtures.ts` and the existing drift-guard test.
      ⚠️ **Regenerate the TOC** (`npm run toc`) or `toc-freshness.test.ts` fails the build.
- [ ] `COA-ALIGNMENT.md` records `5450` with its reason.
- [ ] `grniNotAtRest` registered in `repo/findings.ts` with a configurable age.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `docs/ROADMAP.html` updated.
