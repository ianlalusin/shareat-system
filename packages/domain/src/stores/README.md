# Stores
## Overview
Store creation and management (T-222): creating a store as one transaction (the store plus its auto-seeded half), editing details, opening date, stock model and wastage monitor, deactivating/reactivating, and a derived readiness checklist for the manual half of setup (bank, sales channels).

## Interface
- `service.ts`: `createStore`, `updateStoreDetails`, `setStoreOpeningDate`, `setStoreStockModel`, `setWastageMonitor`, `wastageMonitorOf`, `ownerlessTrackedWastages`, `deactivateStore`, `reactivateStore`, `storeReadiness`, `READINESS_REMEDY_ROUTE`, types `CreateStoreInput`, `CreateStoreResult`, `ReadinessRemedy`, `ReadinessCheck`.

## Invariants
- Creating a store is a transaction: the whole auto half commits or none of it does (no half-provisioned store). Only the genuinely manual half remains a checklist, and that checklist is DERIVED.
- Readiness is derived per request, never stored or cached; each check carries a remedy link built beside its predicate.
- The access fan-out must precede creating the room: `createLocation`'s `authorize` needs a `person_store_scope` row for the new store, so the creator cannot reuse it before the fan-out runs.
- Admin store writes authorize `manage_stores` (module constant `CAPABILITY`); the wastage-monitor setting uses `manage_store_settings`.
- Typed fields (for example `unremitted_ceiling`) are parsed after `authorize()` and before anything is written.
- `normaliseBranchCode` comes from `organizations/identifiers.ts` to avoid the old import cycle.

## Side Effects
- Writes the store row and its seeds (attendance config, position access defaults, admin store-scope fan-out via `accessRepo.grantStoreScope`, location types and the default room) via repos in the caller's `Tx`.
- No ledger posting.
- Functions take the caller's `Tx`; none opens its own transaction.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
