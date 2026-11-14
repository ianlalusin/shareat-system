# src/components/dashboard contract

## Overview

Floating entry point for weather logging.

## Interface

- [WeatherLogFloatingButton.tsx](./WeatherLogFloatingButton.tsx) — `WeatherLogFloatingButton`.

## Invariants

- Weather state uses a one-time read on mount/open instead of a permanent listener.

## Side Effects

- Reads weather state and opens WeatherLoggerModal for the supplied store.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (7164 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
