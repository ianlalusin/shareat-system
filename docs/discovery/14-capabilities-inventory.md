# 14 — Capabilities Inventory: Inventory, Commissary & Procurement

Source: `C:\Users\ianla\webapps\ERP-rebuild` (read-only). Scope: item master, stock in/out, receiving,
purchase/supplier routing, transfers, internal issuance, usage tracking, prep/production conversion,
wastage, physical counts, low-stock/auto-order, unit conversion, meat inventory, commissary dispatch
and the branch-order lifecycle, stockroom model.

**Reading rule (per assignment):** this is the business's own account of what it needs, written in
TypeScript instead of prose. A capability's existence — however roughly built — is evidence of a real
operational need. Verdicts on quality are for Ian to make, not this doc.

**Legend:** `[VERIFIED]` = read directly, cited `file:line`. `INFERRED` = reasoned from adjacent code/docs,
not directly read. **Verdict**: DUPLICATE (v2 already has an equivalent) / CORRECT (build it, fix the
mechanics) / ADD (genuinely missing, add to a phase) / DELETE-CANDIDATE (**ask Ian**, never asserted).
**In the ERPv2 plan?** cites `PROJECT_BIBLE.md §10`'s phase table verbatim, or **NOT PLANNED**.

All file paths below are relative to `C:\Users\ianla\webapps\ERP-rebuild\`.

---

## A. Item master, unit conversion, thresholds

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Unified item master (general stock) | One catalog record per non-meat SKU: name, barcode, kind (retail/raw_material/supply/equipment), base unit, purchase unit + conversion factor, department tags, expense category, batch/perishable flags | Manager/admin | `src/lib/actions/item.actions.ts:34-116` (`upsertItemAction`) [VERIFIED] | Phase 3 ("Items") | CORRECT |
| Barcode uniqueness within a store | Two products can't share a scanned barcode | Manager/admin | `item.actions.ts:46-61` [VERIFIED] | Phase 3 | CORRECT |
| Case↔piece / pack unit conversion on the item master | Lets a store buy in cases/boxes but track and deduct stock in base units (pcs, kg…) — `purchaseUnit` + `conversionFactor` on every item | Manager/admin; read by receiving, commissary ordering, pricing | `item.actions.ts:19-20,74-76`; consumed at `delivery.actions.ts` (purchase-unit cost basis) and `branch-order.actions.ts:140-144` [VERIFIED] | Phase 3 | CORRECT |
| Reorder fields on the item master (`reorderPoint`, `reorderQuantity`, `criticalPoint`) | Intended per-item auto-reorder thresholds | Manager/admin (data entry only) | `item.actions.ts:25-27,81-83` [VERIFIED] | Phase 3 (nominally) | **DUPLICATE / DEAD** — see Intent section: these fields are written but nothing reads them. The *actual* low-stock/auto-order system runs on a completely separate `lowStockThreshold` field on the legacy `inventoryProducts`/`meatProducts` docs (below). Ask Ian which is the intended one before porting either. |
| Recipe-unit → item-unit conversion (g↔kg, ml↔ltr only) | A recipe/production line written in one unit must deduct correctly against an item tracked in another — silently *not* converting would deduct the wrong magnitude (500 written as 500kg instead of 0.5kg) | Production "cook" flow, POS usage-pull | `src/lib/inventory/recipe-units.ts:30-57` [VERIFIED] — deliberately refuses pcs↔pack, kg↔ltr (needs a per-item factor, not a global table) | Phase 3 ("usage") | CORRECT — the deliberate refusal list is itself a spec: don't guess a conversion, block and ask for a per-item factor |
| Reserved-usage-key guard | Blocks a usage/wastage record labeled "transfer" — that path only writes an OUT leg and would silently destroy stock instead of moving it | Server + client (defense in depth) | `src/lib/inventory/reserved-usage-categories.ts:10-28`, enforced at `general-inventory.actions.ts:84-86` and `meat-usage.actions.ts:86-88` [VERIFIED] | Phase 3 | CORRECT — encode as a hard type distinction (usage vs. transfer) in v2, not a string-matching guard |
| Per-store, low-stock threshold on legacy stock/meat products (`lowStockThreshold`) | The number auto-order and the low-stock report actually key off | Manager/admin (config); system (auto-order trigger) | `src/lib/actions/item-location-settings.actions.ts:22-58`; read at `low-stock.actions.ts:75-76`, enforced at `meat-usage.actions.ts:265-276`, `general-inventory.actions.ts:300-315` [VERIFIED] | Phase 3 | CORRECT — this is the live threshold system, not the item-master fields above |
| Hard "no threshold, no post" rule | A usage/wastage record for an item with *no* low-stock threshold configured cannot post at all (equipment exempt) — forces every consumable to have a reorder signal before it can be depleted | Server (posting gate) | `meat-usage.actions.ts:265-276`, `general-inventory.actions.ts:300-315` [VERIFIED] | Phase 3 | CORRECT — a real operating discipline, not incidental validation |
| Read-only low-stock report | Lists every item (regular + meat) at/below its threshold, most-deficient first — feeds the manager's morning briefing | Manager/admin | `low-stock.actions.ts:28-102` [VERIFIED] | Phase 3 / Phase 6 (dashboards) | CORRECT |
| `itemReorderPolicies` / `reorderAlerts` collections | Named in the Firestore schema/index inventory as "smart-reorder config + persisted alerts" | — | Referenced only in `01-data-model.md` (schema census); **grep across `src/` found zero read/write call sites** | — | **DEAD / ASPIRATIONAL** — no live capability here. Do not port; ask Ian whether this was ever built elsewhere or abandoned before landing. |

## B. Meat inventory specifics

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Meat product master (slab / sliced / other) with slab lineage | A separate catalog for meat, because meat has a parent→child relationship (a slab is cut into named sliced products) that general items don't have | Manager/admin | `src/lib/actions/meat-product.actions.ts:50-105` [VERIFIED] | Phase 3 | CORRECT |
| Server-side re-validation of meat-product edits (trust boundary) | The settings page used to write straight from the client; a re-categorized slab silently orphaned every sliced product pointing at it as its source — **a real production incident** ("Lipa's Beef Forequarter/regular", 3 orphaned children, 7 production records built on a broken lineage) | Manager/admin (blocked at Save) | `meat-product.actions.ts:3-19` (incident narrative in the file header), rules enforced by `src/lib/inventory/meat-product-validate.ts:65-147` [VERIFIED] | Phase 3 | CORRECT — port the validator as-is; it is a direct response to a real loss event, not defensive boilerplate |
| Blocking re-categorization of an in-use slab | A slab with live sliced children cannot be silently turned into a non-slab category | Manager/admin | `meat-product-validate.ts:76-89` [VERIFIED] | Phase 3 | CORRECT |
| Unit-mismatch block between a sliced product and its slab | A gram-denominated child under a kilo-denominated slab makes the production in=out weight check meaningless | Manager/admin (blocked at Save) | `meat-product-validate.ts:122-131` [VERIFIED] | Phase 3 | CORRECT |
| Meat usage/wastage record lifecycle (draft → post → void) | Records meat consumption or spoilage separately from general stock, with its own ledger/balance | Manager, PIN'd local staff (cashier/inventory) | `src/lib/actions/meat-usage.actions.ts:54-709` [VERIFIED] | Phase 3 | CORRECT |
| In-transaction re-check of on-hand before posting | Two concurrent posts against the same product both reading the same pre-transaction balance is how a meat balance goes negative — `FieldValue.increment` isn't idempotent. Re-reading the balance *inside* the transaction serializes concurrent posts | Server (concurrency safety) | `meat-usage.actions.ts:310-323` [VERIFIED] | Phase 3 | CORRECT — a real class of bug this defends against; must survive translation to SQL row locking |
| Canonical unit trusted from the product master, not the draft | A stale/hand-edited draft can't post a foreign unit onto a balance denominated differently | Server | `meat-usage.actions.ts:258-264`, mirrored in `production.actions.ts:312-315` [VERIFIED] | Phase 3 | CORRECT |
| Meat wastage staff-charge (salary-advance `charge` posting) | Lets a manager recover the peso cost of spoiled/lost meat from a responsible staff member's pay, in the same transaction as the stock write-off | Manager/admin with `canChargeStaff` grant | `meat-usage.actions.ts:280-462` [VERIFIED] | Phase 2 (salary advance) + Phase 3 (wastage) — genuinely spans both | CORRECT |
| Meat opening-balance (initial inventory) set/edit/reset | Lets a store declare its starting meat stock when onboarding, correct a mis-entered opening balance, or wipe it | Manager/admin with `canAdjustInventory` grant | `src/lib/actions/initial-inventory.actions.ts:25-223` [VERIFIED] | Phase 3 | CORRECT |
| Manual meat inventory adjustment | Direct +/- correction against a meat balance, with a mandatory typed reason, visible in the same transaction list as deliveries/usage/wastage | Manager/admin with `canAdjustInventory` grant | `meat-usage.actions.ts:499-591` [VERIFIED] | Phase 3 | CORRECT |
| Meat "convert" (slice → slice, same-slab only) | Re-cuts one sliced product into another (e.g. "Pork Belly Sliced" → "Pork Belly Ground") — pure count move, deliberately NO payment/GL/slicer-pay impact | Manager, slicer/inventory-staff local user | `src/lib/inventory/meat-convert.ts:1-43`, posted via `production.actions.ts` (`productionType: 'convert'`) [VERIFIED] | Phase 3 | CORRECT — the same-slab constraint is a hard business rule, not a UI nicety |

## C. Receiving, deliveries, supplier routing

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Delivery draft (create/edit items before receiving) | Lets staff key in a supplier delivery/DR before committing it to stock, so errors are cheap to fix | Manager, cashier/inventory-staff local user | `src/lib/actions/delivery.actions.ts:57-306` [VERIFIED] | Phase 3 | CORRECT |
| Photo-of-paper requirement before creating a delivery | A store purchase or an external-supplier delivery must be backed by a photographed physical document before it can be recorded — the receipt IS the evidence a purchase happened | Cashier/inventory-staff/manager | `delivery.actions.ts:111-141` [VERIFIED] | Phase 2/3 (receipts + receiving) | CORRECT |
| Receive (post delivery to stock) | Commits a draft delivery's lines to on-hand — the actual stock-in event | Manager, cashier/inventory-staff local user | `delivery.actions.ts:350-671` [VERIFIED] | Phase 3 | CORRECT |
| Server-side over-receipt guard | Rejects any line where received qty exceeds ordered qty unless a manager/admin explicitly overrides — without it a buggy/malicious client posting `receivedQuantity=999` against `quantity=10` silently inflates stock | Cashier/inventory-staff (blocked); manager/admin (override) | `delivery.actions.ts:450-474`; shipped per `docs/INVENTORY_GAPS.md#5` (RESOLVED 2026-07-03) [VERIFIED] | Phase 3 | CORRECT |
| Mandatory shortage reason on a short-received line | A line received short of what was ordered can't be silently accepted — forces a reason (supplier short-shipped, damaged, not received, etc.) | Cashier/inventory-staff/manager | `delivery.actions.ts:476-501`, reason enum in `src/lib/financial/inventory/wastage-reasons.ts`-adjacent `ShortageReason` type [VERIFIED] | Phase 3 | CORRECT |
| Allocate-on-receive to a specific room, with "Receiving" as the parking spot | An undecided/unallocated line is deliberately parked in a "Receiving" pseudo-location — surfaced as a pending-allocation nudge — rather than silently defaulted into the default storage room (the old, worse behavior). Falls back to the default room only if no Receiving location exists, so stock is never lost | Cashier/inventory-staff/manager (commissary-scale stores) | `delivery.actions.ts:507-533`, resolver in `src/lib/inventory/receive-allocation.ts:14-22` [VERIFIED] | Phase 3 ("locations") | CORRECT — this exact "park, don't guess" policy is worth preserving verbatim |
| Void a received delivery, cascading to linked expenses/receipts | Voiding the root event (the delivery) must also void whatever it caused — the linked expense(s), and the receipt if nothing else references it — rather than requiring a human to manually unwind each downstream record | Manager/admin (policy-gated) | `delivery.actions.ts:675-924` [VERIFIED] | Phase 3 (stock) + Phase 2 (expense/receipt reversal) | CORRECT — the cascade is explicitly non-atomic across stores/documents (accepted risk, fail-fast, retry-safe); v2's real transactions can fix this properly (see `03-business-logic.md §5.3`) |
| Duplicate-delivery risk warnings (advisory, never blocking) | Catches a delivery keyed twice: same supplier + same DR/invoice number, same product received twice same day, or a delivery that at least doubles existing on-hand for that product — put in front of the operator at the moment they can still act on it | Cashier/inventory-staff/manager | `src/lib/inventory/delivery-duplicate-risk.ts:1-169` [VERIFIED] | Phase 3 | CORRECT — deliberately "warn, never block"; the self-scaling overstock heuristic (2 kg top-up on 40 kg trips it, 200 kg bulk buy on 5 kg does not) is a tuned business rule, not arbitrary |
| Link a delivery item to an (existing or newly-created) expense | Turns a received line into an actual accounts-payable/cost record, tolerant of centavo-level supplier-invoice rounding | Manager, cashier (48h edit window elsewhere) | `delivery.actions.ts:994-1239` [VERIFIED] — `AMOUNT_TOLERANCE = 0.99` deliberately loosened from a hard reject | Phase 2/3 | CORRECT — the ₱0.99 tolerance is a tuned business decision (real supplier invoices carry centavo rounding), not a bug |
| Force-link an expense (admin-only bypass) | Escalation path when the normal link's price-matching gets in the way of a legitimate correction | Admin only | `delivery.actions.ts:1100-1148` [VERIFIED] | Phase 2/3 | CORRECT |
| Batch-record delivery expenses (one payment split, proportionally allocated across items) | External-supplier receiving where the whole delivery is paid with ONE mixed payment (half cash/half online/some credit) — produces one receipt + one expense per item, each carrying its proportional slice | Manager, cashier | `src/lib/actions/delivery-expense.actions.ts:39-303` [VERIFIED] | Phase 2/3 | CORRECT |
| Mark a shortage/variance flag "settled" | Audit-trail confirmation that a manager reviewed a discrepancy (short receipt, cost variance) and considers it handled — purely informational, no balance writes | Manager/admin | `delivery.actions.ts:1335-1385` [VERIFIED] | Phase 3 | CORRECT |
| Candidate-expense lookup for linking | Surfaces same-supplier expenses within a ±15-day window of the delivery, for the manual link picker | Any staff (read) | `delivery.actions.ts:1399-1467` [VERIFIED] | Phase 2/3 | CORRECT |
| Supplier return (first-class stock-OUT record) | A traceable "we returned N units of X to supplier Y on date Z, because reason W" — replaces the old workflow of voiding the whole delivery + a manual reverse expense, which had no single audit record | Manager, cashier/inventory-staff local user | `src/lib/actions/supplier-return.actions.ts:76-299`; shipped per `docs/INVENTORY_GAPS.md#9` (RESOLVED 2026-07-03, UI shipped 2026-08-21) [VERIFIED] | Phase 3 | CORRECT — deliberately scoped to stock + audit trail only, NOT AP/journal (the financial side stays the existing void+manual-expense path; `apAlreadyHandled` is a self-declared informational flag, never enforced) |
| Supplier-return negative-stock guard (stricter than receiving's) | No admin override exists for over-returning — returns are rare enough that "block, always" was chosen over the receiving side's manager-override pattern | Manager, cashier/inventory-staff local user | `supplier-return.actions.ts:21-26,147-161` [VERIFIED] | Phase 3 | CORRECT |
| Void a supplier return (admin only) | Reverses the stock-OUT if the return was recorded in error | Admin only | `supplier-return.actions.ts:303-422` [VERIFIED] | Phase 3 | CORRECT |
| Supplier master CRUD | Business name, classification, VAT status, payment options, bank accounts, official-receipt flag | Manager/admin (policy-gated) | `src/lib/actions/supplier.actions.ts:30-107` [VERIFIED] | Phase 2 | CORRECT |
| Admin supplier delete, blocked by live receipts | Refuses to delete a supplier with non-voided receipts still attached — forces a transfer first | Admin only | `src/lib/actions/supplier-admin.actions.ts:58-100` [VERIFIED] | Phase 2 | CORRECT |
| Admin bulk-transfer of a supplier's receipts to another supplier | Lets an admin merge a duplicate supplier record into the canonical one | Admin only | `supplier-admin.actions.ts:108-166` [VERIFIED] | Phase 2 | CORRECT |

## D. Internal usage, issuance, wastage (stock-level)

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| General usage/wastage record lifecycle (draft → post → void) | Records consumption or spoilage of non-meat stock (raw material, supply, retail, equipment) | Manager, PIN'd local staff | `src/lib/actions/general-inventory.actions.ts:62-682` [VERIFIED] — the busiest inventory file, 8 transaction sites | Phase 3 | CORRECT |
| Duplicate-entry guard (natural key, with a machine-row exception for POS pulls) | Prevents a human from double-recording the same product/usage-category/location on the same day; a POS-generated row guards on its own line key instead, because one POS item can legitimately explode into several stock components that share the same natural key | Manager, PIN'd local staff | `general-inventory.actions.ts:93-141` [VERIFIED] | Phase 3 | CORRECT |
| Count-session freeze guard on posting | A usage/wastage post is refused at a location currently under an active, freeze-mode physical count — a post that slips in mid-count would decrement stock after the count snapshot was taken, invisible to the variance calc. Admin can explicitly bypass | Manager, PIN'd local staff (blocked); admin (override) | `general-inventory.actions.ts:262-281`, decision logic in `src/lib/inventory/count-freeze.ts:22-32` [VERIFIED] | Phase 3 ("counts") | CORRECT |
| Per-location stock gating for usage posts | Once a store tracks stock per room, usage must draw from a real operating room with sufficient on-hand there — not just against the store-wide total — and can't be posted from a storage-only room | Server (posting gate) | `general-inventory.actions.ts:322-354` [VERIFIED] | Phase 3 | CORRECT |
| Wastage-reason enum requirement | A wastage record can't post without a reason drawn from the canonical `WASTAGE_REASONS` enum, so reports can aggregate spoilage/theft/etc. across item kinds | Server (posting gate) | `general-inventory.actions.ts:286-290`, enum in `src/lib/financial/inventory/wastage-reasons.ts` [VERIFIED] | Phase 3 | CORRECT — preserve the closed reason taxonomy verbatim (see Intent section) |
| Manual inventory adjustment (general) | Direct +/- correction with a mandatory reason, per-user gated separately from the manager role itself | Manager/admin with `canAdjustInventory` grant | `general-inventory.actions.ts:686-769` [VERIFIED] | Phase 3 | CORRECT |
| Opening balance (initial inventory) set/edit/reset (general) | Same opening-balance need as meat, for general stock | Manager/admin with `canAdjustInventory` grant | `general-inventory.actions.ts:777-978` [VERIFIED] | Phase 3 | CORRECT |
| Direct stock-in door — now hard-disabled | A "receive one item into a room" shortcut existed, bypassing the Deliveries flow; it has been deliberately dead-coded (`return` before the real body) so no client can reintroduce off-delivery, no-audit-trail stock-in | — (disabled) | `general-inventory.actions.ts:1067-1146` (guard comment at 1078-1081) [VERIFIED] | Phase 3 | ASK IAN — this is a *policy decision already made in v1* ("all stock-in goes through Deliveries"); worth confirming it's still the intended policy for v2 rather than re-deriving it from the dead code |
| "Pending allocation" visibility (items parked in Receiving) | Surfaces what's been received but not yet allocated to a room — drives a sidebar badge and the daily-review "not yet allocated" open item | Manager/admin (read) | `general-inventory.actions.ts:1148-1209` [VERIFIED] | Phase 3 / Phase 6 | CORRECT |

## E. Physical counts & reconciliation

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Count-session freeze lock | Lets a manager mark one or more locations "being counted, don't post usage/wastage here" for the duration of a physical count, with an audit trail of who opened/advanced/closed it | Manager/admin | `src/lib/actions/count-session.actions.ts:15-121`; freeze decision in `count-freeze.ts` [VERIFIED]; shipped per `docs/INVENTORY_GAPS.md#7` | Phase 3 | CORRECT — **but see Intent section**: this exact feature was "shipped" as server code for 7 weeks with literally no UI caller, so the freeze could never engage even though a stray write from anywhere else would have frozen a location *permanently* (nothing could open a session to close it either). |
| Commit a physical count (discrepancy-only, no GL) | Records what staff actually counted at a location and posts the delta against live on-hand as a `discrepancy` ledger leg — v1 deliberately has NO GL impact from a count | Manager/admin with `canAdjustInventory` grant | `src/lib/actions/stock-count.actions.ts:45-168` [VERIFIED] | Phase 3 ("counts") — v2 explicitly adds **COGS postings** and **weighted-average valuation** here, which v1 never had | ADD (the v1 mechanic is CORRECT to preserve; the GL posting it never had is genuinely new work for Phase 3, per bible §16.11) |
| Dual-write of a count's delta onto the legacy store-level balance | Keeps the per-location SOT and the store-total balance reconciled during the migration window from store-level to per-location tracking | Server | `stock-count.actions.ts:117-134` [VERIFIED] | N/A — this is a v1 migration artifact, not a capability to port | — |
| Branch/kiosk single-room stock reconciliation (admin tool) | Consolidates a branch's stock into ONE canonical room: floors any negative legacy balance to 0, moves the canonical room to the corrected legacy quantity, and wipes/deletes every non-canonical room — an admin cleanup for stores migrated onto the location model with drift | Admin only | `src/lib/actions/branch-stock-reconcile.actions.ts:99-238`, pure planner in `src/lib/inventory/branch-stock-reconcile.ts:39-109` [VERIFIED] | N/A — a v1 migration/repair tool, not an ongoing operational need | ASK IAN — likely doesn't need a v2 equivalent unless the same "store total vs. per-location" split reappears in the new schema |
| Batch/expiry tracking (FEFO) — partially built, not wired in | An `itemBatches` collection + first-expired-first-out batch-selection helper exist, plus a scheduled sweep that expires batches past their shelf life | Admin (expire sweep only); the FEFO picker and batch-decrement helper are **not exported** (dead/internal) | `src/lib/actions/inventory-batch.actions.ts:16-177` [VERIFIED] — `getItemBatchesAction`, `getFEFOBatchesAction`, `decrementBatchInTx` all deliberately un-exported ("unused repo-wide", "closes the zero-auth endpoint" per comments) | Phase 3 mentions batch/expiry only as "optional" in the inventory-systems skill scope, not named in the bible's phase-3 bullet list | ASK IAN — this reads as a feature that was built partway and never finished/wired into usage posting. Only the expire-sweep half is live. Worth asking whether FEFO batch consumption was ever meant to ship, or whether the standing threshold/reorder model is sufficient. |

## F. Transfers (intra-store) & the stockroom model

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Location/room model (storage vs. operating role, configurable types) | Lets a commissary track stock per physical room (Main Stockroom, Kitchen, Display Cabinet, Receiving, Returns, etc.) instead of one store-wide number — usage/wastage can only post from an "operating" room, never from "storage" | Manager/admin (config) | `src/lib/actions/inventory-location.actions.ts:1-559`, model in `src/lib/inventory/location-model.ts:1-126` [VERIFIED] | Phase 3 ("locations") | CORRECT |
| Single-default-location enforcement | Exactly one location can be "the" default per store (used to pre-fill the receive picker) — setting a new default automatically clears the old one | Manager/admin | `inventory-location.actions.ts:152-184`, `location-model.ts:118-125` [VERIFIED] | Phase 3 | CORRECT |
| Branch/kiosk single-location default | Unlike a commissary's Receiving/room split, a branch or kiosk gets exactly ONE location that is both the default room AND where usage/wastage posts from | System (seeding) | `location-model.ts:74-88` [VERIFIED] | Phase 3 | CORRECT |
| Block deleting a location that still holds stock or is the default | Prevents orphaning stock or breaking the receive-destination default | Admin only | `inventory-location.actions.ts:220-270` [VERIFIED] | Phase 3 | CORRECT |
| Admin-only bulk room-to-room reallocation of an item's existing on-hand | A deliberate one-time redistribution tool (initial room setup), distinct from day-to-day stockroom transfers — locked to admin specifically "to prevent accidental redistribution" | Admin only | `inventory-location.actions.ts:278-354` [VERIFIED] | Phase 3 | CORRECT |
| Location-model seeding/migration (idempotent) | Bootstraps default location types + locations for a new store, and migrates any location doc still on the retired `kind` enum onto the current role/type model | Manager/admin | `inventory-location.actions.ts:362-558` [VERIFIED] | N/A — v1 migration tooling | — |
| Stock transfer, two-legged (draft → dispatch → receive → void) | Moves stock between two rooms within one store — decrements source on dispatch, increments destination on receive, reversible at any stage | Manager, cashier/inventory-staff local user | `src/lib/actions/stock-transfer.actions.ts:49-521`, pure logic in `src/lib/inventory/stock-transfer.ts` [VERIFIED] | Phase 3 ("transfers") | CORRECT |
| One-step "transfer now" (same-actor, no transit) | Short-haul room-to-room moves (same building) don't need a two-step confirm — both legs post atomically, never entering `in_transit` | Manager, cashier/inventory-staff local user | `stock-transfer.actions.ts:120-218` [VERIFIED] | Phase 3 | CORRECT |
| In-transit reservation on a long-haul (two-step) transfer | Marks dispatched-but-not-yet-received stock as `reserved` at the destination — visible without polluting on-hand/available — so it isn't simply invisible "in the truck" between dispatch and receive | Server | `stock-transfer.actions.ts:273-282,337-345`; shipped per `docs/INVENTORY_GAPS.md#10` (RESOLVED 2026-07-03) [VERIFIED] | Phase 3 | CORRECT |
| Void a transfer, reversing exactly what was posted | draft → nothing to reverse; in_transit → return the out-leg + release the reservation; received → reverse both legs (never touching the reservation again, since receive already resolved it) | Manager/admin with `canVoidRecords` grant | `stock-transfer.actions.ts:368-445` [VERIFIED] | Phase 3 | CORRECT — the "which fields to touch depends on prior status" branching is exactly the kind of edge case worth porting precisely |
| Stuck-transfer report | Flags any transfer that's been dispatched-but-not-received past a threshold (default 3 days) — so a manager can chase down stock stuck "in the truck" | Manager/admin | `stock-transfer.actions.ts:470-520` [VERIFIED] | Phase 3 / Phase 6 | CORRECT |
| Per-location stock ledger reconciliation (drift detection) | Pure math to compare the per-location ledger's derived totals against the legacy store-level balance and flag drift beyond a 1e-6 tolerance | Admin tooling / integrity checks | `src/lib/inventory/stock-ledger.ts:19-60` [VERIFIED] | N/A — v1 migration-window integrity check | — |
| Per-location balance backfill (idempotent) | Reconciles Σ per-location on-hand to the legacy store-level total for one item — under-count adds the residual to the default room, over-count removes from the fullest rooms first, never driving a room negative | Admin tooling | `src/lib/inventory/itembalance-backfill.ts:30-62` [VERIFIED] | N/A — v1 migration tooling | — |

## G. Prep / production conversion (kitchen recipes distinct from meat slicing)

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Meat production (slicing) record lifecycle (draft → post → void → edit-posted) | Turns a slab into one or more sliced products in one atomic ledger transaction: slab OUT + every sliced-output IN + an optional reseco/loss memo leg, all consistent with `input = Σoutputs + variance` | Manager, slicer/inventory-staff local user | `src/lib/actions/production.actions.ts:118-1101` [VERIFIED] | Phase 3 ("usage") — **not explicitly named**; see "no home" section | CORRECT (mechanics), flag home in plan |
| Concurrent-post race protection | Reading the slab balance and the record status *inside* the transaction, not before it, is what stops two simultaneous posts (two slicers, two tabs, a retried request) from both succeeding against the same stale balance — the documented failure mode this defends against is a real "−20kg drift" class bug | Server | `production.actions.ts:231-238` [VERIFIED] | Phase 3 | CORRECT |
| Reseco/thaw-loss memo leg (ledger-only, no balance impact) | The variance between slab input and Σ sliced outputs is booked as an auditable memo — NOT a second balance write, because the slab's OUT leg already accounted for the full input quantity; writing it again would double-count the loss | Server | `production.actions.ts:392-415`, rule explained in `src/lib/inventory/production-validate.ts:22-30` [VERIFIED] | Phase 3 | CORRECT — a subtle double-counting trap worth preserving exactly |
| Edit a posted production record (reverse-then-reapply, one transaction) | Lets a manager correct a typo/wrong-quantity on an already-posted slicing run without a void-then-manual-recreate — same record id, ledger-revision versioned so history stays auditable | Manager/admin | `production.actions.ts:499-878` [VERIFIED] | Phase 3 | CORRECT |
| Block edit/void when a live slicer payment already covers the record | A slicer's pay is FROZEN against a fixed set of production records at generate-time; editing or voiding a record underneath a live (unpaid, verified, or paid) payment would silently drift the payroll cost from the inventory records that justified it — and once the period's lump sum has recognized the cost, there's no route back at all | Manager/admin | `production.actions.ts:64-114` (`liveSlicerPaymentBlocker`) [VERIFIED] | Phase 3 (inventory) × Phase 5 (payroll) — genuinely spans both | CORRECT |
| Same-slab lineage enforcement on "convert" runs | A convert can only re-cut within the same parent slab (see meat-convert, above) — hard for convert, advisory (warning only) for normal slicing, because trimmings from several cuts legitimately pool into one product in real kitchens | Server | `production.actions.ts:294-306`, tiering explained in `production-validate.ts:1-20` [VERIFIED] | Phase 3 | CORRECT — the hard-vs-soft distinction is itself the business rule; don't collapse it to one severity |
| Production monthly summary projection | Aggregates every slicer's total slab used / output weight / payment per month — the source the slicer payroll page reads | System (write-through on post/void/edit) | `production.actions.ts:417-446,773-822,1039-1060`, shared math in `src/lib/inventory/production-monthly-summary.ts` [VERIFIED] | Phase 3 × Phase 5 | CORRECT |
| Slicer-payment invariant guards (pure rule library) | Protects one invariant across the whole slicer-pay lifecycle: `liability__salaries_payable` must always be able to reach exactly zero, and the cost must hit the P&L exactly once. Covers: the one true "voided" predicate (3 legacy markers), which paid rows count as "parked" for a period, whether an unpaid row can still join a closing period, overlapping/duplicate-payment detection, payout-date bounding (can't pay before the work period ends or in the future), and drift between the frozen payment total and what the covered production records now add up to | Manager/admin (payroll flows), server (guards) | `src/lib/inventory/slicer-payment.ts:1-389` [VERIFIED] | Phase 5 (payroll) — this is genuinely payroll logic wearing an inventory hat | CORRECT — port as a unit; every rule here exists because an earlier, looser version of it actually broke the payable reconciliation once (see file's own commentary) |
| Kitchen production recipes (ingredient → output ratio) + "Cook" action | A lighter-weight prep flow distinct from meat slicing: define a recipe's ingredients (meat or general items) and yield, then "cook" a batch — consumes ingredients via the normal usage-record post path (draft+post per ingredient) and optionally posts one output IN leg | Admin (recipe authoring); manager, slicer/inventory-staff (cooking) | `src/lib/actions/production-recipe.actions.ts:75-498` [VERIFIED] | Phase 3 ("usage") — **not explicitly named**; see "no home" section | CORRECT (mechanics), flag home in plan |
| Zero-override is a real business input, not "no override" | Cooking with an ingredient override of exactly 0 means "this run genuinely used none of it" and must be honored — but a *blank/NaN* override must fall back to the computed (scaled) quantity, or the ingredient silently isn't deducted while the output still posts in full, breaking in=out | Server | `production-recipe.actions.ts:276-289` [VERIFIED] | Phase 3 | CORRECT |
| Presentation/training recipes (cookbook, distinct from production conversion) | Cross-store recipe library with photos/video/steps and per-branch variants — for staff training and menu documentation, NOT an inventory-moving action | Admin (author); all staff (read) | `src/lib/actions/cookbook.actions.ts:1-200+` [VERIFIED] | **Phase 7 ("Peripheral modules… cookbook")** — explicitly named | CORRECT — correctly scoped out of the accounting/inventory core already |

## H. Wastage & spoilage — two distinct systems

v1 actually has **two separate wastage systems** that share a collection name but almost nothing else:
(1) stock-level wastage (usage-record `transaction: 'wastage'`, covered in §D/§B above — a spoiled/lost
item deducted from inventory with a canonical reason), and (2) order/channel wastage (this section) —
FoodPanda/Grab/dine-in order-level loss tracking with its own dispute, allocation, and platform-settlement
workflow. **Only the first is inventory movement.** The second never touches a stock ledger.

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Per-store wastage-type configuration (tracked vs. instant) | Distinguishes platform orders that need a dispute window (FoodPanda/Grab — "tracked") from dine-in loss that's booked immediately ("instant") | Manager/admin | `src/lib/actions/wastage.actions.ts:109-185` [VERIFIED] | Phase 2 (settlements) — **not explicitly named**; see "no home" section | CORRECT (mechanics), flag home in plan |
| Wastage monitor assignment | Names the manager who's the default responsible party for an undispositioned tracked wastage — resolved (best-effort, by name match) against an active payroll staff record so the 15-day backstop has someone to charge if nobody dispositions it in time | Admin only | `wastage.actions.ts:191-264` [VERIFIED] | same as above | CORRECT |
| Create a wastage record | Logs an order-level loss (platform or dine-in), seeding the responsible party to the store's wastage monitor by default so every tracked wastage starts with a chargeable owner | Manager/admin | `wastage.actions.ts:268-423` [VERIFIED] | same as above | CORRECT |
| Channel-order dedup on create | A re-ingested settlement report can't double-log the same platform order as a second wastage | Server | `wastage.actions.ts:326-332` [VERIFIED] | same | CORRECT |
| Dispute a tracked wastage (with required proof) | Contests a FoodPanda/Grab wastage with the platform, requiring a report screenshot as evidence before the dispute can even be filed | Manager/admin | `wastage.actions.ts:522-560` [VERIFIED] | same | CORRECT |
| Resolve a dispute: paid (no GL) vs. charged (allocate) | Platform compensated the store → closes with zero journal impact; platform refused → the loss is allocated exactly like a normal acknowledge (staff-charge % + store-absorb residual) | Manager/admin (charge needs `canChargeStaff`) | `wastage.actions.ts:570-642` [VERIFIED] | same | CORRECT |
| Acknowledge-by-allocating (the single closing path) | There is deliberately no way to "acknowledge" a wastage without accounting for its money — every closure allocates a %-split between staff salary-advance charges and a store-absorbed net-zero expense memo | Manager/admin | `wastage.actions.ts:736-878` [VERIFIED] — the old zero-accounting "acknowledge" action was explicitly deleted | same | CORRECT — a real, deliberate policy tightening worth preserving |
| Park a responsibility split without posting it | Lets a manager record who's responsible and in what proportion *without* triggering the charge yet — survives the manager stepping away; a later settlement match or the 15-day backstop applies it | Manager/admin with `canChargeStaff` grant | `wastage.actions.ts:893-933` [VERIFIED] | same | CORRECT |
| Void a wastage (reversing any posted charge/expense) | Undoes a wastage's staff charge and/or absorbed-expense legs if it was recorded in error | Manager/admin with `canVoidRecords` grant | `wastage.actions.ts:935-987` [VERIFIED] | same | CORRECT |
| 15-day auto-charge backstop | Every tracked (platform) wastage left undispositioned for ≥15 days is forced to a resolution: (1) the manager's already-parked split, else (2) the assigned monitor charged 100%, else (3) the store absorbs it net-zero and gets flagged — applied uniformly to disputed AND undisputed records alike | System (cron, `CRON_SECRET`-gated) | `wastage.actions.ts:1094-1281` [VERIFIED] | same | CORRECT — the strict preference order (parked → monitor → store) is a real accountability policy, not an implementation detail |
| Settlement-match reconciliation against a parsed Grab/FoodPanda payout | Cross-references every open tracked wastage against a manager-uploaded settlement file, so the 15-day backstop's blind "charge it anyway" default can instead be informed by whether the platform actually paid | Manager/admin | `wastage.actions.ts:1323-1393+` (continues past what was read) [VERIFIED] | Phase 2 (channel settlements) | CORRECT — this is the piece most clearly a Phase-2 (settlements) capability wearing a "wastage" label |
| Wastage audit trail (per-record) | Full lifecycle history (create/dispute/resolve/charge/void/channel-status) for one wastage record, newest first | Manager/admin | `wastage.actions.ts:1299-1321` [VERIFIED] | Phase 6 (reporting) | CORRECT |

## I. Commissary dispatch & the branch-order lifecycle

The largest, most cross-cutting subsystem in this domain: a full order lifecycle between a commissary and
its branch/kiosk stores, spanning inventory movement (both directions), AR/AP across two Firestore
projects-worth-of-store-scoping, pricing, and item mapping. **This entire subsystem has no explicit
named home anywhere in the bible's 8-phase plan — see "Capabilities with no home in the plan" below.**

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Commissary discovery (cross-store) | A branch finds every commissary that has an active AR relationship with it, in one round-trip regardless of how many commissaries exist in the system | Any staff (read) | `src/lib/actions/branch-order.actions.ts:68-124` (`collectionGroup('arCustomers')`) [VERIFIED] | NOT PLANNED | ADD |
| Orderable-catalog projection (denormalized, TTL-cached) | The commissary's ordering catalog — what a branch can actually order, with live branch pricing — served from a rebuilt-on-TTL projection instead of a per-open 3-collection scan | Any staff (read); forced refresh available | `branch-order.actions.ts:126-248` [VERIFIED] | NOT PLANNED | ADD |
| Create / edit / submit / cancel a branch order | The branch's ordering workflow: draft with items, edit while draft or submitted, submit to the commissary, cancel while still cancelable | Manager, cashier/inventory-staff local user | `branch-order.actions.ts:307-568` [VERIFIED] | NOT PLANNED | ADD |
| One-open-order-at-a-time rule | A branch/kiosk cannot start a new order while a prior one is still open (draft through dispatched) — a dispatched order is goods-in-transit and must be received first. Only received/cancelled/rejected free the branch | Server (submit/create gate) | `branch-order.actions.ts:336-355` [VERIFIED] | NOT PLANNED | ADD |
| Hard pre-submit requirement: every line mapped to a local item + expense category | A branch order can't be submitted until every line is explicitly linked to a local inventory item (or an explicit ledger-only decision) AND has an expense category — otherwise the eventual receipt has nowhere to post stock or cost | Server (submit gate) | `branch-order.actions.ts:477-505` [VERIFIED] | NOT PLANNED | ADD |
| Branch approval/rejection of a commissary-proposed line change | The commissary can add a substitute or extra item mid-fulfilment; the branch must explicitly approve or reject it before it counts toward the total or the order can be marked ready | Manager, cashier/inventory-staff local user | `branch-order.actions.ts:577-640` [VERIFIED] | NOT PLANNED | ADD |
| Commissary accept / reject an order | The commissary's first response to a submitted order — moves it into active fulfilment or kills it with a reason | Manager, cashier/inventory-staff local user (commissary side) | `src/lib/actions/branch-order-fulfilment.actions.ts:48-133` [VERIFIED] | NOT PLANNED | ADD |
| Edit fulfilment (quantities, pricing, fees, per-line source room) | The commissary adjusts what it can actually send — fulfilled qty may differ from requested, per-line delivery fee/other fees, and which physical room a general item is pulled from | Manager, cashier/inventory-staff local user (commissary side) | `branch-order-fulfilment.actions.ts:135-209` [VERIFIED] | NOT PLANNED | ADD |
| Mark order ready (gated on complete fulfilment + resolved approvals) | Can't be marked ready until every line has a fulfilment quantity AND every branch-pending change has been approved/rejected | Manager, cashier/inventory-staff local user (commissary side) | `branch-order-fulfilment.actions.ts:211-259` [VERIFIED] | NOT PLANNED | ADD |
| Dispatch (pure status flip, stock-gated) | Moving to "dispatched" no longer touches the books at all (a deliberate redesign — see below); it only flips status, gated on real on-hand at the commissary so a store can't dispatch more than it has | Manager, cashier/inventory-staff local user (commissary side) | `branch-order-fulfilment.actions.ts:278-341` [VERIFIED] | NOT PLANNED | ADD |
| **Deferred posting until receipt, not dispatch** | v1 previously posted inventory/AR at dispatch-time using the *fulfilled* quantity, then had to retroactively correct AR when the branch's *received* quantity differed. The redesign defers ALL postings — both stores, both directions — to receipt-confirmation time, using whatever the branch actually received, so dispatched and received figures can never silently diverge | System design decision | `branch-order-fulfilment.actions.ts:261-277` (doc comment explaining the redesign) [VERIFIED] | NOT PLANNED | ADD — this is the single most important design decision in the whole subsystem to carry forward |
| Confirm receipt (the core cross-store posting event) | Branch confirms what it actually received. In one action: branch gets stock-IN (per-line, meat or general routed correctly) + an auto-created delivery doc, NO AP yet; commissary gets an AR debit + stock-OUT + revenue recognition on its Branch Sales channel (a non-remitted channel, distinct from cash sales) | Manager, cashier/inventory-staff local user (branch side) | `src/lib/actions/branch-order-receive.actions.ts:82-780` [VERIFIED] — the largest single action in this domain | NOT PLANNED | ADD |
| Discrepancy flag (dispatched vs. received) as pure audit, not a books problem | Under the deferred-posting redesign, a received≠fulfilled gap is no longer a reconciliation error — both sides already posted at the SAME (received) quantity — it's purely "goods went missing/damaged in transit," resolved separately | Server (flagging), manager (resolution) | `branch-order-receive.actions.ts:63-70,115-128` [VERIFIED] | NOT PLANNED | ADD |
| Discrepancy resolution: audit / write-off-loss / charge-staff | A manager decides how to close a flagged discrepancy: note only, write off the missing stock from commissary inventory, or additionally recover the peso value from a named responsible staff member | Manager/admin (charge needs `canChargeStaff`) | `src/lib/actions/branch-order-fulfilment.actions.ts:385-590` [VERIFIED] | NOT PLANNED | ADD |
| Cross-store unit-mismatch guard at receipt | If the branch's mapped local item is configured in a different base unit than what the commissary dispatched in, the stock balance move is SKIPPED (ledger entry kept, flagged, for audit) rather than corrupting the branch's count by mixing units | Server | `branch-order-receive.actions.ts:217-241` [VERIFIED] | NOT PLANNED | ADD — a real cross-store data-integrity guard, not incidental |
| Commissary → branch item mapping (with expense category) | Maps a commissary's catalog item to the branch's own local item id (or explicitly "ledger only, no branch item") — required before an order line can be submitted; also carries the branch-side expense category used to auto-book AP at receipt | Manager/admin (branch side) | `src/lib/actions/commissary-item-map.actions.ts:55-518` [VERIFIED] | NOT PLANNED | ADD |
| Bulk commissary-item-mapping import from a commissary's deliverable catalog | Copies (or links to existing) a commissary's whole orderable catalog into a branch's own item/meat catalogs in one pass, auto-creating the mappings — including a unit-conflict check that blocks an auto-link when a same-name branch product uses a different base unit | Manager/admin (branch side) | `src/lib/actions/commissary-import.actions.ts:1-365` [VERIFIED] | NOT PLANNED | ADD |
| Commissary item pricing config (three modes + three-tier cost basis) | Sets how a commissary prices an item to its branches: fixed amount, percent markup, or fixed markup over cost. Cost basis resolves in priority order: a linked product's cost (sliced meat prices off its slab), else a manager-set manual cost, else the item's own averaged receive cost | Manager/admin (commissary side) | `src/lib/actions/commissary-item-config.actions.ts:29-264` [VERIFIED] | NOT PLANNED | ADD |
| "Max of last two receives" cost-basis rule | When refreshing a commissary item's cost from delivery history, the HIGHER of the two most recent receive costs is used — so a single recent cheap lot can't undercut an older, still-in-inventory expensive one | Manager/admin (commissary side) | `commissary-item-config.actions.ts:461-512` [VERIFIED] | NOT PLANNED | ADD — a specific, tuned pricing-safety rule worth preserving exactly |
| "Needs cost" nudge report | Lists active commissary items the system genuinely cannot put a cost on (no cached delivery cost, no manual cost, no resolvable linked-slab cost) — split into urgent (has real on-hand stock) vs. not-yet-stocked, so a silent ₱0 pricing state becomes an actionable list | Manager/admin (commissary side) | `commissary-item-config.actions.ts:691-800` [VERIFIED] | NOT PLANNED | ADD |
| Commissary "unavailable" flag (temporarily out of stock) | Lets an item be pulled from the branch ordering catalog without deactivating its pricing config entirely — distinct from the manager's manual show/hide | Manager/admin (commissary side); intended for inventory-system automation later | `commissary-item-config.actions.ts:306-337` [VERIFIED] | NOT PLANNED | ADD |
| Auto-book branch AP for a commissary delivery | Resolves each received item's expense category from the branch's commissary-item-map and books one credit (on-account) expense per item automatically, so the branch's AP always mirrors the commissary's AR without a human re-keying it | System (best-effort, non-fatal) | `src/lib/actions/commissary-delivery-expense.actions.ts:269-336` [VERIFIED] | NOT PLANNED | ADD — see the real-incident note below |
| Auto-book failure surfaced, not silently swallowed | A prior version of this path swallowed its own failures; a documented real incident (Banay-Banay `BO-BNY-2607-0011`, 2026-07-23, ₱12,184.71) is a branch that took in stock while its AP to the commissary was never booked, discovered only much later. The fix widened the actor gate to match the receipt gate AND turned a swallowed failure into a warning surfaced back to the operator at receipt time | System / server | `commissary-delivery-expense.actions.ts:283-307`, `branch-order-receive.actions.ts:753-774` [VERIFIED] | NOT PLANNED | ADD — the "surface, don't swallow" lesson matters as much as the mechanic |
| Variance-float settlement (settle / defer / void) | When received ≠ dispatched value, the commissary's revenue and AR stay FLOATING (unposted) rather than posting a wrong number — a manager must explicitly settle (confirm the final amount and post it), or defer recognition once to the next day, or void it | Manager/admin (commissary side) | `src/lib/actions/branch-sales-settle.actions.ts:94-446,636-693` [VERIFIED] | NOT PLANNED | ADD |
| "Pending variance" blocks starting a new sales day | A commissary can't open a new day's sales report while it has an unsettled variance (or a deferred one whose deferred date has arrived) — forces the backlog to be cleared | Server (New Record gate) | `branch-sales-settle.actions.ts:701-731` [VERIFIED] | NOT PLANNED | ADD |
| Admin repair: orphaned branch-sale revenue | Recovers a commissary sales day whose Branch Sales revenue/AR was left dangling because a branch order was deleted outside the normal void cascade (e.g. via the Firestore console) | Admin only | `branch-sales-settle.actions.ts:459-533` [VERIFIED] | N/A — v1 repair tooling | — |
| Admin repair: missing salesDay mirror backfill | Recomputes and patches a date's Branch Sales channel total from the AR truth when a legitimately-recognized sale was never mirrored into that day's report (a since-fixed bug in an earlier save path) | Admin only | `branch-sales-settle.actions.ts:552-629` [VERIFIED] | N/A — v1 repair tooling | — |
| Commissary dashboard KPIs (bounded queries) | In-flight order counts by status, open-discrepancy total, and this-month's received total — computed via three targeted queries instead of an unbounded full-collection scan (an explicit prior-performance-bug fix) | Manager/admin | `src/lib/actions/commissary-dashboard.actions.ts:60-115` [VERIFIED] | NOT PLANNED (Phase 6 would be the natural home) | ADD |
| Branch-payment→commissary-AR mirror repair | Re-runs the cross-store mirror when a branch's supplier payment failed to post the matching commissary AR collection (no default collection account configured yet, or a transient error) — idempotent, skips already-mirrored payments | Admin/manager | `src/lib/actions/commissary-mirror.actions.ts:23-68` [VERIFIED] | Phase 2 (this specific mirror pattern is discussed as a Phase-2 simplification opportunity in `03-business-logic.md §8`, not the branch-order system as a whole) | ADD |
| Two-store order chat (append-only, mirrored) | A branch and its commissary can message each other on a specific order — mirrored into both stores' subcollections under the same doc id so each side reads its own copy, with unread-count badges. No edits, no deletes — the conversation is part of the order's audit trail | Any staff (both sides) | `src/lib/actions/branch-order-messages.actions.ts:34-135` [VERIFIED] | NOT PLANNED | ADD (lower priority — an operational convenience, not a financial/inventory correctness requirement) |

## J. Peripheral / adjacent

| Capability | What problem it solves | Who uses it | Where in v1 | In ERPv2 plan? | Verdict |
|---|---|---|---|---|---|
| Inventory department taxonomy | Names departments (kitchen/bar/etc.) that usage records attribute consumption to, each optionally linked to an expense category | Manager/admin | `src/lib/actions/inventory-department.actions.ts:8-83` [VERIFIED] | Phase 3 | CORRECT |

---

## Capabilities with no home in the plan

**Primary deliverable of this document.** Every row below is a real, live, actively-used capability in v1
with no named phase in `PROJECT_BIBLE.md §10`'s 8-phase table. Ordered by what breaks operationally if it
is simply never built.

### 1. The entire commissary ↔ branch order lifecycle (§I above, ~24 capabilities)

**What it is:** order → accept → prepare → dispatch → receive → settle, spanning two Firestore-store
scopes, with its own pricing engine, item-mapping layer, discrepancy resolution, variance-float
settlement, and cross-store messaging. This is how meat/stock physically gets from a commissary to every
branch and kiosk it supplies.

**Why it has no home:** Phase 3's bullet list — "Items, locations, stock ledger, receiving, transfers,
usage, wastage, counts, weighted-average valuation, COGS postings" — reads as *intra-store* inventory.
"Transfers" there is the room-to-room `stock-transfer.actions.ts` mechanic (§F), not this. Phase 2's
"payments... settlements" is aimed at channel (FoodPanda/Grab) settlement, not commissary↔branch AR/AP.
Nothing in the phase table names ordering, fulfilment, cross-store receipt posting, branch pricing, or
item mapping.

**What breaks if it's never built:** every store that isn't a standalone (i.e., every commissary and every
branch/kiosk it feeds) loses its restocking mechanism entirely. There is no other path in this codebase
for a branch to get stock from its commissary — deliveries from *external* suppliers are a separate flow.
Without this, branches physically cannot reorder meat or stock from their supplying commissary, and
commissaries have no record of what they've shipped or what's owed to them for it. This is not a
convenience feature; it is the backbone of the multi-store operating model Ian described ("we use it in
day-to-day operations").

**Recommendation for Ian:** this needs an explicit phase, most likely straddling Phase 2 (money-moving:
the AR/AP mirror) and Phase 3 (inventory: the stock movement), the way meat production straddles Phase 3
and Phase 5. Given it's the single largest subsystem in this whole domain read, it may warrant being named
as its own line in the phase table rather than folded silently into either.

### 2. Order-time / channel wastage settlement-matching (§H, the platform-payout-reconciliation piece)

**What it is:** cross-referencing open FoodPanda/Grab wastage records against a parsed settlement
upload, so the 15-day auto-charge backstop's default (charge someone regardless) can instead be informed
by whether the platform actually paid.

**Why it has no home:** it's genuinely a Phase-2 "settlements" capability (it reads and reasons about a
channel settlement file) wearing an inventory-domain ("wastage") label. The base wastage-type config,
dispute flow, and allocation mechanics could plausibly live under Phase 3's "wastage" bullet; this specific
piece cannot.

**What breaks if it's never built:** the 15-day backstop still functions (it has its own fallback chain),
but every overdue wastage gets charged blind — to whoever's parked, else the monitor, else the store —
with zero awareness of whether the platform already compensated the loss. Operationally this means staff
or the store absorb costs the platform may have already reimbursed, silently, on a 15-day clock.

### 3. Meat production / slicer payroll integration (§G)

**What it is:** the slicer-payment invariant library (`slicer-payment.ts`) and the monthly production
summary that feeds it — a genuine Phase-3×Phase-5 crossover, not purely inventory.

**Why it has no home:** Phase 3 doesn't name "production," and Phase 5 ("Payroll... salary advances")
doesn't name slicer pay or per-piece meat compensation as distinct from hourly/salaried payroll.

**What breaks if it's never built:** slicers (a real, paid staff role in this business) have no
compensation mechanism tied to their actual output. This is lower severity than #1 — it's one
compensation *stream*, not the whole restocking pipeline — but it is real payroll for real people that
currently has no planned home.

### 4. Kitchen production recipes / the "Cook" action (§G)

Distinct from meat slicing: a general ingredient→output conversion recipe used for prep. Same
"Phase 3 doesn't name production" gap as #3, lower severity since it reuses the existing usage-record
posting path rather than inventing new mechanics.

---

## Intent worth preserving

Business rules encoded in code that a schema-only rewrite would lose. Each earns its place here because
it traces to a specific incident, a tuned threshold, or a deliberate policy choice — not because it's
merely "how v1 happens to work."

- **Unit conversion is a closed, explicit table — never a guess.** `recipe-units.ts` converts g↔kg and
  ml↔ltr only. pcs↔pack, kg↔ltr, and anything needing a per-item factor (units-per-pack, density) is
  *refused*, not approximated — because a wrong guess silently deducts the wrong quantity forever. Preserve
  the refusal list as faithfully as the conversion table itself. [VERIFIED, `recipe-units.ts:53-56`]

- **"Park, don't guess" for undecided receiving lines.** An unallocated delivery line goes to a dedicated
  "Receiving" pseudo-location (surfaced as a pending-allocation nudge) rather than being silently defaulted
  into the default storage room — the old, worse behavior. Falls back to the default room only if no
  Receiving location exists, so stock is never lost either way. [VERIFIED, `delivery.actions.ts:507-522`,
  `receive-allocation.ts:14-22`]

- **A usage line labeled "transfer" is a landmine, not a category.** The usage flow only ever writes an
  OUT leg; a transfer needs two legs (source and destination). A reserved-key guard blocks anyone from
  recording a transfer as a usage category, because doing so silently destroys stock rather than moving
  it. [VERIFIED, `reserved-usage-categories.ts:1-28`]

- **Meat-product re-categorization is validated against every dependent, because it already went
  wrong once.** Re-pointing or de-slabbing a product with live sliced children is a HARD block, not a
  warning — traced directly to a named production incident (Lipa, "Beef Forequarter/regular") that
  silently orphaned 3 sliced products and corrupted 7 production records before anyone noticed.
  [VERIFIED, `meat-product-validate.ts:1-19,76-89`]

- **Meat "convert" is same-slab-only, by construction.** Re-cutting one sliced product into another is
  only meaningful within the same parent slab — enforced both client- and server-side, with zero GL or
  slicer-pay impact (it's a pure count move). [VERIFIED, `meat-convert.ts:1-43`]

- **The wastage-reason enum is closed, not free text.** Both meat and general wastage require a reason
  from the canonical `WASTAGE_REASONS` list before posting — so reports can aggregate spoilage/theft/etc.
  consistently across item kinds. A store cannot skip this even under threshold pressure (no threshold
  configured blocks the post entirely, before the reason check is even reached).
  [VERIFIED, `general-inventory.actions.ts:283-290`, `meat-usage.actions.ts:235-241`]

- **The order-time wastage 15-day backstop's preference order is a real accountability policy:** parked
  manager decision first, else the assigned monitor at 100%, else the store absorbs it net-zero and gets
  flagged. Applied uniformly to disputed and undisputed records alike — a disputed-but-never-resolved
  record does NOT get special treatment. [VERIFIED, `slicer... ` — see `wastage.actions.ts:1122-1136`]

- **"Max of last two receives" protects a commissary's pricing from a single cheap lot.** When refreshing
  a commissary item's cost basis from delivery history, the code takes the HIGHER of the two most recent
  receive costs — so a bulk cheap buy can't retroactively undercut an older, still-in-inventory expensive
  lot's price to branches. [VERIFIED, `commissary-item-config.actions.ts:461-465,634-638`]

- **Deferred cross-store posting to receipt time, using received (not dispatched) quantities.** The
  single biggest correctness decision in the commissary/branch system: post nothing to either store's
  books until the branch confirms what it actually received, and post BOTH sides at that same figure.
  This is a documented redesign away from an earlier dispatch-time-posting model that required
  retroactive AR correction whenever received ≠ dispatched. [VERIFIED,
  `branch-order-fulfilment.actions.ts:261-277`]

- **Cross-store unit mismatches skip the balance move, not the audit trail.** When a branch's mapped
  item uses a different base unit than what the commissary dispatched, the ledger entry is still written
  (flagged `unitMismatch: true`) but the balance is deliberately left untouched — corrupting a count by
  mixing units is treated as worse than a temporarily-incomplete one. [VERIFIED,
  `branch-order-receive.actions.ts:217-241`]

- **"Shipped" must mean reachable, not merely committed.** Both the count-session freeze (#7) and the
  supplier-return flow (#9) in `INVENTORY_GAPS.md` were marked "RESOLVED" as server code for **seven
  weeks** with zero UI callers — meaning the safety feature (count freeze) could never actually engage,
  and the audit-trail feature (supplier returns) could never actually be used, despite being "done." This
  isn't a business rule, but it's a process lesson worth carrying into v2's definition of done: a
  capability isn't complete until something reachable calls it. [VERIFIED, `docs/INVENTORY_GAPS.md:61-78,
  120-135`]

- **The tolerance constants are all independently tuned, not a shared epsilon.** ₱0.99 for reconciling a
  delivery-item cost against its linked expense (real supplier invoices carry centavo-rounding noise);
  1e-6 for base-unit quantity comparisons (float precision, not a business tolerance); 0.005 for count
  discrepancies. Preserve each value at its own call site — collapsing them to one shared constant would
  quietly change behavior at at least one of them. [VERIFIED: `delivery.actions.ts:972-977` (₱0.99),
  `stock-count.actions.ts:25` (1e-6), `branch-order-receive.actions.ts:121` (0.005)]

- **Item-master reorder fields vs. the live threshold system are two different things — don't merge
  them by assumption.** `items.reorderPoint/reorderQuantity/criticalPoint` are written by the item editor
  but read by nothing found in this codebase. The actual low-stock/auto-order trigger runs entirely on a
  separate `lowStockThreshold` field on the legacy `inventoryProducts`/`meatProducts` docs. A v2 rebuild
  that "obviously" ports the item-master fields as *the* reorder system would be porting the wrong one.
  [VERIFIED — see §A table row; confirmed by grep, no read/write call sites for the item-master fields
  outside the editor itself]
