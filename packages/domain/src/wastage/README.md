# Wastage (order/channel)
## Overview
Order and channel wastage (T-178): a refunded or remade channel ORDER (for example a Foodpanda refund), and who bears the cost. This is NOT stock wastage (T-168): nothing here writes stock movements or consumes layers. `orders.ts` records, disputes, resolves and backstops; `settlement-match.ts` proposes matches against channel settlements.

## Interface
- `orders.ts`: `WASTAGE_ABSORBED_ACCOUNT` (5300), `WASTAGE_STAFF_CHARGE_ACCOUNT` (1230), `BACKSTOP_DAYS` (15), `AUTO_CHARGE_REVERSAL_DAYS` (30), `isPhase5StaffAdvancesAvailable`, `__setPhase5AvailableForTests`, `recordOrderWastage`, `disputeOrderWastage`, `resolveOrderWastage`, `reverseAutoCharge`, `runOrderWastageBackstop`, types `AllocationInput`, `RecordOrderWastageInput`, `RecordOrderWastageResult`, `DisputeOrderWastageInput`, `ResolveOrderWastageInput`, `ResolveOrderWastageResult`, `ReverseAutoChargeInput`, `BackstopOutcome`, `BackstopResult`.
- `settlement-match.ts` (pure): `matchWastagesToSettlement`, types `SettleableOrderWastage`, `SettlementMatchCandidate`.

## Invariants
- Never touch `stock_layers` or `stock_movements` here; doing so conflates two unrelated "wastage" systems.
- Account `1220` (channel receivable) is the credit in every disposition that posts. `platform_paid` posts nothing, because the channel settlement already clears `1220`.
- `charged` (including a multi-person split) is refused while `isPhase5StaffAdvancesAvailable()` is false; the backstop then degrades a charge to store-absorbed and records that on the entry memo. It is a policy gate, not a missing capability.
- The backstop acts after `BACKSTOP_DAYS`; an auto-charge can be reversed only within `AUTO_CHARGE_REVERSAL_DAYS`.
- `matchWastagesToSettlement` is pure (no `Tx`), matches at channel-day granularity on `channelId` and business date (not by name), and only PROPOSES; a manager disposes via `resolveOrderWastage`.
- The settlement shape (`PostedSettlementSummary`) is imported from `channel-settlements`, never redeclared (a duplicate collided in the package barrel).

## Side Effects
- Writes order-wastage rows and allocations; posts and reverses journal entries (`postEntry`/`reverseEntry`).
- Opens a transaction via `transaction(...)` when `tx` is `null`.
- Reads the clock (`Date.now()`/`options.now`) for ageing and the backstop cutoff.
- Authorizes `record_order_wastage`, `resolve_order_wastage`, `charge_staff_for_wastage`, `reverse_auto_charge`.
- `settlement-match.ts`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
