# config contract

## Overview

Explicit local-only Firebase emulator profile.

## Interface

- [emulator-profile.mjs](./emulator-profile.mjs) — `emulatorProfile`.

## Invariants

- The demo profile fixes the project and endpoints; it accepts no selectable cloud project or remote host.

## Side Effects

- Returns emulator build/runtime settings; no network operations occur in this helper.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (612 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
