# T-167 — Stock transfers between rooms of one store

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-160 (locations), T-161 (movements). ⭐ **Not T-162** — see §2.
> **v1 read at source** — `stock-transfer.actions.ts`, pure rules `stock-transfer.ts`.
> `docs/discovery/14` §J.

## 1. Goal

Move stock from one room to another within a store, in one step when the rooms are next to each
other and in two when the goods spend time in a truck — without either half ever making a unit of
stock invisible.

## 2. ⭐ Why this task is small, and it is a consequence of a decision already made

**A FIFO layer is per store, not per location** (T-162 invariant 6). So a room-to-room transfer
moves **quantity only**: two movements, out and in, no layer consumption, **no journal entry at
all**. Nothing about the cost of the goods changed because they crossed a doorway.

> That is not a shortcut. It is why the layer was scoped to the store in the first place — and it
> is worth stating, because "a transfer must post something" is the intuition and it is wrong here.

⚠️ **A transfer between two STORES is a different thing entirely** and it does post: T-173.

## 3. What v1 gets right

| Capability | Keep |
|---|---|
| Draft → dispatch → receive → void, two-step | ✅ For goods that are genuinely in transit |
| ⭐ **One-step "transfer now"** | ✅ Room-to-room in a commissary is instantaneous. Create + dispatch + receive commit in **one** transaction and never sit `in_transit` |
| Source-sufficiency check at dispatch | ✅ Refuses more than the source room holds |
| ⭐ **Long-haul in-transit reservation** | ✅ A dispatched two-step transfer **reserves** the quantity at the DESTINATION, so it reads as *"in the truck"* rather than vanishing between dispatch and receive. Shipped 2026-07-03 as a preventive control |
| ⭐ **Void must not double-release a reservation already resolved by receive** | ✅ An easy double-release bug if the reversal does not branch on prior status |
| Stuck-transfer report (default 3 days) | ✅ Per store, not a cross-store scan |
| Never touches the legacy store-level total | n/a — v2 has no second total to touch |

## 4. Scope

**Create:** `packages/db/schema/stock-transfers.ts` ·
`packages/db/migrations/<next>_t167_stock_transfers.sql` ·
`packages/domain/src/stock/transfers.ts` · `packages/domain/src/stock/transfer-rules.ts` (pure) ·
`packages/db/src/repo/stock-transfers.ts` ·
`apps/erp/src/app/inventory/transfers/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/stock-transfers.test.ts` ·
`packages/domain/tests/unit/transfer-rules.test.ts`

**Modify:** barrels · `classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` ·
`repo/findings.ts` (stuck-transfer detector) · `_journal.json` · `docs/ROADMAP.html`

## 5. Contract

```
stock_transfers
  id, org_id, store_id
  from_location_id, to_location_id -> stock_locations
  mode       'immediate' | 'two_step' NOT NULL
  status     'draft' | 'in_transit' | 'received' | 'void' NOT NULL default 'draft'
  dispatched_at, dispatched_by, received_at, received_by, voided_at, voided_by, void_reason
  note, created_by, created_at
  check (from_location_id <> to_location_id)
  check (mode <> 'immediate' or status in ('received','void'))

stock_transfer_lines
  id, transfer_id -> stock_transfers (cascade)
  line_no, item_id, quantity numeric(14,3) NOT NULL check (quantity > 0)
  out_movement_id, in_movement_id  uuid NULL -> stock_movements
  unique (transfer_id, line_no)

stock_reservations                 -- destination-side, dispatch-set, receive-resolved
  id, org_id, store_id, location_id, item_id
  quantity numeric(14,3) NOT NULL check (quantity > 0)
  transfer_id -> stock_transfers
  released_at timestamptz NULL     -- set once, by receive OR by void, never both
  unique (transfer_id, item_id)
```

```ts
transferNow(input): Promise<StockTransfer>          // one transaction, three steps
saveDraft / dispatch(id) / receiveTransfer(id) / voidTransfer(id, reason)
stuckTransfers(storeId, thresholdDays = 3): Promise<StockTransfer[]>
```

## 6. Invariants

1. **A transfer's two locations are in the same store**, and are different. Both DB checks.
2. **Source sufficiency is checked INSIDE the dispatching transaction**, with the row lock — T-161
   invariant 6, not a pre-check.
3. ⭐ **A transfer posts NO journal entry and consumes NO layer.** §2. A reviewer finding one has
   found a defect.
4. **`immediate` mode never persists an `in_transit` row.** Create, dispatch and receive commit
   together; the DB check refuses the intermediate status for that mode.
5. ⭐ **Dispatch creates a destination reservation; receive resolves it; void releases it ONLY if
   still unreleased.** `released_at` is set exactly once — enforced by the column being NULL-once,
   so a double-release is a failed update rather than a wrong number.
6. **On-hand at the destination does not include a reservation.** Reserved is a separate, visible
   number: *"in the truck"* is not *"on the shelf."*
7. **Void after receive reverses both movements** and does not touch the already-resolved
   reservation.
8. **A frozen location (T-169) refuses both the out and the in leg.**
9. **Neither leg may draw from or deposit into a location of another store** — RLS plus an explicit
   check, per §16.7 defect #9.
10. **Period lock applies** to dispatch, receive and void.

## 7. Tests

1. `transferNow` of 5 kg moves on-hand from room A to room B, writes two movements, **zero journal
   entries** and **zero layer consumptions** — all three asserted.
2. `transferNow` never leaves an `in_transit` row: asserted by status after commit **and** by the
   DB check refusing a direct insert.
3. Dispatching more than the source holds is refused; on-hand is unchanged.
4. ⭐ Concurrency: two dispatches of 8 from an on-hand of 10. One commits, one is refused, final
   on-hand is 2.
5. Two-step: after dispatch, source on-hand falls, destination on-hand is **unchanged**, and
   destination *reserved* is the quantity. After receive, reserved is zero and on-hand has risen.
6. ⭐ Void **after** receive reverses both legs and does **not** release the reservation a second
   time — asserted on `released_at` being unchanged. *This is the named double-release bug.*
7. Void **before** receive releases the reservation and restores source on-hand.
8. A transfer touching a frozen location is refused, both directions.
9. `stuckTransfers` returns a 4-day-old `in_transit` transfer and not a 2-day-old one, and the
   `stuckStockTransfer` finding fires for it.
10. Cross-store: a transfer whose destination belongs to another store is refused.
11. Live route on 9008: transfer-now from the UI, and see both rooms' on-hand change.

## 8. Out of scope

⛔ **Cross-store transfers.** T-172/T-173 — a different document, a different posting, a real
counterparty.
⛔ **Any journal posting.** §2.
⛔ **A transfer-request/approval workflow.** v1 has none and nobody has asked.
⛔ **Bin- or zone-level moves.** T-160 §8 — one flat level per store.

## 9. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts` **PURGE** for all three tables; `rls/registry.ts` NULLIF-guarded.
- [ ] `stuckStockTransfer` registered in `repo/findings.ts`.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] Test 6 written first and shown to fail against a naive void that releases unconditionally.
- [ ] `CAPABILITY-MATRIX.md`: `transfer_stock`, `void_transfer`, each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.
