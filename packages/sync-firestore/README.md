# Firestore synchronization transport

## Overview

Firebase Admin adapters for domain mirror publication, terminal identity and attendance inbox relay.

## Interface

- `@shareat/sync-firestore` exports: `.` → `./src/index.ts`.
- [src](./src/README.md): Implements domain MirrorDriver, TerminalIdentityDriver and InboxDriver using the Firebase Admin SDK.

## Invariants

- The domain owns sync decisions and paths; the adapter performs transport.
- Admin SDK access bypasses Firebase security rules, so retain explicit path/version checks.

## Side Effects

- Reads credentials, writes Firestore mirror/acknowledgement state and performs Firebase Auth terminal operations.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
