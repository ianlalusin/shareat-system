# Private Firebase file storage

## Overview

Firebase Admin implementation of the domain StorageDriver; the file broker owns authorization and file-purpose rules.

## Interface

- `@shareat/storage-firebase` exports: `.` → `./src/index.ts`.
- [src](./src/README.md): Implements the domain StorageDriver using Firebase Admin Storage, with configuration loading separated from bucket operations.

## Invariants

- Never expose a permanent public URL or make the bucket/object public.
- Provider SDK code stays here; business code depends on StorageDriver.

## Side Effects

- Reads configuration/key files and performs cloud object reads/writes/deletes and signed-URL generation.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
