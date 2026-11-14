# src/app/forgot-password contract

## Overview

Email password-reset request screen.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/forgot-password`; `ForgotPasswordPage`.

## Invariants

- Success switches to the check-email state.

## Side Effects

- Sends a Firebase password-reset email; the return action navigates to login.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (3628 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
