# src/components/kitchen/history contract

## Overview

Kitchen ticket-history client with filters and paging.

## Interface

- [HistoryPageClient.tsx](./HistoryPageClient.tsx) — `HistoryPageClient`.

## Invariants

- History state belongs to the active store and selected query range.

## Side Effects

- Reads/subscribes to Firestore ticket/session/staff metadata and updates local filters.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (10792 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
