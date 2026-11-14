# src/app/kitchen contract

## Overview

Live station-based kitchen display.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/kitchen`; `KitchenStation`, `KitchenPage`.
- [history](./history/README.md) — Client-loaded kitchen history route.

## Invariants

- Active stations, tickets and session/flavor metadata are read for the active store.

## Side Effects

- Creates Firestore subscriptions, clock/audio-unlock listeners and kitchen state; status operations use SDK writers.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (13327 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
