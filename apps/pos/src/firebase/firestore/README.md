# src/firebase/firestore contract

## Overview

React hooks wrapping document and collection snapshots with loading/error state and document IDs.

## Interface

- [use-collection.tsx](./use-collection.tsx) — `WithId`, `UseCollectionResult`, `InternalQuery`, `useCollection`.
- [use-doc.tsx](./use-doc.tsx) — `UseDocResult`, `useDoc`.

## Invariants

- Null references do not start a subscription.
- Subscriptions return their unsubscribe cleanup; query/doc errors become hook state.

## Side Effects

- Creates live Firestore snapshot listeners and updates React state until cleanup.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (6780 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
