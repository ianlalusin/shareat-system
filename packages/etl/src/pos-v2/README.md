# POS v2 setup load

## Overview

The one-time load of a store's stands and discount presets from POS v1 (T-533 S2), plus a report of setup gaps. The v1 source is an interface, so tests use a fake.

## Interface

- [load-store-setup.ts](./load-store-setup.ts): includes `V1Table`, `V1Discount`, `V1StoreSetupSource`, `StoreSetupReport`, `loadStoreSetup`, `formatStoreSetupReport`.

## Invariants

- Writes only through the audited domain upserts (`upsertPosStand`, `upsertPosDiscountPreset`) as the load's own actor; never writes to v1.
- Idempotent: a second run changes nothing. A dry run runs the same path in a rolled-back savepoint.
- Reports gaps (tenders without alias, items without station, packages without refills, staff without PIN) and never fixes them. Reports carry counts and names, never a Firestore id.

## Side Effects

- Database writes on a real run. `scripts/pos-load-setup.ts` builds the real v1 reader (`PosStoreSetupFirestoreSource`, read-only).

## Verification

- `npm run typecheck`; `npx vitest run --project integration packages/etl/tests/integration/t533-s2-load-store-setup.test.ts` on a `_test` database.
