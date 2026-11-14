# src/components/session contract

## Overview

Session timeline drawer.

## Interface

- [session-timeline-drawer.tsx](./session-timeline-drawer.tsx) — `SessionTimelineDrawer`.

## Invariants

- Actor display combines event-carried names with resolved staff names.
- The selected store/session identifies the live timeline.

## Side Effects

- Subscribes to session/activity records and fetches related metadata while the drawer is open.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (13106 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
