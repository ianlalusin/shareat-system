# T-161 — The stock ledger: movements are the truth, on-hand is a query

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-160 (locations), T-145 (`items`).
> **v1 read at source** — `stock-ledger.ts`, `general-inventory.actions.ts`,
> `meat-usage.actions.ts:310-323`, `production.actions.ts:231-247`. `docs/discovery/14` §I, §K.

## 1. Goal

One append-only table of signed stock movements, and **on-hand computed from it** — so the
quantity a report shows and the quantity the ledger implies cannot disagree, because there is only
one of them.

## 2. ⭐ The rule this task exists to establish

v1 keeps `itemBalances` as a written, incremented document **beside** `itemStockLedger`, and then
ships `reconcileLegacy()` — a comparator that sums the ledger and flags any item whose stored
balance disagrees. **A tool to detect drift between two copies of one number is evidence there
should be one copy.**

> **This is DEF-075's pattern — a stored balance beside the ledger — for the eighth time.** Loans,
> owner equity, cash requests, liabilities, customers, suppliers, AP-open, and now stock.

⭐ **v2 has no balance column. `onHand(itemId, locationId)` is a query over signed movements.** A
materialised view or summary table may exist later **as a cache** — derived, rebuildable, never
authoritative (§16.1 invariant 3). It is not built here, because a cache added before a measured
need is a second source of truth with extra steps.

## 3. The two named bugs that dictate the write shape

| Bug | Cause | The rule it forces |
|---|---|---|
| Meat balance drifting negative | Two drafts posted at the same instant both passed the same pre-check outside the transaction | ⭐ **Read the balance INSIDE the transaction, never before it** |
| A **−20 kg** slab drift | Two concurrent production posts read the same "available" snapshot | Same |

`FieldValue.increment` is not idempotent and Firestore forced the pre-check. **Postgres removes
this class of bug for free** — `SELECT … FOR UPDATE` on the item+location, inside the same
transaction that writes the movement. The rule is stated anyway, because re-deriving v1's
pre-check shape out of habit is the easy mistake when the constraint that forced it is gone.

## 4. Scope

**Create:** `packages/db/schema/stock-ledger.ts` ·
`packages/db/migrations/<next>_t161_stock_ledger.sql` ·
`packages/domain/src/stock/ledger.ts` · `packages/db/src/repo/stock-ledger.ts` ·
`packages/domain/tests/integration/stock-ledger.test.ts` ·
`packages/domain/tests/unit/stock-ledger-rules.test.ts`

**Modify:** `packages/db/schema/index.ts` · `packages/db/src/index.ts` ·
`packages/db/src/cutover/classification.ts` · `packages/db/src/rls/registry.ts` ·
`packages/domain/src/index.ts` · `packages/db/src/repo/findings.ts` (one detector) ·
`_journal.json` · `docs/ROADMAP.html`

## 5. Contract

```
stock_movements                       -- APPEND ONLY. No UPDATE, no DELETE. Trigger-enforced.
  id                uuid pk
  org_id, store_id, location_id  -> stock_locations
  item_id           uuid NOT NULL -> items
  moved_at          timestamptz NOT NULL          -- business time, not row time
  quantity          numeric(14,3) NOT NULL        -- SIGNED. + in, - out. Never zero.
  kind              stock_movement_kind NOT NULL
  source_type       text NOT NULL                 -- 'delivery' | 'transfer' | 'usage' | ...
  source_id         uuid NOT NULL                 -- invariant 4: every movement traces
  journal_entry_id  uuid NULL -> journal_entries  -- NULL only for kinds that post nothing
  reversal_of_id    uuid NULL -> stock_movements  -- a correction is a new, opposite row
  note              text
  created_by, created_at

  check (quantity <> 0)
  unique (source_type, source_id, item_id, location_id, coalesce(reversal_of_id, nil-uuid))
  index (item_id, location_id, moved_at)
  index (org_id, store_id, moved_at)
```

`stock_movement_kind` — the closed list, and it is closed deliberately:
`receipt` · `usage` · `wastage` · `transfer_out` · `transfer_in` · `count_adjustment` ·
`manual_adjustment` · `production_in` · `production_out` · `return_out` · `opening`.

```ts
// packages/domain/src/stock/ledger.ts
recordMovement(tx, input): Promise<StockMovement>      // callers already hold the tx
onHand(itemId, locationId, asOf?): Promise<Quantity>   // Σ signed movements
onHandByStore(storeId, asOf?): Promise<Map<ItemId, Quantity>>
reverseMovement(tx, movementId, reason): Promise<StockMovement>
```

## 6. Invariants

1. **Append-only, enforced by a trigger** — an `UPDATE` or `DELETE` on `stock_movements` raises.
   ⭐ Phrase it as what the *database refuses*, not what our code declines to do (row 104; this is
   the same treatment DEF-041 got in migration 0009).
2. **A movement of zero quantity cannot exist.** A CHECK constraint.
3. **Every movement names its source** (`source_type` + `source_id`) — invariant 4 for stock.
4. **A correction is a new opposite row carrying `reversal_of_id`**, never an edit — invariant 5.
   A movement may be reversed **at most once**; the second attempt is refused.
5. ⭐ **On-hand is a query. There is no balance column anywhere in this schema.** A reviewer finding
   one has found a defect.
6. **The balance read that gates a decrement happens inside the writing transaction**, with a row
   lock on (item, location) — §3.
7. **On-hand may not go negative** for any location, refused inside the transaction. ⚠️ The one
   documented exception is an **admin manual adjustment** correcting a known-bad state, which
   carries a typed reason and is itself a movement.
8. **Period lock applies** — a movement whose `moved_at` falls in a closed period is refused
   (invariant 7). ⭐ *v1 has no period guard on 11 of 17 inventory paths* (§16.7 #6); this is where
   that closes, once, for every caller.
9. **A movement with a `kind` that posts value must carry a `journal_entry_id`** once T-163/T-164
   land. Until then the column is nullable; **T-165 tightens it to a CHECK against the kind list.**

## 7. Tests

1. `onHand` after 3 receipts and 2 usages equals the signed sum, **exactly** — see §8.
2. `UPDATE stock_movements SET quantity = 999` **raises**, executed as raw SQL.
3. `DELETE FROM stock_movements` **raises**, raw SQL.
4. A zero-quantity insert is refused by the CHECK.
5. ⭐ **Concurrency, and this is the test that matters:** two transactions decrement the same
   (item, location) from an on-hand of 10 by 8 each. One commits, one is refused. **Assert the
   final on-hand is 2, never −6.** This is v1's −20 kg drift, reproduced and prevented.
6. Reversing a movement writes an opposite row with `reversal_of_id` set; on-hand returns to its
   prior value; a second reversal of the same movement is refused.
7. A movement dated into a closed period is refused, and the error names the period.
8. The idempotency unique index refuses a second movement for the same
   (source_type, source_id, item, location).
9. `onHand(asOf)` at a past timestamp ignores later movements — the ledger is queryable as at a
   date, which is what a count and a year-end need.
10. RLS: org A cannot read or insert org B's movements.

## 8. ⛔ Correction 2026-08-29 — there is no quantity tolerance, and there must not be one

This spec was written expecting v1's `1e-6` comparison tolerance to come forward. **Building
`packages/domain/src/stock/quantity.ts` showed it cannot.**

v1 held quantities as JavaScript floats, so `10 - 3 - 7` could land at `1e-16` and the tolerance
was a defence against that. ⭐ **`numeric(14,3)` plus integer-thousandths arithmetic has no float
anywhere: the smallest representable non-zero difference is `0.001`, so a `1e-6` tolerance can
never fire.** Carrying it would leave unreachable code that reads as a business rule.

⭐ **Quantity comparisons are EXACT.** ⚠️ Money tolerances are unaffected (§16.6).

## 9. Out of scope

⛔ **Any cost or valuation.** A movement carries **quantity only**. Cost is a FIFO layer (T-162),
and keeping the two tables separate is what lets a cost correction re-value history without
rewriting a single quantity.
⛔ **A balance cache / materialised view.** §2 — not until a measured need exists.
⛔ **The documents that create movements.** Deliveries, transfers, usage and counts are Wave 1.
This task is exercised by fixtures.
⛔ **Batch / lot / expiry columns.** Phase-plan §8: v1 built them and never wired them.

## 10. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`,
      including the append-only trigger.
- [ ] `classification.ts`: **PURGE** — operational postings, the same class as `journal_entries`.
      `rls/registry.ts` with the NULLIF-guarded org form (DEF-077).
- [ ] New finding `stockLedgerDoesNotMatchBalance` registered in `repo/findings.ts`. ⚠️ It compares
      the ledger against **any future cache**, and is vacuously green today — say so in the
      detector's own comment, per T-134's vacuous-pass lesson.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` before the integration run).
- [ ] Test 5 (the concurrency case) demonstrably **fails without the row lock** before it passes
      with it — *"a test that only ever passed proves nothing"* (§3.2).
- [ ] `docs/ROADMAP.html` updated.
