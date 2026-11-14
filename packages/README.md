# Shared workspace packages

## Overview

Reusable primitives, data access, authentication, business rules, migration analysis and cloud adapters consumed by the applications.

## Interface

- [auth](./auth/README.md): Session/actor resolution, capability gates, role/grant administration, credential helpers and POS approval checks.
- [core](./core/README.md): Money, dates, logging, environment validation, image metadata stripping and text sanitization.
- [db](./db/README.md): Relational schema, lazy clients, repository SQL, reference-data seeds and hand-authored migration runner.
- [domain](./domain/README.md): The business-rules layer of Shareat System.
- [etl](./etl/README.md): Provider-neutral capture, conversion, landing and legacy comparison with pure audit/master-data/dual-run engines.
- [etl-firestore](./etl-firestore/README.md): Provider adapter for @shareat/etl: initialized ERP Firestore client, count-first plans and paged document reader.
- [storage-firebase](./storage-firebase/README.md): Firebase Admin implementation of the domain StorageDriver; the file broker owns authorization and file-purpose rules.
- [sync-firestore](./sync-firestore/README.md): Firebase Admin adapters for domain mirror publication, terminal identity and attendance inbox relay.

## Invariants

- Applications depend on packages; packages must not import application code.
- Package manifests define import boundaries. Provider SDKs belong in the cloud adapters; domain code depends on driver interfaces.
- PostgreSQL is authoritative for the rebuilt ERP; current Firebase bridges remain until their planned replacements land.

## Side Effects

- This grouping has no executable entry point. Child packages own PostgreSQL connections, authentication, file storage and Firestore transport.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
