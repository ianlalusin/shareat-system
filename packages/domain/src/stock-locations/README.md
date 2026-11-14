# Stock Locations
## Overview
The room model for a store's stock (T-160): the location-type catalogue, per-store locations with a role and purpose, default/receiving rules, and admin writes. `rules.ts` holds pure decisions the database cannot make; `service.ts` holds the store-scoped admin writes.

## Interface
- `rules.ts` (pure): `resolveReceivingLocation`, `assertUsageSource`, `normaliseRole`, `defaultsToClear`, `singleRoomViolation`, types `StockModel`, `LocationLike`, `RuleResult`.
- `service.ts`: `ensureLocationTypes`, `seedStoreLocations`, `createLocation`, `updateLocation`, `setDefaultLocation`, `deactivateLocation`, `reactivateLocation`, types `EnsureLocationTypesInput`, `SeedStoreLocationsInput`, `SeedStoreLocationsResult`, `CreateLocationInput`, `UpdateLocationInput`.

## Invariants
- The database enforces the rules (for example one Receiving room via a partial unique index); `rules.ts` only answers "why not?" in a sentence and decides what constraints cannot (receive fallback, unknown legacy role).
- Every mutation authorizes `manage_locations` first, at the row's own store (rows are loaded first for update/default/deactivate/reactivate), never a store the caller merely claims.
- Business refusals in `service.ts` throw; they do not return `{ ok: false }`. The actions layer translates the error.
- `rules.ts` functions return `RuleResult`/values and never throw or touch the database.

## Side Effects
- `service.ts` writes `stock_locations` and location-type rows via the repo in the caller's `Tx`.
- `rules.ts`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
