# src/components/pos2 contract

## Overview

Six-digit manager approval PIN pad.

## Interface

- [PinPad.tsx](./PinPad.tsx) — `PIN_LENGTH`, `PinPad`.

## Invariants

- Input length is fixed to PIN_LENGTH = 6.
- The pad receives value/change/disabled props; it does not validate manager authority itself.

## Side Effects

- Emits controlled input callbacks; no direct auth or database call.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (1876 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
