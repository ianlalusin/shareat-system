# src/components/global contract

## Overview

Promise-based confirmation dialog hook.

## Interface

- [confirm-dialog.tsx](./confirm-dialog.tsx) — `useConfirmDialog`.

## Invariants

- A pending resolver settles once; dismissal resolves false if still pending.

## Side Effects

- Mounts dialog state and schedules Radix overlay cleanup.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (2562 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
