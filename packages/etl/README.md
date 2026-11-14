# Migration and reconciliation toolkit

## Overview

Provider-neutral capture, conversion, landing and legacy comparison with pure audit/master-data/dual-run engines.

## Interface

- `@shareat/etl` exports: `.` → `./src/index.ts`, `./taxonomy` → `./src/taxonomy.ts`, `./pseudonymise` → `./src/pseudonymise.ts`, `./capture` → `./src/capture.ts`, `./convert` → `./src/convert.ts`, `./report` → `./src/report.ts`, `./source-reader` → `./src/source-reader.ts`, `./reconcile` → `./src/reconcile.ts`, `./run` → `./src/run.ts`.
- [src](./src/README.md): Legacy taxonomy, capture, conversion and reconciliation APIs, with balance audit, master-data planning and dual-run engines.

## Invariants

- No firebase-admin dependency; inject readers or use the distinct etl-firestore adapter.
- Legacy data is read-only input. Live corrections and postings use the owning rebuilt domain path.

## Side Effects

- Pure analysis is local computation; orchestrators may read source adapters and write PostgreSQL landing/reconciliation records.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
