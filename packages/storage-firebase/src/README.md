# Firebase private storage adapter

## Overview

Implements the domain StorageDriver using Firebase Admin Storage, with configuration loading separated from bucket operations.

## Interface

- [index.ts](./index.ts): includes `FirebaseDriverConfig`, `FileReader`, `firebaseConfigFromEnv`, `firebaseStorageDriver`.

## Invariants

- Use the private bucket and never call makePublic or introduce a permanent public URL. Authorization and purpose rules are enforced by the domain file broker before driver calls.
- Resolve exactly one supported service-account configuration; errors must not echo credential JSON.
- Only this adapter owns Firebase Storage transport; domain code consumes the StorageDriver interface.

## Side Effects

- Loads credential text or the configured key file, initializes/reuses an Admin app and contacts cloud storage.
- Driver operations upload/download/delete bytes and create expiring signed read URLs.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
