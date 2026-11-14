# src/lib/ui contract

## Overview

Removes orphaned Radix overlay portals and stuck interaction locks.

## Interface

- [cleanup-radix.ts](./cleanup-radix.ts) — `cleanupRadixOverlays`.

## Invariants

- Cleanup targets overlay/lock artifacts; it is called after dialog resolution.

## Side Effects

- Removes DOM elements and clears body interaction lock styling/attributes.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (553 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
