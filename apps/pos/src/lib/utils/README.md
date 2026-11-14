# src/lib/utils contract

## Overview

Timestamp conversion, local date formatting, menu-schedule applicability and session labels.

## Interface

- [date.ts](./date.ts) — `toJsDate`, `startOfDay`, `endOfDay`, `isSameDay`, `fmtDate`, `formatDuration`, `formatDurationHuman`, `formatDurationVerbose`.
- [isScheduleActiveNow.ts](./isScheduleActiveNow.ts) — `isScheduleActiveNow`.
- [session.ts](./session.ts) — `computeSessionLabel`.

## Invariants

- Date conversion accepts Firestore-like timestamps and ordinary Date/string/number inputs.
- Session labels prefer a supplied table display name before numeric table fallback.

## Side Effects

- Returns converted/formatted values without persistence calls.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 3 direct source files (5894 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
