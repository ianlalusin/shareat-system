# T-164 — Consumption, wastage and count variance post — and every path is period-locked

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-162 (layers), T-163 (receipt posting), T-105/T-106 (`postEntry`/`reverseEntry`).
> **Closes:** §16.7 defect #5's second half (*"count adjustments have no GL effect"*) and defect #6
> (*"11 of 17 inventory/production paths have no period-lock guard"*).

## 1. Goal

Stock leaving the building posts its cost to the right account in the same transaction, so that
**gross margin moves with what was sold rather than with what happened to be bought** — the number
this whole design exists to make true.

## 2. The three exits, and they are three different accounts

| Event | Posting | Why not one account |
|---|---|---|
| **Consumption** — sold, used, issued | `Dr 5110`/`5120`/`5130`/… **· Cr** `1310`/`1320`/`1330` | The real cost of what was sold. Category from the item, per COA-ALIGNMENT §4.1 |
| **Wastage** — spoiled, damaged, expired | `Dr 5300` Wastage and spoilage **· Cr** inventory | ⭐ **A cost of sales, but not a cost of a sale.** Folding it into `5110` would make food cost look worse and hide the shrinkage — the whole point of the wastage reason taxonomy is to see it |
| **Count variance** — the shelf disagrees | `Dr`/`Cr 5400` Inventory adjustment **· Cr**/`Dr` inventory | Signed both ways. It is not a cost, it is a **correction**, and mixing it into COGS makes a counting error look like appetite |

All three accounts are already seeded and active (`chart-of-accounts.ts:310-338`).

⚠️ **v1 posts NO GL entry for a count adjustment at all** — *"NO GL, v1"*
(`stock-count.actions.ts`). That is a named gap to close, not a shape to port.

## 3. ⭐ The period lock, done once, for every caller

§16.7 defect #6: **11 of 17 v1 inventory/production paths have no period guard.** Stock posts into
closed periods and nobody finds out.

**The fix is not 17 guards.** It is that every stock posting in v2 goes through `postEntry`, which
already refuses a closed period (invariant 7, T-105) — and T-161 invariant 8 refuses the *movement*
independently. **Two independent refusals, neither of which any caller can forget**, because
neither is a call the caller makes.

> This task's contribution is to make that true by construction and prove it: a test per exit path
> asserting the refusal fires, so *"11 of 17"* cannot recur as *"3 of 12."*

## 4. Scope

**Create:** `packages/domain/src/stock/consumption-posting.ts` ·
`packages/domain/src/stock/wastage-reasons.ts` (the shared enum) ·
`packages/domain/tests/integration/consumption-posting.test.ts` ·
`packages/domain/tests/unit/wastage-reasons.test.ts`

**Modify:** `packages/db/schema/stock-ledger.ts` (`reason_code`, `department_id` on the movement) ·
`packages/db/migrations/<next>_t164_movement_reasons.sql` ·
`packages/domain/src/stock/ledger.ts` · `docs/POSTING-PATTERNS.md` (three patterns) ·
`tests/worked-examples/fixtures.ts` · `packages/db/src/repo/findings.ts` · `_journal.json` ·
`docs/ROADMAP.html`

## 5. Contract

```ts
postConsumption(tx, {
  storeId, locationId, itemId, quantity, movedAt,
  purpose: 'usage' | 'production_input' | 'issue',
  departmentId?, sourceType, sourceId,
}): Promise<{ movement, consumptions, entryId, cost: Money }>

postWastage(tx, { ...same, reason: WastageReason, chargeToPersonId? }): Promise<…>

postCountVariance(tx, {
  storeId, locationId, itemId, countedQuantity, sessionId, movedAt,
}): Promise<{ variance: Quantity, entryId | null }>
```

### The wastage reason enum — one shared list, not free text

`spoilage` · `expiry` · `damage_storage` · `damage_handling` · `prep_loss` · `overproduction` ·
`theft` · `quality_reject` · `customer_return_unsellable` · `other`

⭐ **A real enum/lookup, never a text column.** v1's own reason for making it shared:
*"reports can aggregate 'spoilage' or 'theft' across all item kinds without per-module string
normalisation."* ⚠️ **It is a different, larger list than the delivery-shortage taxonomy** (T-166) —
a shortage is a supplier-relationship signal, wastage is a stock-loss classification.

## 6. Invariants

1. **Cost comes from FIFO consumption, never from a price list, an average, or the item's last
   invoice.** `consume()` returns the cost lines; this module posts exactly them.
2. **A consumption spanning several layers still posts ONE journal entry** with the total. The
   per-layer detail lives in `stock_layer_consumptions`, which is the subledger.
3. **The COGS account comes from the item's category crosswalk** (COA-ALIGNMENT §4.1), never from
   the *expense* category — those are two different taxonomies and conflating them is how `5170`'s
   elimination breaks.
4. **Wastage posts `5300`, never a COGS account**, even for food.
5. **Count variance posts `5400`, signed both ways.** ⚠️ **The exception, already decided:** an
   *opening* count's variance posts against `3900`, not `5400` (T-134) — because v2 has no December
   P&L to charge it to. This function refuses an `opening` session and names T-134.
6. **A variance inside 1e-6 base units posts nothing at all.** Quantity tolerance and money
   tolerance are different constants with different reasons and are not collapsed (§16.6).
7. **A movement out of a `storage` location is refused** — T-160 invariant 3, called here.
8. ⭐ **A usage record whose reason or category is `transfer` (or any synonym) is REJECTED.** v1's
   named footgun: the usage path writes only an OUT leg, so a mislabelled transfer **destroys stock
   instead of moving it**. Server-enforced; the client guard is a convenience, not the control.
9. **Wastage charged to a staff member posts the salary-advance charge in the SAME transaction** as
   the stock movement — no orphan charge, no orphan wastage. ⚠️ If Phase 5's advance module is not
   yet built, the parameter is **refused with a named error**, never silently dropped.
10. **Every posting path is period-locked**, and the reversal path defaults its date to today rather
    than erroring at the user (row 103 consequence (b)).
11. **Reversal restores quantity to the exact layers it came from** (T-162 invariant 7) and
    `reverseEntry`s the journal entry. One transaction.

## 7. Tests

1. Consuming 15 kg across two layers (10 @ ₱300, 8 @ ₱310) posts `Dr 5110 4,550 / Cr 1310 4,550` —
   **one entry, two consumption rows**.
2. The same consumption of a `supply`-kind item posts against `1320`, not `1310`.
3. Wastage of 2 kg for `spoilage` posts `Dr 5300 / Cr 1310` and **never** touches `5110`.
4. A count of 98 against an on-hand of 100 posts `Dr 5400 / Cr 1310` for 2 units at FIFO cost; a
   count of 102 posts the opposite direction.
5. A count variance of 0.0000005 posts nothing.
6. ⭐ An `opening` count session is **refused**, with an error naming T-134 and `3900`.
7. Consuming from a `storage` location is refused.
8. A usage record with category `transfer` is refused — asserted for each synonym in the reserved
   list.
9. Wastage with `chargeToPersonId` posts both legs in one transaction; forcing the advance leg to
   fail rolls back the **stock movement too** — asserted by re-reading on-hand.
10. ⭐ **Period lock, one test per exit path** — consumption, wastage, variance — each dated into a
    closed period, each refused, each error naming the period. *This is the test that closes
    §16.7 #6, and it is written as three cases deliberately.*
11. Reversing a consumption restores the layers and reverses the entry; the trial balance ties
    before and after.
12. `5300`, `5400` and every `5xxx` used here appear in the income statement **without a
    hand-added scan block** — invariant 2, asserted over the P&L query.

## 8. Out of scope

⛔ **The documents that trigger these postings.** Usage records (T-168), counts (T-169), production
(T-176), POS pull (T-177) are all later and all call these three functions.
⛔ **Order/channel wastage.** A different system sharing one word — no stock moves at all. T-178,
and the phase plan §6.1 says why.
⛔ **The staff-charge module itself.** Phase 5. This task calls it or refuses, per invariant 9.
⛔ **Departmental cost allocation reporting.** The `department_id` dimension is captured here;
reporting on it is Phase 6.

## 9. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `docs/POSTING-PATTERNS.md` gains `stock.consumption`, `stock.wastage`,
      `stock.count-variance`, each with a worked example in `fixtures.ts`.
      ⚠️ Run `npm run toc` — `toc-freshness.test.ts` fails the build otherwise.
- [ ] Test 10 written as three separate cases and each demonstrably failing before the guard.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `docs/ROADMAP.html` updated.
