# POS v2 setup load

## Overview

The one-time load of a store's setup from POS v1: stands and discount presets (T-533 S2) and, since T-626, the menu and kitchen (packages with lunch and dinner prices, refills, flavours, add-on dishes, kitchen stations and routes, hours, payment methods), plus a report of setup gaps and a read-only parity check. The v1 source is an interface, so tests use a fake.

## Interface

- [load-store-setup.ts](./load-store-setup.ts): includes `V1Table`, `V1Discount`, `V1StoreSetupSource`, `StoreSetupReport`, `loadStoreSetup`, `formatStoreSetupReport`. Its header holds the v1 -> v2 mapping table.
- [plan-store-menu.ts](./plan-store-menu.ts): `planStoreMenu(V1MenuSetup)`, pure: what v1 says the store sells, as what v2 should hold (LT-/DT- copies paired, one price twice = one all-day price).
- [load-store-menu.ts](./load-store-menu.ts): `applyMenuPlan`, writes a plan through the audited domain functions; `formatMenuSetupReport`.
- [check-store-setup.ts](./check-store-setup.ts): `checkStoreSetup`, `formatStoreSetupCheck`: v1 against v2, then against the menu the tablet is served.

## Invariants

- Writes only through the audited domain functions (stand, preset, menu, option, daypart, price, kitchen, tender) as the load's own actor; never writes to v1.
- Idempotent: a second run changes nothing. A dry run runs the same path in a rolled-back savepoint.
- Never overwrites a value someone set in the ERP: a different price, station, hours or payment alias is listed as a difference.
- Reports gaps (tenders without alias, items without station, packages without refills, staff without PIN) and never fixes them. Reports carry counts and names, never a Firestore id.
- The parity check writes nothing and exits 1 on any gap or difference.

## Side Effects

- Database writes on a real load. `scripts/pos-load-setup.ts` and `scripts/pos-setup-check.ts` build the real v1 reader (`PosStoreSetupFirestoreSource`, read-only).

## Verification

- `npx vitest run --project unit packages/etl/tests/t626-plan-store-menu.test.ts`
- `npx vitest run --project integration packages/etl/tests/integration/t533-s2-load-store-setup.test.ts packages/etl/tests/integration/t626-lipa-menu-load.test.ts` on a `_test` database.
