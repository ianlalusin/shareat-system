# public contract

## Overview

Service worker lifecycle and request/background-sync event hooks.

## Interface

- [sw.js](./sw.js) — install, activate, fetch and sync event handlers.

## Invariants

- The fetch handler deliberately leaves caching to the Firebase SDK.
- Service-worker behavior applies to browser builds; the provider skips native registration.

## Side Effects

- Registers worker lifecycle/fetch/sync handlers; may notify client pages during background-sync events.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (1384 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
