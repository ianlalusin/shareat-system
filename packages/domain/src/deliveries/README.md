# Deliveries
## Overview
The delivery document and its receiving engine (T-166). A delivery is drafted with lines and a proof photo, then received: counted quantities become stock movements, FIFO cost layers and one journal entry, atomically. It also owns the advisory duplicate-delivery warnings.

## Interface
- `documents.ts`: `CreateDeliveryLineInput`, `CreateDeliveryInput`, `CreateDeliveryResult`, `createDeliveryDocument`, `ReceiveDeliveryLineInput`, `ReceiveDeliveryDocumentInput`, `receiveDeliveryDocument`.
- `receive.ts`: `ReceiveLineInput`, `ReceiveDeliveryInput`, `ReceiveResult`, `ReceiveOutcome`, `receiveDelivery`, `toBaseUnits`, `perBaseUnit`.
- `duplicate-risk.ts`: `DuplicateRiskInput`, `DuplicateWarning` (codes `same_reference`, `same_item_same_day`, `overstock`), `duplicateRisk`.

## Invariants
- Two acts: `createDeliveryDocument` writes a DRAFT (nothing moves or posts); `receiveDeliveryDocument` is the event. Only a `draft` delivery can be received.
- `receiveDelivery` is all-or-none: every precondition (closed period, no lines, no parking location, unmapped item kind) is checked BEFORE the first write and returns `{ ok: false, reason, userReason }` instead of throwing. `tx` is required and always joins the caller's transaction.
- A line with no location parks in the store's Receiving room, else default, else any active room; never dropped or guessed.
- `receiveDeliveryDocument` marks the delivery `received` FIRST, then writes line receipt fields, because trigger `delivery_lines_shortage_explained_trg` validates only when status is `received`.
- `authorize()` comes first: `receive_delivery` at the store; `allow_over_receipt` whenever a line asks for over-receipt (the trigger cannot know who may set the flag).
- Proof photo must exist in the org (`filesRepo.getById`), not merely be a non-null id. Kind is `supplier` or `purchase` (commissary deliveries come from the cross-store receipt). A supplier delivery needs a supplier and at least one line.
- Non-commissary lines naming a non-active item are refused on receive.
- `duplicateRisk` WARNS, never blocks (a hard duplicate, same supplier plus reference, is a database unique index). Overstock means incoming at least doubles on-hand (`OVERSTOCK_MULTIPLIER = 2`).
- Quantities use the `stock/quantity` brand; costs are four-decimal per base unit. Void and invoice-link wiring are NOT built here.
- Duplicate window: deliveries in the last 30 days (`DUPLICATE_RISK_WINDOW_DAYS`).

## Side Effects
- `createDeliveryDocument`: inserts delivery header and lines via `deliveriesRepo`; reads files, items and stock ledger.
- `receiveDeliveryDocument`: marks received (`new Date()` for `receivedAt`), writes line receipt fields, then calls `receiveDelivery`.
- `receiveDelivery`: writes stock movements (`stockLedgerRepo`), FIFO layers (`stockLayersRepo`) and one journal entry (`postReceiptValue`, Dr 1310/1320/1330 Cr 2120); timestamps are derived from `deliveredOn`.
- `duplicate-risk.ts`: None (pure functions; no database, no clock).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
