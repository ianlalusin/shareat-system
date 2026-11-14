# Read-only Firestore capture

## Overview

Provider adapter for @shareat/etl: initialized ERP Firestore client, count-first plans and paged document reader.

## Interface

- `@shareat/etl-firestore` exports: `.` → `./src/index.ts`, `./client` → `./src/client.ts`, `./reader` → `./src/reader.ts`, `./plan` → `./src/plan.ts`.
- [src](./src/README.md): ERP Firestore client initialization, paged source reader and count-first capture-plan execution.

## Invariants

- Keep source reads structurally separate from writes; fetch only through the explicit fetch option.
- Use capture credentials and the required source-project identity.

## Side Effects

- Reads credentials and contacts source Firestore for counts and documents; does not mutate source Firestore.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
