# scripts/lib contract

## Overview

Pure statutory logbook receipt projection and spreadsheet-safe rendering.

## Interface

- [statutory-logbook.mjs](./statutory-logbook.mjs) — `statutoryLogbookRows`, `renderStatutoryLogbook`.

## Invariants

- Full diner identities are emitted only for the requested logbook projection.
- Formula-looking spreadsheet text is rendered as literal data.

## Side Effects

- Returns rows/rendered export content; no direct credential reads, network calls or database writes.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (2607 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
