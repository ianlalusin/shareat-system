# src/lib/logs contract

## Overview

Maps activity-log actions, amounts and metadata to readable timeline text.

## Interface

- [describe-log.ts](./describe-log.ts) — `TimelineEventType`, `DescribedLog`, `actionLabel`, `logAmount`, `describeActivityLog`.

## Invariants

- Amount extraction accepts finite recorded deltas.
- Shared descriptions keep timeline consumers on one formatting boundary.

## Side Effects

- Returns descriptions only; the inspected module does not write logs.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (13405 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
