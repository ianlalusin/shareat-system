# src/lib/chat contract

## Overview

Module-level tracker for the last local profile whose chat presence this tab logged.

## Interface

- [chatPresenceTracker.ts](./chatPresenceTracker.ts) — `TrackedChatProfile`, `getLastLoggedProfile`, `setLastLoggedProfile`, `__resetChatPresenceTracker`.

## Invariants

- Tracking is per store and survives component remounts within the tab.
- The reset export clears this module state.

## Side Effects

- Mutates an in-memory map; it does not itself write chat documents.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (1887 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
