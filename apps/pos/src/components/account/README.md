# src/components/account contract

## Overview

Password-change dialog.

## Interface

- [ChangePasswordDialog.tsx](./ChangePasswordDialog.tsx) — `ChangePasswordDialog`.

## Invariants

- Receives provider availability and reset callbacks as props.

## Side Effects

- Invokes account security helpers/callbacks and updates dialog state.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (6598 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
