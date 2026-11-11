# src/app/change-password contract

## Overview

Forced password-change form after an administrator reset.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/change-password`; `ChangePasswordPage`.

## Invariants

- New and confirmed passwords must match and differ from the temporary password.

## Side Effects

- Reauthenticates/changes the Firebase password, POSTs password-changed confirmation and navigates to the role home.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (9036 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
