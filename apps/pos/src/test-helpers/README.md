# src/test-helpers contract

## Overview

POS test adapters and fixture builders for fake clocks, Firestore, IndexedDB, POS2 handlers and outbox scenarios.

## Interface

- [fakeClock.ts](./fakeClock.ts) — `FakeClock`, `installFakeClock`.
- [fakeFirestore.ts](./fakeFirestore.ts) — `FakeTimestamp`, `DocRef`, `CollRef`, `QueryRef`, `DocSnap`, `QuerySnap`, `CommitRecord`, `FakeFirestore`.
- [fakeIdb.ts](./fakeIdb.ts) — `FakeIdbFactory`.
- [outbox.ts](./outbox.ts) — `TS`, `STORE`, `SaleSpec`, `LINES`, `saleOps`, `voidOps`, `seedServerSession`, `settle`, `fakeLocks`.
- [pos2.ts](./pos2.ts) — `STORE`, `OTHER_STORE`, `DEVICE`, `PIN_OK`, `PIN_BAD`, `MANAGER_PERSON`, `NOW`, `T_SALE`, `SAME_DAY`, `SHIFT_OPENED`, `Calls`, `TestDeps`, `makeDeps`, `post` (additional exports in source).

## Invariants

- These are test adapters, not production persistence or a PostgreSQL integration substitute.
- The clock fake changes Date only so IndexedDB/Firestore scheduling remains real.
- Firestore/IndexedDB fakes enforce atomic commit/abort behavior used by offline tests.

## Side Effects

- Installs test clock/global adapters and mutates isolated in-memory stores; test builders return synthetic fixtures.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 5 direct source files (49897 UTF-8 bytes), at most 300 lines per file. The 50,000-byte directory budget left these files outside the scan: `posFixtures.ts`, `statutoryOracle.ts`, `taxT423Frozen.ts`. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
