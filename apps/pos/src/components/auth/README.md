# src/components/auth contract

## Overview

First-login password-change guard.

## Interface

- [first-login-guard.tsx](./first-login-guard.tsx) — `FirstLoginGuard`.

## Invariants

- A forced-reset account is directed to change-password before guarded content.

## Side Effects

- Reads auth context and redirects client navigation when required.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (7097 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
