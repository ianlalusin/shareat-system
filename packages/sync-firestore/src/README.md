# Firestore mirror and terminal adapters

## Overview

Implements domain MirrorDriver, TerminalIdentityDriver and InboxDriver using the Firebase Admin SDK.

## Interface

- [index.ts](./index.ts): includes `createFirestoreMirrorDriver`, `createFirestoreTerminalDriver`, `createFirestoreInboxDriver`.

## Invariants

- Admin SDK calls bypass security rules; restrict writes to the paths supplied by the domain driver contracts.
- Mirror writes preserve source-version ordering and deletion markers; do not turn this transport into an alternative source of business truth.
- Credential loading rejects simultaneous inline and file configuration and does not echo secret JSON on parse errors.

## Side Effects

- Loads credentials, initializes/reuses an Admin app, writes Firestore mirror documents transactionally and updates inbox acknowledgements.
- Terminal identity operations call Firebase Auth. Remote I/O happens when the driver methods run, rather than merely importing their factories.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
