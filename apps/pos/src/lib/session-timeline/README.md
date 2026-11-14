# src/lib/session-timeline contract

## Overview

Collects local actor names and resolves staff UIDs for readable timeline attribution.

## Interface

- [actors.ts](./actors.ts) — `ActorNameMap`, `ActorLabel`, `collectLocalActorNames`, `resolveStaffNames`, `shortUid`, `actorLabel`, `collectActorUids`.

## Invariants

- Only nonempty string IDs and names are added to the local name map.
- UID fallback formatting is separate from known human names.

## Side Effects

- Fetches missing staff names through the SDK and returns actor-name maps for timeline consumers.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (6580 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
