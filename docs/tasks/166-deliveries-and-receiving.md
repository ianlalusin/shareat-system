# T-166 — Deliveries: the document goods actually arrive on

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-160 (locations), T-161 (movements), T-162 (layers), T-163 (receipt posting),
> T-130 (`supplier_invoices`), T-141 (file brokering, for the photo gate).
> **v1 read at source** — `delivery.actions.ts` (1,470 lines), `receive-allocation.ts`,
> `delivery-duplicate-risk.ts`, `record-types.ts`. `docs/discovery/14` §F.

## 1. Goal

The screen a manager or cashier actually uses when a supplier's van arrives: record what is
coming, receive what actually came, put it in a room — and have the books, the stock and the cost
layer all follow from that one action.

## 2. What v1 gets right here, and it is most of it

| Capability | Keep |
|---|---|
| **Delivery vs purchase** — one document, two labels. A *delivery* is supplier-sourced; a *purchase* is staff-bought for cash and may have no registered supplier | ✅ Same table, a `kind` column |
| ⭐ **Photo-of-paper required on create** | ✅ **A real anti-fraud control, not incidental.** A purchase needs its own photo; an external-supplier delivery must link to an invoice that has one; a **commissary** delivery is exempt because it is system-generated (T-173) |
| ⭐ **Receiving parks an undecided line in "Receiving", never guesses a room** | ✅ Falls back to the default room **only** if no Receiving location exists — *"so stock is never lost."* Preserve the fallback ordering exactly |
| ⭐ **Over-receipt allowed, with an explicit flag AND manager/admin** | ✅ *"Suppliers sometimes legitimately send extra."* A gated exception, never a silent cashier bypass |
| **Short-received lines carry a typed shortage reason** | ✅ Feeds supplier-performance conversations |
| ⭐ **Duplicate-risk warnings — advisory, never blocking** | ✅ *"Our job is to put the fact in front of them at the moment they can still act on it."* Legitimate double-drops and bulk buys are normal |
| **Void cascades in the direction of causation** | ✅ Shape kept, mechanism replaced — one transaction (ADR-009 amendment 3) |
| ⛔ Auto-link / bulk-create-from-delivery | **Removed by v1 deliberately** — *"the amount-match heuristic produced false positives at scale."* Do not re-introduce |
| ⛔ Direct "receive into a room" door | **Hard-blocked by v1 by policy** — all inbound stock flows through this document. Do not port the entry point |

## 3. Scope

**Create:** `packages/db/schema/deliveries.ts` ·
`packages/db/migrations/<next>_t166_deliveries.sql` ·
`packages/domain/src/deliveries/index.ts` · `packages/domain/src/deliveries/duplicate-risk.ts`
(pure) · `packages/domain/src/deliveries/shortage-reasons.ts` ·
`packages/db/src/repo/deliveries.ts` ·
`apps/erp/src/app/inventory/deliveries/page.tsx` + `[id]/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/deliveries.test.ts` ·
`packages/domain/tests/unit/duplicate-risk.test.ts`

**Modify:** schema/domain barrels · `classification.ts` · `rls/registry.ts` ·
`CAPABILITY-MATRIX.md` · `_journal.json` · `docs/ROADMAP.html`

## 4. Contract

```
deliveries
  id, org_id, store_id
  kind            'supplier' | 'purchase' | 'commissary'  NOT NULL
  supplier_id     uuid NULL -> suppliers      -- required when kind='supplier'
  reference_no    text NULL                   -- the DR / invoice number on the paper
  delivered_on    date NOT NULL
  status          'draft' | 'received' | 'void' NOT NULL default 'draft'
  proof_file_id   uuid NULL -> stored_files   -- the photo gate, invariant 1
  received_at, received_by, voided_at, voided_by, void_reason
  created_by, created_at, updated_at
  unique (store_id, supplier_id, reference_no) where reference_no is not null and status <> 'void'

delivery_lines
  id, delivery_id -> deliveries (on delete cascade)
  line_no, item_id -> items
  ordered_quantity   numeric(14,3) NOT NULL
  received_quantity  numeric(14,3) NULL       -- set at receive
  purchase_unit      text NOT NULL
  conversion_factor  numeric(14,6) NOT NULL   -- SNAPSHOTTED (T-145's rule)
  unit_cost          numeric(14,4) NOT NULL   -- per purchase unit, as typed
  location_id        uuid NULL -> stock_locations   -- NULL = park in Receiving
  shortage_reason    text NULL
  over_receipt_ok    boolean NOT NULL default false
  unique (delivery_id, line_no)
```

**Shortage reasons** — a separate, smaller enum from wastage (§16.6, and phase plan §7):
`not_received` *(auto-set, excluded from the manual picker)* · `supplier_short` ·
`damaged_in_transit` · `damaged_on_arrival` · `quality_reject` · `count_correction` · `other`.

```ts
saveDraft(input) / addLine / removeLine
receive(deliveryId, { lines, allowOverReceipt }): Promise<ReceiveResult>
voidDelivery(deliveryId, reason): Promise<void>
duplicateRisk(draft): Warning[]          // pure, advisory
```

## 5. Invariants

1. **A delivery cannot be created without proof.** `kind='purchase'` needs `proof_file_id`;
   `kind='supplier'` needs it or a linked invoice that has one; `kind='commissary'` is exempt and
   may only be created by T-173. ⚠️ Enforced **server-side**, and the file must exist in
   `stored_files` — not merely be a non-empty string (the regression DEF-077's audit already caught
   once, in `verifyInvoice`).
2. **Receiving is the only door for inbound stock.** No other path creates a `receipt` movement.
3. **A line received above ordered is refused** unless `allowOverReceipt` **and** the caller is
   manager/admin. A cashier passing the flag is refused — asserted.
4. **A line received below ordered requires a shortage reason**, except a wholly-unreceived line,
   which auto-sets `not_received`.
5. ⭐ **A line with no `location_id` goes to Receiving; if the store has none, to the default room.
   It is never dropped and never guessed.** The ordering is exact.
6. **Receive posts, in ONE transaction:** the movements (T-161), the layers (T-162), the
   `Dr 1310/1320/1330 · Cr 2120` entry (T-163). Any failure rolls back all three.
7. **Duplicate-risk warnings never block.** Three heuristics kept verbatim: same supplier + same
   reference already recorded · same item already recorded on this date · this delivery at least
   **doubles** current on-hand.
8. ⭐ **Void is one transaction and cascades in the direction of causation** — reverse the entry
   (`reverseEntry`), the layers, the movements, and unlink the invoice. ⛔ **Refused if any layer
   has been consumed** (T-163 invariant 8). v1's OC-14 non-atomic cascade is **not** ported; the
   constraint that forced it is gone.
9. **Period lock applies** to receive and to void (invariant 7).
10. **A received delivery is immutable.** Corrections are a void plus a new delivery, or an
    adjustment (T-168) — never an edit (invariant 5).

## 6. Tests

1. Creating a purchase with no `proof_file_id` is refused; with a `stored_files` id that does not
   exist, also refused.
2. Receiving 10 of 10 posts one entry, one layer, one movement, and `2120` rises by the line total.
3. Receiving 12 of 10 as a cashier is refused; as a manager **without** the flag, refused; as a
   manager **with** the flag, accepted.
4. Receiving 8 of 10 with no reason is refused; with `supplier_short`, accepted. A line marked
   not-received auto-sets `not_received` and does not require a picker choice.
5. A line with no location lands in Receiving. With the Receiving location deleted from the
   fixture, it lands in the default room. **Neither case loses the quantity.**
6. Duplicate risk fires all three warnings and **the receive still succeeds** — asserted, because
   the whole design decision is that it is advisory.
7. Void reverses entry, layers and movements; `2120`, `1310` and on-hand all return to their prior
   values; the trial balance ties.
8. Void of a partly-consumed delivery is refused, naming the consumed quantity.
9. Receiving into a closed period is refused.
10. Editing a received delivery is refused.
11. RLS: a manager of store A cannot receive store B's delivery. ⚠️ *Recurring `hasStoreAccess`
    omissions — 5+ instances in two months — are §16.7 defect #9.*
12. ⭐ Live route on 9008: create → attach photo → receive → see the stock, the layer and the
    journal entry from the UI.

## 7. Out of scope

⛔ **Auto-matching an invoice to a delivery.** Built and removed in v1. Manual link only (T-163).
⛔ **The direct receive-into-a-room door.** Retired by policy in v1; not ported.
⛔ **Supplier returns.** T-170.
⛔ **Commissary deliveries' creation path.** T-173 creates them; this task only honours the exempt
`kind`.
⛔ **Batch codes / expiry capture.** Phase plan §8.
⛔ **Purchase orders.** Discovery 20: *"staff-entered on the spot, not requisition-and-approve."*

## 8. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts` **PURGE** (operational); `rls/registry.ts` NULLIF-guarded (DEF-077).
- [ ] `CAPABILITY-MATRIX.md`: `receive_delivery`, `allow_over_receipt` (manager+),
      `void_delivery` — each with a test proving the ✗ fires.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] ⭐ Test 12 performed in the browser, not asserted from a server action —
      *a shipped server action is not a shipped feature.*
- [ ] `docs/ROADMAP.html` updated.
